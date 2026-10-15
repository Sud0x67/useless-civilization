import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/app.mjs';
import { applyEvent, createWorld } from '../src/world/engine.ts';
import { round, decision } from './fixture.ts';
const owned = [];
const directories = [];
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  owned.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const config = {
  model: 'test-model',
  apiKey: 'test-secret-do-not-leak',
  wireApi: 'responses',
  timeoutMs: 500,
};
async function setup(
  reply = {
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(round) }] }],
    usage: { input_tokens: 70, output_tokens: 50 },
  },
) {
  let received;
  const upstream = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks)),
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  const base = await listen(createHandler({ config: { ...config, baseUrl: upstream + '/v1' } }));
  return { base, received: () => received };
}
const post = (base, data = { world: createWorld() }, options = {}) =>
  fetch(base + '/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    ...options,
  });
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('model proxy', () => {
  it('uses Responses, Bearer authorization, no storage and no reasoning', async () => {
    const { base, received } = await setup();
    const response = await post(base);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.round.decisions).toHaveLength(6);
    expect(result.usage).toEqual({ input: 70, output: 50 });
    expect(received().url).toBe('/v1/responses');
    expect(received().auth).toBe('Bearer ' + config.apiKey);
    expect(received().body).toMatchObject({
      model: 'test-model',
      store: false,
      reasoning: { effort: 'none' },
    });
    expect(received().body.input[1].content).toContain('personality');
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    const status = await (await fetch(base + '/api/status')).json();
    expect(status).toEqual({ configured: true, model: 'test-model', wireApi: 'responses' });
  });
  it('supports single resident replies', async () => {
    const { base } = await setup({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
    });
    const response = await fetch(base + '/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world: createWorld(), agentId: 'mira', prompt: '你好' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).decision.speech).toBe(decision.speech);
  });
  it('only sends rules for currently active events', async () => {
    const { base, received } = await setup();
    await post(base);
    expect(JSON.parse(received().body.input[1].content).world.activeEvents).toEqual([]);
    expect(received().body.input[0].content).not.toContain('禁止开会');
    await post(base, { world: applyEvent(createWorld(), 'rain') });
    const active = JSON.parse(received().body.input[1].content).world.activeEvents;
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: 'rain', remainingMinutes: 180 });
    expect(active[0].rule).toContain('星星雨');
    expect(active[0].rule).not.toContain('禁止开会');
  });
  it('validates parameters and disallows cross-site requests before calling the provider', async () => {
    const { base, received } = await setup();
    expect((await post(base, { world: {} })).status).toBe(400);
    expect(
      (
        await post(base, undefined, {
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(base, undefined, { headers: { 'Content-Type': 'text/plain' } })).status,
    ).toBe(415);
    expect((await post(base, undefined, { body: 'not-json' })).status).toBe(400);
    expect((await post(base, undefined, { body: ' '.repeat(270000) })).status).toBe(413);
    expect(received()).toBeUndefined();
  });
  it('exposes configuration status without credentials and never falls back to dialogue', async () => {
    const base = await listen(createHandler());
    expect((await post(base)).status).toBe(503);
    expect(await (await fetch(base + '/api/status')).json()).toMatchObject({
      configured: false,
      model: null,
    });
  });
  it.each([
    { output: [{ content: [{ type: 'output_text', text: 'not JSON' }] }] },
    { output: [{ content: [{ type: 'output_text', text: '{"decisions":[]}' }] }] },
    { status: 'incomplete', output: [] },
    { output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: config.apiKey }] }] },
  ])('rejects unusable model output without leaking it', async (payload) => {
    const { base } = await setup(payload);
    const response = await post(base);
    const result = await response.text();
    expect(response.status).toBe(502);
    expect(result).not.toContain(config.apiKey);
    expect(result).not.toContain('"round"');
  });
  it('sanitizes upstream errors and timeout errors', async () => {
    const upstream = await listen((req, res) => {
      res.writeHead(401);
      res.end(config.apiKey);
    });
    const base = await listen(createHandler({ config: { ...config, baseUrl: upstream } }));
    const result = await post(base);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain(config.apiKey);
    const slow = await listen(() => {});
    const timeoutBase = await listen(
      createHandler({ config: { ...config, baseUrl: slow, timeoutMs: 30 } }),
    );
    const timed = await post(timeoutBase);
    expect(timed.status).toBe(502);
    expect(await timed.text()).toContain('超时');
  });
  it('limits upstream requests', async () => {
    const { base } = await setup();
    for (let i = 0; i < 12; i++) expect((await post(base)).status).toBe(200);
    expect((await post(base)).status).toBe(429);
  });
  it('does not serve dotenv or source in production', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'civilization-static-'));
    directories.push(directory);
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Test town</title>');
    await writeFile(join(directory, '.env'), config.apiKey);
    const base = await listen(createHandler({ production: true, staticDir: directory }));
    for (const path of ['/.env', '/server/model.mjs', '/src/App.tsx', '/assets/missing.js'])
      expect((await fetch(base + path)).status).toBe(404);
    expect((await fetch(base + '/')).status).toBe(200);
  });
});
