import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedTown } from '../server/town.mjs';
import { requestModel } from '../server/model.mjs';
import { createWorld, exportReplay, importReplay } from '../src/world/engine.ts';
import {
  openCouncil,
  closeCouncil,
  COUNCIL_BREAK,
  AI_PROPOSAL_MAX_DELAY,
  COUNCIL_DURATION,
} from '../src/world/council.ts';
import {
  WorldSchema,
  ConstitutionLawsSchema,
  CONSTITUTION_TEXT_LIMIT,
  CONSTITUTION_CONTEXT_LIMIT,
  constitutionContext,
  lawId,
} from '../src/shared/schema.ts';
import { round } from './fixture';
const towns = [],
  dirs = [];
const alice = { owner: 'visitor', ip: 'network' };
const config = { baseUrl: 'http://mock', model: 'mock' };
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
const laws = (count) =>
  Array.from({ length: count }, (_, n) => ({
    id: randomUUID(),
    topic: 'bread',
    rule: `法条${n}`,
    revision: 1,
    updatedAt: 1000,
    motionId: randomUUID(),
  }));
const turn = { id: 0, kind: 'automatic', action: { type: 'round' } };
const adopted = (world, proposal, now = 1000000) => {
  const next = openCouncil(world, proposal.topic, randomUUID(), now, proposal);
  next.council.visitorYes = 1;
  return closeCouncil(next, now + COUNCIL_DURATION);
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const town of towns.splice(0)) if (!town.closed) town.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('bounded constitution', () => {
  it('allows 1024 distinct clauses in the same category, rejects the 1025th at submission and settlement', () => {
    const town = setup();
    const world = { ...createWorld(), laws: laws(1023) };
    const full = adopted(world, { topic: 'bread', operation: 'adopt', rule: '最后一条' });
    expect(full.laws).toHaveLength(1024);
    expect(WorldSchema.safeParse(full).success).toBe(true);
    town.transaction(() => town.commit(full));
    const version = town.version;
    expect(() =>
      town.propose(alice, { topic: 'rain', operation: 'adopt', rule: '超出上限' }),
    ).toThrow(/1024/);
    expect(town.version).toBe(version);
    const refused = adopted(full, { topic: 'rain', operation: 'adopt', rule: '超出上限' });
    expect(refused.council).toMatchObject({
      result: 'rejected',
      resolutionNote: expect.stringContaining('1024'),
    });
    expect(refused.laws).toEqual(full.laws);
    expect(refused.effects).toEqual(full.effects);
    expect(WorldSchema.safeParse({ ...full, laws: [...full.laws, ...laws(1)] }).success).toBe(
      false,
    );
    expect(ConstitutionLawsSchema.safeParse([full.laws[0], full.laws[0]]).success).toBe(false);
  });
  it('edits or repeals exactly the selected clause, preserves its identity and does not repeat events', () => {
    const world = { ...createWorld(), laws: laws(2) };
    const first = world.laws[0],
      second = world.laws[1];
    const edited = adopted(world, {
      topic: 'bread',
      lawId: second.id,
      operation: 'amend',
      rule: '修改第二条',
    });
    expect(edited.laws.find((law) => law.id === first.id)).toEqual(first);
    expect(edited.laws.find((law) => law.id === second.id)).toMatchObject({
      id: second.id,
      revision: 2,
      rule: '修改第二条',
    });
    expect(edited.food).toBe(world.food);
    const removed = adopted(edited, { topic: 'bread', lawId: second.id, operation: 'repeal' });
    expect(removed.laws).toEqual([first]);
    const invalid = adopted(world, { topic: 'bread', lawId: randomUUID(), operation: 'repeal' });
    const ambiguous = adopted(world, { topic: 'bread', operation: 'amend', rule: '未指定条款' });
    expect(ambiguous.council.result).toBe('rejected');
    expect(ambiguous.laws).toEqual(world.laws);
    expect(invalid.council.result).toBe('rejected');
    expect(invalid.laws).toEqual(world.laws);
  });
  it('can amend and repeal at the clause cap, rejects duplicates and never truncates excess text', () => {
    const world = { ...createWorld(), laws: laws(1024) };
    const town = setup();
    town.transaction(() => town.commit(world));
    expect(() =>
      town.propose(alice, { topic: 'rain', operation: 'adopt', rule: world.laws[0].rule }),
    ).toThrow(/相同条款/);
    expect(() =>
      town.propose(alice, { topic: 'bread', operation: 'adopt', rule: '字'.repeat(301) }),
    ).toThrow(/300/);
    const updated = adopted(world, {
      topic: 'bread',
      lawId: world.laws[500].id,
      operation: 'amend',
      rule: '容量满后仍可修订',
    });
    expect(updated.council.result).toBe('passed');
    expect(updated.laws).toHaveLength(1024);
    expect(
      adopted(updated, { topic: 'bread', lawId: world.laws[500].id, operation: 'repeal' }).laws,
    ).toHaveLength(1023);
    const heavy = laws(55).map((law, n) => ({
      ...law,
      rule: `${n}:` + '字'.repeat(297 - String(n).length),
    }));
    expect(heavy.reduce((n, law) => n + law.rule.length, 0)).toBeGreaterThan(
      CONSTITUTION_TEXT_LIMIT,
    );
    expect(ConstitutionLawsSchema.safeParse(heavy).success).toBe(false);
    const edge = laws(64).map((law, n) => ({
      ...law,
      rule: `${n}:` + '字'.repeat(255 - String(n).length),
    }));
    expect(edge.reduce((n, law) => n + law.rule.length, 0)).toBe(CONSTITUTION_TEXT_LIMIT);
    expect(ConstitutionLawsSchema.safeParse(edge).success).toBe(true);
    const refused = adopted(
      { ...createWorld(), laws: edge },
      { topic: 'bread', lawId: edge[0].id, operation: 'amend', rule: '字'.repeat(300) },
    );
    expect(refused.council.result).toBe('rejected');
    expect(refused.laws).toEqual(edge);
  });
  it('sends every clause in compact bounded model context, and exports an importable large replay', async () => {
    const world = { ...createWorld(), laws: laws(1024) };
    expect(
      new TextEncoder().encode(JSON.stringify(constitutionContext(world.laws))).length,
    ).toBeLessThanOrEqual(CONSTITUTION_CONTEXT_LIMIT);
    let request;
    vi.stubGlobal('fetch', async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({ output_text: JSON.stringify(round) });
    });
    await requestModel(config, { world, round: true });
    const context = JSON.parse(request.input[1].content).world.constitution;
    expect(context).toHaveLength(1024);
    expect(context.map((law) => law.id)).toEqual(world.laws.map(lawId));
    expect(context.map((law) => law.rule)).toEqual(world.laws.map((law) => law.rule));
    expect(context[0].updatedAt).toBeUndefined();
    const raw = exportReplay(Array(120).fill(world));
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(5_000_000);
    const replay = importReplay(raw);
    expect(replay.at(-1).laws).toEqual(world.laws);
  });
});
describe('occasional resident proposals', () => {
  it('waits a random 15–30 minutes, invites one proposer and prioritizes the following voting round', async () => {
    let now = 1000000;
    let proposal = { topic: 'bread', operation: 'adopt', rule: '居民共同照料粮仓。' };
    const model = vi.fn(async (_config, { proposalInvitation }) => ({
      round: {
        ...round,
        ...(proposalInvitation
          ? {
              councilProposal: {
                agentId: proposalInvitation.agentId,
                proposal,
                reason: '粮食应该有人照料。',
              },
            }
          : {}),
      },
    }));
    const town = setup({ now: () => now, model });
    const online = () => {
      town.presence(alice, true);
    };
    town.connect(alice, () => {});
    online();
    expect(Number(town.store.get('next_council_proposal_at')) - now).toBe(COUNCIL_BREAK);
    await town.start(turn);
    expect(model.mock.calls[0][1].proposalInvitation).toBeUndefined();
    expect(town.world.council).toBeUndefined();
    now = Number(town.store.get('next_council_proposal_at'));
    online();
    await town.start(turn);
    expect(model).toHaveBeenCalledTimes(3);
    await new Promise((done) => setImmediate(done));
    expect(town.world.council).toMatchObject({
      proposer: 'mira',
      status: 'open',
      rule: proposal.rule,
      residents: [{ agentId: 'mira', choice: 'yes', opinion: '粮食应该有人照料。' }],
    });
    expect(town.world.laws).toBeUndefined();
    now += COUNCIL_DURATION;
    town.finishCouncil();
    expect(town.world.laws[0].rule).toBe(proposal.rule);
    const id = lawId(town.world.laws[0]);
    now = Number(town.store.get('next_council_proposal_at'));
    online();
    proposal = {
      topic: 'bread',
      lawId: id,
      operation: 'amend',
      rule: '居民轮流照料粮仓，保障休息。',
    };
    await town.start(turn);
    await new Promise((done) => setImmediate(done));
    expect(town.world.council).toMatchObject({ proposer: 'otto', operation: 'amend', lawId: id });
    now += COUNCIL_DURATION;
    town.finishCouncil();
    expect(town.world.laws).toHaveLength(1);
    expect(lawId(town.world.laws[0])).toBe(id);
    now = Number(town.store.get('next_council_proposal_at'));
    online();
    const version = town.world.council.id;
    await town.start(turn);
    expect(model.mock.calls.at(-1)[1].proposalInvitation).toBeUndefined();
    expect(town.world.council.id).toBe(version);
    expect(town.store.db.prepare('SELECT count(*) AS n FROM council_ai_proposals').get().n).toBe(2);
    now = 1000000 + COUNCIL_BREAK + 3600000;
    online();
    proposal = { topic: 'bread', lawId: id, operation: 'repeal' };
    await town.start(turn);
    await new Promise((done) => setImmediate(done));
    expect(town.world.council).toMatchObject({ proposer: 'mira', operation: 'repeal' });
  });
  it('permits declining and postpones failures without immediate re-invitation', async () => {
    let now = 1000000;
    const model = vi.fn().mockResolvedValue({ round });
    const town = setup({ now: () => now, model, draw: (n) => n - 1 });
    expect(Number(town.store.get('next_council_proposal_at')) - now).toBe(AI_PROPOSAL_MAX_DELAY);
    town.connect(alice, () => {});
    now = Number(town.store.get('next_council_proposal_at'));
    town.presence(alice, true);
    await town.start(turn);
    expect(model.mock.calls.at(-1)[1].proposalInvitation.agentId).toBe('soren');
    expect(town.world.council).toBeUndefined();
    await town.start(turn);
    expect(model.mock.calls.at(-1)[1].proposalInvitation).toBeUndefined();
    now = Number(town.store.get('next_council_proposal_at'));
    town.presence(alice, true);
    model.mockRejectedValueOnce(new Error('mock failure'));
    await town.start(turn);
    expect(Number(town.store.get('next_council_proposal_at')) - now).toBe(AI_PROPOSAL_MAX_DELAY);
    expect(town.store.db.prepare('SELECT count(*) AS n FROM council_ai_proposals').get().n).toBe(0);
  });
  it('persists delay and resident hourly caps across restarts, with no invitation for offline, disabled or human rounds', async () => {
    let now = 1000000;
    const dir = mkdtempSync(join(tmpdir(), 'town-proposal-'));
    dirs.push(dir);
    const path = join(dir, 'town.sqlite');
    let town = setup({ now: () => now, path });
    const due = town.store.get('next_council_proposal_at');
    town.store.db
      .prepare('INSERT INTO council_ai_proposals VALUES (?, ?, ?)')
      .run(randomUUID(), 'mira', now);
    town.close();
    town = setup({ now: () => now, path });
    expect(town.store.get('next_council_proposal_at')).toBe(due);
    expect(town.proposalCandidates()).not.toContain('mira');
    now = Number(due);
    expect(town.inviteProposal(turn)).toBeUndefined();
    town.connect(alice, () => {});
    town.presence(alice, true);
    expect(town.inviteProposal({ ...turn, kind: 'human' })).toBeUndefined();
    town.councilEnabled = false;
    expect(town.inviteProposal(turn)).toBeUndefined();
    town.councilEnabled = true;
    expect(town.inviteProposal(turn).agentId).toBe('otto');
    expect(town.store.get('next_council_proposal_at')).not.toBe(due);
    town.close();
    town = setup({ now: () => now, path });
    expect(Number(town.store.get('next_council_proposal_at'))).toBe(now + COUNCIL_BREAK);
  });
  it('ignores uninvited, wrong-resident and invalid proposals while keeping ordinary decisions', async () => {
    let now = 1000000;
    const model = vi.fn(async () => ({
      round: {
        ...round,
        councilProposal: {
          agentId: 'soren',
          proposal: { topic: 'bread', operation: 'adopt', rule: '粮仓公开' },
          reason: '希望互助',
        },
      },
    }));
    const town = setup({ now: () => now, model });
    town.connect(alice, () => {});
    town.presence(alice, true);
    await town.start(turn);
    expect(town.world.tick).toBe(1);
    expect(town.world.council).toBeUndefined();
    now = Number(town.store.get('next_council_proposal_at'));
    town.presence(alice, true);
    await town.start(turn);
    expect(town.world.tick).toBe(2);
    expect(town.world.council).toBeUndefined();
    now = Number(town.store.get('next_council_proposal_at'));
    town.presence(alice, true);
    model.mockResolvedValueOnce({
      round: {
        ...round,
        councilProposal: {
          agentId: 'mira',
          proposal: {
            topic: 'bread',
            lawId: randomUUID(),
            operation: 'amend',
            rule: '不存在的条文',
          },
          reason: '精简',
        },
      },
    });
    await town.start(turn);
    expect(town.world.tick).toBe(3);
    expect(town.autoError).toBe('');
    expect(town.world.council).toBeUndefined();
  });
  it('does not let a delayed AI proposal interrupt a newer visitor vote, even when that vote changed no laws', async () => {
    let now = 1000000,
      resolve,
      invitation;
    const town = setup({
      now: () => now,
      model: async (_config, args) => {
        invitation = args.proposalInvitation;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    town.connect(alice, () => {});
    now = Number(town.store.get('next_council_proposal_at'));
    town.presence(alice, true);
    const pending = town.start(turn);
    expect(invitation.agentId).toBe('mira');
    town.propose(alice, { topic: 'rain', operation: 'adopt', rule: '游客发起的议题' });
    const id = town.world.council.id;
    now += COUNCIL_DURATION;
    town.finishCouncil();
    resolve({
      round: {
        ...round,
        councilProposal: {
          agentId: 'mira',
          proposal: { topic: 'bread', operation: 'adopt', rule: '延迟的居民提案' },
          reason: '想分面包',
        },
      },
    });
    await pending;
    expect(town.world.council).toMatchObject({ id, status: 'closed', result: 'tied' });
    expect(town.world.tick).toBe(1);
    expect(town.snapshot(alice).usage.calls).toBe(1);
    expect(town.store.db.prepare('SELECT count(*) AS n FROM council_ai_proposals').get().n).toBe(0);
  });
  it('includes optional resident proposal instructions over both APIs without extra requests or output tokens', async () => {
    for (const wireApi of ['responses', 'chat']) {
      let body;
      const value = {
        ...round,
        councilProposal: {
          agentId: 'ada',
          proposal: { topic: 'mayors', operation: 'adopt', rule: '公共工具用完归还。' },
          reason: '找不到扳手',
        },
      };
      const fetch = vi.fn(async (_url, options) => {
        body = JSON.parse(options.body);
        return Response.json(
          wireApi === 'responses'
            ? { output_text: JSON.stringify(value) }
            : { choices: [{ message: { content: JSON.stringify(value) } }] },
        );
      });
      vi.stubGlobal('fetch', fetch);
      const result = await requestModel(
        { ...config, wireApi },
        { world: createWorld(), round: true, proposalInvitation: { agentId: 'ada' } },
      );
      expect(result.round.councilProposal).toEqual(value.councilProposal);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(body.max_output_tokens || body.max_tokens).toBe(1800);
      expect((body.input || body.messages)[0].content).toContain('仅邀请居民 ada');
      expect((body.input || body.messages)[0].content).toContain('没有真实修改需要就省略');
    }
  });
});
