import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { round } from './fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestModel, ModelError, validationDetails } from '../server/model.mjs';
import { SharedTown } from '../server/town.mjs';
import { createWorld } from '../src/world/engine.ts';
const config = { baseUrl: 'http://mock', model: 'mock', apiKey: 'private-key-never-record' };
const towns = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const town of towns.splice(0)) town.close();
});
describe('safe model failure diagnostics', () => {
  it.each([
    [{ output_text: 'private body: not json' }, 'invalid_json'],
    [{ output_text: '{"decisions":[]}' }, 'invalid_fields'],
    [{ status: 'incomplete' }, 'incomplete'],
    [{ choices: [{ finish_reason: 'length' }] }, 'incomplete'],
    [{ output: [] }, 'missing_content'],
  ])(
    'categorizes unusable responses and preserves returned usage without leaking source text',
    async (payload, code) => {
      vi.stubGlobal('fetch', async () =>
        Response.json({ ...payload, usage: { input_tokens: 12, output_tokens: 8 } }),
      );
      let error;
      try {
        await requestModel(config, { world: createWorld(), round: true });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ModelError);
      expect(error.diagnostic.code).toBe(code);
      expect(error.usage).toEqual({ input: 12, output: 8 });
      expect(JSON.stringify(error)).not.toContain('private body');
      expect(JSON.stringify(error)).not.toContain(config.apiKey);
    },
  );
  it('records the failed call and tokens using diagnostic codes, without storing model bodies', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        output_text: 'a private sentence, not JSON',
        usage: { input_tokens: 123, output_tokens: 45 },
      }),
    );
    const town = new SharedTown({ path: ':memory:', config, clock: false, council: false });
    towns.push(town);
    await town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
    expect(town.autoError).toBe('回应格式有误，请重试。');
    expect(town.store.db.prepare('SELECT input,output FROM calls').get()).toMatchObject({
      input: 123,
      output: 45,
    });
    const rows = town.store.db.prepare('SELECT * FROM model_failures').all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].diagnostic)).toEqual({ code: 'invalid_json' });
    expect(JSON.stringify(rows)).not.toContain('private sentence');
    expect(JSON.stringify(rows)).not.toContain(config.apiKey);
    expect(town.world.tick).toBe(0);
  });
  it("accepts null optional fields from the provider without losing the other residents' real ballots", async () => {
    const motionId = '11111111-1111-4111-8111-111111111111';
    const value = {
      councilProposal: null,
      decisions: round.decisions.map((row, n) => ({
        ...row,
        intent: null,
        councilVote: n === 0 ? null : { motionId, choice: n < 3 ? 'yes' : 'no' },
      })),
    };
    for (const wireApi of ['responses', 'chat']) {
      vi.stubGlobal('fetch', async () =>
        Response.json(
          wireApi === 'responses'
            ? { output_text: JSON.stringify(value) }
            : { choices: [{ message: { content: JSON.stringify(value) } }] },
        ),
      );
      const result = await requestModel(
        { ...config, wireApi },
        { world: createWorld(), round: true },
      );
      expect(result.round.decisions).toHaveLength(6);
      expect(result.round.decisions[0].councilVote).toBeUndefined();
      expect(result.round.councilProposal).toBeUndefined();
      expect(result.round.decisions.slice(1).map((row) => row.councilVote)).toEqual(
        value.decisions.slice(1).map((row) => row.councilVote),
      );
      expect(result.round.decisions.map((row) => row.speech)).toEqual(
        round.decisions.map((row) => row.speech),
      );
    }
  });
  it.each([false, 'yes', {}, { choice: 'yes' }])(
    'continues rejecting nonempty malformed votes: %j',
    async (councilVote) => {
      const value = {
        decisions: round.decisions.map((row, n) => (n === 0 ? { ...row, councilVote } : row)),
      };
      vi.stubGlobal('fetch', async () => Response.json({ output_text: JSON.stringify(value) }));
      await expect(
        requestModel(config, { world: createWorld(), round: true }),
      ).rejects.toMatchObject({ diagnostic: { code: 'invalid_fields' } });
    },
  );
  it('lets a visitor retry a failed automatic round once, without injecting an event or bypassing quotas', async () => {
    const visitor = { owner: 'visitor', ip: 'network' };
    const model = vi
      .fn()
      .mockRejectedValueOnce(new ModelError('回应格式有误，请重试。', 'invalid_fields'))
      .mockResolvedValue({ round, usage: { input: 3, output: 4 } });
    const town = new SharedTown({ path: ':memory:', config, clock: false, council: false, model });
    towns.push(town);
    expect(() =>
      town.accept(visitor, { requestId: randomUUID(), action: { type: 'round' } }),
    ).toThrow(/没有需要重试/);
    await town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
    const request = { requestId: randomUUID(), action: { type: 'round' } };
    const accepted = town.accept(visitor, request);
    await new Promise((done) => setImmediate(done));
    expect(town.accept(visitor, request).id).toBe(accepted.id);
    expect(model).toHaveBeenCalledTimes(2);
    expect(town.world.effects).toEqual([]);
    expect(town.world.human).toBe(false);
    expect(town.world.tick).toBe(1);
    expect(town.autoError).toBe('');
    expect(town.snapshot(visitor).quota.usedDay).toBe(1);
    expect(town.snapshot(visitor).usage.calls).toBe(2);
    expect(() =>
      town.accept(visitor, { requestId: randomUUID(), action: { type: 'round' } }),
    ).toThrow(/没有需要重试/);
  });
  it('preserves an automatic failure across a restart until an explicit retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'town-error-'));
    const path = join(dir, 'town.sqlite');
    let town;
    try {
      town = new SharedTown({
        path,
        config,
        clock: false,
        council: false,
        model: async () => {
          throw new ModelError('回应格式有误，请重试。', 'invalid_fields');
        },
      });
      await town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
      town.close();
      const model = vi.fn().mockResolvedValue({ round });
      town = new SharedTown({ path, config, clock: false, council: false, model });
      expect(town.autoError).toBe('回应格式有误，请重试。');
      town.tick();
      expect(model).not.toHaveBeenCalled();
      town.accept(
        { owner: 'visitor', ip: 'network' },
        { requestId: randomUUID(), action: { type: 'round' } },
      );
      await new Promise((done) => setImmediate(done));
      expect(town.autoError).toBe('');
      expect(town.store.get('auto_error')).toBe('');
      expect(model).toHaveBeenCalledTimes(1);
    } finally {
      if (town && !town.closed) town.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('removes unknown validation field names and all invalid values', () => {
    expect(
      validationDetails([
        {
          code: 'invalid_value',
          path: ['decisions', 0, 'private-key-never-record'],
          received: config.apiKey,
          message: config.apiKey,
        },
      ]),
    ).toEqual([{ code: 'invalid_value', path: ['decisions', 0, '*'] }]);
  });
  it('distinguishes upstream HTTP failures, invalid response JSON and connection errors', async () => {
    vi.stubGlobal('fetch', async () => new Response(config.apiKey, { status: 429 }));
    await expect(requestModel(config, { world: createWorld(), round: true })).rejects.toMatchObject(
      {
        diagnostic: { code: 'upstream_http', upstreamStatus: 429 },
        message: '回应繁忙，请稍后重试。',
      },
    );
    vi.stubGlobal('fetch', async () => new Response('not-json'));
    await expect(requestModel(config, { world: createWorld(), round: true })).rejects.toMatchObject(
      { diagnostic: { code: 'upstream_json' } },
    );
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(config.apiKey);
    });
    await expect(requestModel(config, { world: createWorld(), round: true })).rejects.toMatchObject(
      { diagnostic: { code: 'network' }, message: '暂时连接不上，请稍后重试。' },
    );
  });
});
