import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedTown } from '../server/town.mjs';
import { requestModel } from '../server/model.mjs';
import { COUNCIL_DURATION, openCouncil } from '../src/world/council.ts';
import { createWorld } from '../src/world/engine.ts';
import { round, decision } from './fixture';
const towns = [],
  dirs = [];
const visitor = { owner: 'visitor-private', ip: 'network-private' };
const config = { baseUrl: 'http://mock', model: 'mock', adminToken: 'test-private' };
const proposal = { topic: 'bread', operation: 'adopt', rule: '面包先分给饥饿的人。' };
const flush = () => new Promise((done) => setImmediate(done));
const votes = (world) => ({
  decisions: round.decisions.map((row, n) => ({
    ...row,
    councilVote: { motionId: world.council.id, choice: n < 3 ? 'yes' : 'no' },
  })),
});
const setup = (options = {}) => {
  const town = new SharedTown({
    path: ':memory:',
    clock: false,
    config,
    draw: () => 0,
    ...options,
  });
  towns.push(town);
  return town;
};
const pausedVisitor = (town) => {
  town.connect(visitor, () => {});
  town.presence(visitor, false, 'default', true);
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const town of towns.splice(0)) if (!town.closed) town.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('resident council scheduling', () => {
  it('prioritizes one real normal round for a new proposal even when every visitor is personally paused', async () => {
    let now = 1000000;
    const model = vi.fn(async (_config, { world }) => ({
      round: votes(world),
      usage: { input: 40, output: 20 },
    }));
    const town = setup({ now: () => now, model, limits: { interval: 3600000 } });
    pausedVisitor(town);
    town.autoError = '上一个回合失败';
    town.propose(visitor, proposal);
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    expect(town.world.council.residents).toHaveLength(6);
    expect(town.world.council.residents.map((vote) => vote.opinion)).toEqual(
      round.decisions.map((row) => row.speech),
    );
    expect(town.world.tick).toBe(1);
    expect(town.autoError).toBe('');
    expect(town.snapshot(visitor).usage).toEqual({ calls: 1, input: 40, output: 20 });
    for (let i = 0; i < 20; i++) {
      now += 1000;
      town.tick();
    }
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    expect([...town.listeners][0].visible).toBe(false);
    now += COUNCIL_DURATION;
    town.tick();
    expect(town.world.council).toMatchObject({ status: 'closed', result: 'tied' });
    expect(town.world.constitution.at(-1).residentAbstain).toBe(0);
  });
  it('runs the council round immediately after an in-flight round that did not know the proposal', async () => {
    let resolve;
    const model = vi.fn(async (_config, { world }) =>
      !world.council
        ? new Promise((done) => {
            resolve = done;
          })
        : { round: votes(world) },
    );
    const town = setup({ now: () => 1000000, model });
    pausedVisitor(town);
    const pending = town.start({ id: 0, kind: 'automatic', action: { type: 'round' } });
    town.propose(visitor, proposal);
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    resolve({ round });
    await pending;
    await flush();
    expect(model).toHaveBeenCalledTimes(2);
    expect(town.world.council.residents).toHaveLength(6);
    expect(town.world.tick).toBe(2);
  });
  it('does not cancel a human chat and gives the pending vote the next available round', async () => {
    let resolve;
    const model = vi.fn(async (_config, args, signal) =>
      args.round
        ? { round: votes(args.world) }
        : new Promise((done) => {
            resolve = () => done({ decision });
            signal.addEventListener('abort', () => {
              throw new Error('Human chat was interrupted');
            });
          }),
    );
    const town = setup({ now: () => 1000000, model });
    pausedVisitor(town);
    town.accept(visitor, {
      requestId: randomUUID(),
      action: { type: 'chat', agentId: 'mira', text: '聊聊今天的天气' },
    });
    town.propose(visitor, proposal);
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(model).toHaveBeenCalledTimes(2);
    expect(town.world.council.residents).toHaveLength(6);
    expect(town.world.conversations.at(-1).role).toBe('model');
  });
  it('prioritizes the expiring ballot before queued chats while preserving their FIFO order', async () => {
    let now = 1000000,
      resolve;
    const order = [];
    const model = vi.fn(async (_config, args) => {
      order.push(args.round ? 'ballot' : args.prompt);
      if (args.round) return { round: votes(args.world) };
      if (args.prompt === '第一条消息')
        return new Promise((done) => {
          resolve = () => done({ decision });
        });
      return { decision };
    });
    const town = setup({ now: () => now, model });
    pausedVisitor(town);
    town.accept(visitor, {
      requestId: randomUUID(),
      action: { type: 'chat', agentId: 'mira', text: '第一条消息' },
    });
    now += 10001;
    town.accept(visitor, {
      requestId: randomUUID(),
      action: { type: 'chat', agentId: 'mira', text: '第二条消息' },
    });
    town.propose(visitor, proposal);
    await flush();
    expect(order).toEqual(['第一条消息']);
    resolve();
    await flush();
    expect(order).toEqual(['第一条消息', 'ballot', '第二条消息']);
    expect(town.world.council.residents).toHaveLength(6);
  });
  it('retains an in-flight voting round when a visitor sends a chat, then handles the queued chat', async () => {
    let resolve, ballotSignal;
    const model = vi.fn(async (_config, args, signal) =>
      args.round
        ? new Promise((done) => {
            ballotSignal = signal;
            resolve = () => done({ round: votes(args.world) });
          })
        : { decision },
    );
    const town = setup({ now: () => 1000000, model });
    pausedVisitor(town);
    town.propose(visitor, proposal);
    await flush();
    town.accept(visitor, {
      requestId: randomUUID(),
      action: { type: 'chat', agentId: 'mira', text: '投完票再聊' },
    });
    expect(ballotSignal.aborted).toBe(false);
    expect(model).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(model).toHaveBeenCalledTimes(2);
    expect(town.world.council.residents).toHaveLength(6);
    expect(town.world.conversations.at(-1).role).toBe('model');
  });
  it('does not retry missing votes or failed requests in a loop, including after a server restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'town-ballots-'));
    dirs.push(dir);
    const path = join(dir, 'town.sqlite');
    const model = vi.fn().mockRejectedValue(new Error('provider failure'));
    let town = setup({ path, now: () => 1000000, model });
    pausedVisitor(town);
    town.propose(visitor, proposal);
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    const motionId = town.world.council.id;
    for (let i = 0; i < 20; i++) town.tick();
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    town.close();
    town = setup({ path, now: () => 1000001, model });
    pausedVisitor(town);
    town.tick();
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    expect(town.world.council).toMatchObject({ id: motionId, residents: [] });
  });
  it('recovers an unattempted live motion on restart without waiting for the normal interval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'town-live-ballot-'));
    dirs.push(dir);
    const path = join(dir, 'town.sqlite');
    let town = setup({ path, now: () => 1000000 });
    town.propose(visitor, proposal);
    town.close();
    await flush();
    const model = vi.fn(async (_config, { world }) => ({ round: votes(world) }));
    town = setup({ path, now: () => 1001000, model, limits: { interval: 3600000 } });
    pausedVisitor(town);
    town.tick();
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    expect(town.world.council.residents).toHaveLength(6);
  });
  it('respects the model budget and global pause without inventing ballots', async () => {
    let now = 1000000;
    const model = vi.fn(async (_config, { world }) => ({ round: votes(world) }));
    const town = setup({ now: () => now, model, limits: { callsMinute: 1 } });
    pausedVisitor(town);
    town.store.db.prepare('INSERT INTO calls(created) VALUES (?)').run(now);
    town.propose(visitor, proposal);
    await flush();
    expect(model).not.toHaveBeenCalled();
    expect(town.store.get('council_ballot_attempt')).toBeUndefined();
    now += COUNCIL_DURATION;
    town.tick();
    expect(town.world.council.residents).toHaveLength(0);
    expect(town.world.constitution.at(-1).residentAbstain).toBe(6);
    now += 60001;
    town.propose(visitor, proposal);
    town.admin(config.adminToken, 'pause');
    await flush();
    expect(model).not.toHaveBeenCalled();
    town.admin(config.adminToken, 'resume');
    town.tick();
    await flush();
    expect(model).toHaveBeenCalledTimes(1);
    expect(town.world.council.residents).toHaveLength(6);
  });
  it('discards votes returned after the deadline and never carries them to another motion', async () => {
    let now = 1000000,
      resolve,
      modelWorld;
    const model = vi.fn(async (_config, { world }) => {
      modelWorld = world;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const town = setup({ now: () => now, model });
    pausedVisitor(town);
    town.propose(visitor, proposal);
    await flush();
    now += COUNCIL_DURATION;
    town.tick();
    resolve({ round: votes(modelWorld) });
    await flush();
    expect(town.world.council).toMatchObject({ status: 'closed', residents: [] });
    expect(town.world.constitution.at(-1).residentAbstain).toBe(6);
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('keeps the vote open for 45 seconds and accepts residents who respond after the old 30 second limit', async () => {
    let now = 1000000,
      resolve,
      modelWorld;
    const town = setup({
      now: () => now,
      model: async (_config, { world }) => {
        modelWorld = world;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    pausedVisitor(town);
    town.propose(visitor, proposal);
    await flush();
    expect(town.world.council.closesAt - town.world.council.openedAt).toBe(45000);
    now += 35000;
    town.tick();
    expect(town.world.council.status).toBe('open');
    resolve({ round: votes(modelWorld) });
    await flush();
    expect(town.world.council.residents).toHaveLength(6);
    now += 9999;
    town.tick();
    expect(town.world.council.status).toBe('open');
    now++;
    town.tick();
    expect(town.world.council.status).toBe('closed');
    expect(town.world.constitution.at(-1).residentAbstain).toBe(0);
  });
  it('accepts actual partial ballots but never replaces missing choices with default votes', async () => {
    const town = setup({
      now: () => 1000000,
      model: async (_config, { world }) => ({
        round: {
          decisions: round.decisions.map((row, n) =>
            n === 0 ? { ...row, councilVote: { motionId: world.council.id, choice: 'no' } } : row,
          ),
        },
      }),
    });
    pausedVisitor(town);
    town.propose(visitor, proposal);
    await flush();
    expect(town.world.council.residents).toMatchObject([{ agentId: 'mira', choice: 'no' }]);
    expect(town.snapshot(visitor).usage.calls).toBe(1);
  });
});
describe('explicit per-resident voting instructions', () => {
  it('lists every pending voter for both model APIs and excludes already cast votes and closed motions', async () => {
    const world = openCouncil(createWorld(), 'bread', randomUUID(), 1000000);
    world.council.residents = [{ agentId: 'mira', choice: 'no', opinion: '我反对这个提案。' }];
    for (const wireApi of ['responses', 'chat']) {
      let body;
      vi.stubGlobal('fetch', async (_url, options) => {
        body = JSON.parse(options.body);
        const value = JSON.stringify(votes(world));
        return Response.json(
          wireApi === 'responses'
            ? { output_text: value }
            : { choices: [{ message: { content: value } }] },
        );
      });
      await requestModel({ ...config, wireApi }, { world, round: true });
      const messages = body.input || body.messages;
      expect(JSON.parse(messages[1].content).world.council.requiredVotes).toEqual(
        round.decisions
          .slice(1)
          .map((row) => ({ agentId: row.agentId, motionId: world.council.id })),
      );
      expect(messages[0].content).toContain('不得只给最后一位或部分居民投票');
      expect(messages[0].content).toContain('不能把漏字段当作弃权');
      expect(body.max_output_tokens || body.max_tokens).toBe(1800);
    }
  });
});
