import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SharedTown } from '../server/town.mjs';
import { createHandler } from '../server/app.mjs';
import { TownStore } from '../server/store.mjs';
import { applyRound, createWorld, exportReplay, importReplay } from '../src/world/engine.ts';
import { round, decision } from './fixture.ts';

const owned = [],
  dirs = [],
  servers = [];
const identity = { owner: 'alice', ip: 'ip-one' };
const bob = { owner: 'bob', ip: 'ip-two' };
const config = { baseUrl: 'http://mock', model: 'mock', adminToken: 'admin-secret' };
const action = (action) => ({ requestId: randomUUID(), action });
const chat = (text = '你好') => action({ type: 'chat', agentId: 'mira', text });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(options = {}) {
  const town = new SharedTown({
    path: ':memory:',
    config,
    clock: false,
    council: false,
    model: async () => ({ decision, round, usage: { input: 10, output: 20 } }),
    ...options,
  });
  owned.push(town);
  return town;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function serve(town, extra = {}) {
  const server = createServer(createHandler({ town, config: { ...config, ...extra } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  for (const town of owned.splice(0)) if (!town.closed) town.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('shared authoritative town', () => {
  it('retains the latest 200 feed entries in SQLite, history and exported replays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'town-feed-'));
    dirs.push(dir);
    const path = join(dir, 'world.sqlite');
    let world = createWorld();
    for (let i = 0; i < 40; i++) world = applyRound(world, round);
    const first = setup({ path });
    first.transaction(() => first.commit(world));
    first.close();
    const restored = setup({ path });
    expect(restored.world.feed).toHaveLength(200);
    expect(restored.world.feed).toEqual(world.feed);
    const base = await serve(restored);
    const history = await (await fetch(base + '/api/history')).json();
    expect(history.snapshots.at(-1).feed).toEqual(world.feed);
    expect(importReplay(exportReplay(history.snapshots)).at(-1).feed).toEqual(world.feed);
  });
  it('serializes two visitors and broadcasts identical committed worlds without overwriting either chat', async () => {
    const requests = [],
      statesA = [],
      statesB = [];
    const town = setup({
      model: (c, body) => {
        const d = deferred();
        requests.push({ body, ...d });
        return d.promise;
      },
    });
    town.connect(identity, (state) => statesA.push(state));
    town.connect(bob, (state) => statesB.push(state));
    const first = town.accept(identity, chat('第一位访客'));
    town.accept(bob, chat('第二位访客'));
    expect(requests).toHaveLength(1);
    expect(town.snapshot(bob).tasks.filter((t) => t.state === 'pending')).toHaveLength(1);
    requests[0].resolve({ decision });
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].body.world.conversations.map((c) => c.text)).toContain('第一位访客');
    requests[1].resolve({ decision });
    await flush();
    expect(town.world.conversations.filter((c) => c.role === 'human').map((c) => c.text)).toEqual([
      '第一位访客',
      '第二位访客',
    ]);
    expect(statesA.at(-1).world).toEqual(statesB.at(-1).world);
    expect(statesA.at(-1).tasks).toEqual([]);
    expect(
      town.store.db.prepare('SELECT status FROM commands WHERE id=?').get(first.id).status,
    ).toBe('completed');
  });
  it('preempts automatic work but ignores a late reply even if upstream ignores abort', async () => {
    const requests = [];
    const town = setup({
      model: (c, body, signal) => {
        const d = deferred();
        requests.push({ ...d, signal });
        return d.promise;
      },
    });
    town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
    town.accept(identity, chat());
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].resolve({ decision });
    await flush();
    const version = town.version;
    requests[0].resolve({ round });
    await flush();
    expect(town.version).toBe(version);
    expect(town.world.tick).toBe(0);
    expect(town.budget().dayUsed).toBe(2);
  });
  it('deduplicates lost acknowledgements, rejects payload substitution and validates strict commands', async () => {
    const d = deferred();
    const town = setup({ model: () => d.promise });
    const body = chat();
    const first = town.accept(identity, body);
    expect(town.accept(identity, body).id).toBe(first.id);
    expect(town.budget().dayUsed).toBe(1);
    expect(() =>
      town.accept(identity, { ...body, action: { ...body.action, text: '改写' } }),
    ).toThrow('另一项操作');
    expect(() => town.accept(bob, { ...chat(), world: {} })).toThrow('格式');
    expect(() => town.accept(bob, action({ type: 'round' }))).toThrow('需要重试');
  });
  it('enforces signed anonymous cookies, IP limits, cooldown, personal and global caps', async () => {
    let time = Date.UTC(2026, 9, 16, 1);
    const town = setup({ now: () => time, limits: { visitorHour: 2, visitorDay: 2, ipHour: 2 } });
    town.accept(identity, action({ type: 'join' }));
    await flush();
    expect(() => town.accept(identity, chat())).toThrow('10 秒');
    time += 10001;
    town.accept(identity, chat());
    await flush();
    time += 10001;
    expect(() => town.accept(identity, chat())).toThrow('次数已达上限');
    expect(() => town.accept({ owner: 'new-cookie', ip: identity.ip }, chat())).toThrow('当前网络');
    const res = {
      setHeader(k, value) {
        this.cookie = value;
      },
    };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const valid = town.identity(req, res);
    const cookie = res.cookie.split(';')[0];
    expect(
      town.identity(
        { ...req, headers: { cookie } },
        {
          setHeader() {
            throw Error('Should keep identity');
          },
        },
      ).owner,
    ).toBe(valid.owner);
    const tampered = town.identity({ ...req, headers: { cookie: cookie + 'x' } }, res);
    expect(tampered.owner).not.toBe(valid.owner);
    expect(res.cookie).toContain('HttpOnly');
    expect(res.cookie).toContain('SameSite=Lax');
    expect(town.identity({ ...req, headers: { 'x-real-ip': 'attacker-chosen' } }, res).ip).toBe(
      valid.ip,
    );
  });
  it('caps per-visitor pending work and only permits cancellation by its owner', async () => {
    let time = Date.now();
    const town = setup({ now: () => time, model: () => deferred().promise, limits: { queue: 3 } });
    const first = town.accept(identity, chat('一'));
    time += 10001;
    const second = town.accept(identity, chat('二'));
    time += 10001;
    expect(() => town.accept(identity, chat('三'))).toThrow('2 项');
    expect(() => town.cancel(bob, second.id)).toThrow('自己');
    expect(() => town.cancel(identity, first.id)).toThrow('自己');
    town.cancel(identity, second.id);
    town.accept(identity, chat('四'));
    town.accept(bob, chat('五'));
    expect(() => town.accept({ owner: 'eve', ip: 'third-ip' }, chat())).toThrow('队列已满');
  });
  it('persists budgets across restarts and resumes only when the minute/day quota resets', async () => {
    let time = Date.UTC(2026, 9, 16, 1);
    const dir = mkdtempSync(join(tmpdir(), 'town-budget-'));
    dirs.push(dir);
    const path = join(dir, 'world.sqlite');
    const town = setup({ path, now: () => time, limits: { callsMinute: 1, callsDay: 2 } });
    town.accept(identity, chat());
    await flush();
    expect(() => town.accept(bob, chat())).toThrow('全站');
    town.close();
    const restored = setup({ path, now: () => time, limits: { callsMinute: 1, callsDay: 2 } });
    expect(restored.world.conversations).toHaveLength(2);
    expect(restored.budget().dayUsed).toBe(1);
    time += 60001;
    restored.accept(bob, chat());
    await flush();
    time += 60001;
    expect(() => restored.accept(identity, chat())).toThrow('全站');
    time += 86400000;
    restored.accept(identity, chat());
    await flush();
    expect(restored.budget().dayUsed).toBe(1);
  });
  it('recovers interrupted commands without repeating an event or auto-retrying paid calls', async () => {
    let time = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'town-recovery-'));
    dirs.push(dir);
    const path = join(dir, 'world.sqlite');
    const first = setup({ path, now: () => time, model: () => deferred().promise });
    const command = first.accept(identity, action({ type: 'event', eventId: 'bread' }));
    const food = first.world.food,
      version = first.version;
    first.close();
    const town = setup({ path, now: () => time });
    expect(town.version).toBe(version);
    expect(town.world.food).toBe(food);
    expect(town.snapshot(identity).tasks[0].state).toBe('failed');
    expect(town.budget().dayUsed).toBe(1);
    time += 10001;
    town.accept(identity, action({ type: 'retry', id: command.id }));
    await flush();
    expect(town.world.tick).toBe(1);
    expect(town.budget().dayUsed).toBe(2);
    expect(town.world.feed.filter((f) => f.type === 'event')).toHaveLength(1);
  });
  it('keeps global progression independent of one viewer leaving or pausing and stops automatic calls when nobody watches', async () => {
    let time = Date.now();
    let calls = 0;
    const town = setup({
      now: () => time,
      model: async () => {
        calls++;
        return { round };
      },
    });
    time += 30000;
    town.tick();
    expect(calls).toBe(0);
    const leave = town.connect(identity, () => {});
    town.connect(bob, () => {});
    town.presence(identity, false);
    town.presence(bob, true);
    time += 30000;
    town.tick();
    await flush();
    expect(calls).toBe(1);
    leave();
    town.presence(bob, false);
    time += 30000;
    town.tick();
    expect(calls).toBe(1);
    town.presence(bob, true);
    town.tick();
    await flush();
    expect(calls).toBe(2);
  });
  it('protects management, invalidates in-flight results after reset and produces a restorable SQLite backup', async () => {
    const d = deferred();
    const town = setup({ model: () => d.promise });
    town.accept(identity, chat());
    expect(() => town.admin('', 'reset')).toThrow('管理员');
    town.admin(config.adminToken, 'reset');
    const version = town.version;
    d.resolve({ decision });
    await flush();
    expect(town.version).toBe(version);
    expect(town.world.conversations).toHaveLength(0);
    expect(() => town.accept(bob, chat())).toThrow('小镇暂时休息');
    const dir = mkdtempSync(join(tmpdir(), 'town-backup-'));
    dirs.push(dir);
    const path = join(dir, 'backup.sqlite');
    await town.store.backup(path);
    const backup = new TownStore(path);
    expect(JSON.parse(backup.get('world'))).toEqual(town.world);
    backup.close();
  });
  it('serves shared-only APIs, rejects forged worlds/origins, and streams initial state without credentials', async () => {
    const town = setup();
    const base = await serve(town);
    const response = await fetch(base + '/api/town');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    expect(await (await fetch(base + '/api/status')).json()).toMatchObject({ shared: true });
    expect(
      (
        await fetch(base + '/api/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(base + '/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify(chat()),
        })
      ).status,
    ).toBe(403);
    const streamAbort = new AbortController();
    const stream = await fetch(base + '/api/stream', {
      headers: { cookie },
      signal: streamAbort.signal,
    });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body.getReader();
    const message = new TextDecoder().decode((await reader.read()).value);
    expect(message).toContain('"world"');
    expect(message).not.toContain(config.adminToken);
    expect(message).not.toContain(town.store.get('secret'));
    streamAbort.abort();
    await reader.cancel().catch(() => {});
    const accepted = await fetch(base + '/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(chat()),
    });
    expect(accepted.status).toBe(202);
    await flush();
    expect(
      (await (await fetch(base + '/api/town', { headers: { cookie } })).json()).world.conversations,
    ).toHaveLength(2);
  });
});
