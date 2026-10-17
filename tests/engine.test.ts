import { describe, expect, it } from 'vitest';
import {
  applyDecision,
  applyChatReply,
  applyEvent,
  applyRound,
  addHumanMessage,
  createWorld,
  exportReplay,
  hasEffect,
  importReplay,
  joinWorld,
  stepWorld,
} from '../src/world/engine';
import { WorldSchema, type Round } from '../src/shared/schema';
import { round } from './fixture';

describe('model-only world', () => {
  it('never generates decisions or dialogue from the clock', () => {
    const initial = createWorld();
    const next = stepWorld(initial);
    expect(initial.agents.every((a) => a.speech === '')).toBe(true);
    expect(next.agents.map((a) => [a.location, a.speech, a.activity])).toEqual(
      initial.agents.map((a) => [a.location, a.speech, a.activity]),
    );
    expect(next.minute - initial.minute).toBe(15);
    expect(initial.tick).toBe(0);
  });
  it('applies all six model choices including dialogue and physical consequences', () => {
    const initial = createWorld();
    const next = applyRound(initial, round);
    expect(next.tick).toBe(1);
    expect(next.agents[0].speech).toBe(round.decisions[0].speech);
    expect(next.agents[0].activity).toBe(round.decisions[0].reason);
    expect(next.agents[0].location).toBe('square');
    expect(next.agents[2].location).toBe('farm');
    expect(next.food).toBe(initial.food + 12);
    expect(next.agents[0].relationships.otto).toBe(15);
    expect(next.feed.filter((e) => e.source === 'model')).toHaveLength(6);
    expect(WorldSchema.safeParse(next).success).toBe(true);
    expect(initial.agents[0].speech).toBe('');
  });
  it('rejects an incomplete, duplicate or unknown action round atomically', () => {
    const world = createWorld();
    for (const bad of [
      { decisions: round.decisions.slice(1) },
      { decisions: round.decisions.map((a) => ({ ...a, agentId: 'mira' })) },
      { decisions: round.decisions.map((a) => ({ ...a, action: 'execute-code' })) },
    ])
      expect(applyRound(world, bad as Round)).toBe(world);
  });
  it('bounds resources and serializes after prolonged model activity', () => {
    let world = createWorld();
    for (let i = 0; i < 240; i++) world = applyRound(world, round);
    expect(WorldSchema.safeParse(world).success).toBe(true);
    expect(world.feed).toHaveLength(200);
    expect(new Set(world.feed.map((entry) => entry.id)).size).toBe(200);
    expect(world.feed.map((entry) => entry.id)).toEqual(
      [...world.feed].sort((a, b) => b.id - a.id).map((entry) => entry.id),
    );
    expect(world.agents.every((a) => a.memories.length <= 12)).toBe(true);
  });
  it('applies world events without fabricating resident responses', () => {
    const initial = createWorld();
    let world = applyEvent(initial, 'bread');
    expect(world.food).toBe(149);
    expect(world.agents[0].hunger).toBe(0);
    world = applyEvent(world, 'rain');
    expect(hasEffect(world, 'rain')).toBe(true);
    expect(world.agents.every((a) => !a.speech)).toBe(true);
    for (let i = 0; i < 12; i++) world = stepWorld(world);
    expect(hasEffect(world, 'rain')).toBe(false);
  });
  it('honors the no-meetings world constraint without inventing a replacement action', () => {
    const initial = applyEvent(createWorld(), 'no-meetings');
    const proposed: Round = structuredClone(round);
    proposed.decisions[0].location = 'hall';
    const next = applyRound(initial, proposed);
    expect(next.agents[0].speech).toBe('');
    expect(next.feed.some((e) => e.type === 'system' && e.actor === 'mira')).toBe(true);
    expect(next.agents[1].speech).toBeTruthy();
  });
  it('exchanges actual memories between distinct residents', () => {
    const initial = createWorld();
    initial.agents.forEach((a) => (a.memories = [a.id]));
    const next = applyEvent(initial, 'memories');
    const changed = next.agents.filter((a) => a.memories.length === 2);
    expect(changed).toHaveLength(2);
    expect(changed[0].memories[1]).toBe(changed[1].id);
    expect(changed[1].memories[1]).toBe(changed[0].id);
  });
  it('records human messages and requires a separate model response', () => {
    let world = addHumanMessage(
      joinWorld(createWorld()),
      'mira',
      '你好 👋 <script>alert(1)</script>',
    );
    expect(world.human).toBe(true);
    expect(world.agents[0].speech).toBe('');
    expect(world.feed[0].source).toBe('human');
    world = applyDecision(world, 'mira', {
      action: 'socialize',
      location: 'square',
      speech: '欢迎你来。',
      reason: '接待访客',
    });
    expect(world.agents[0].speech).toBe('欢迎你来。');
    expect(world.feed[0].source).toBe('model');
  });
});
describe('replays are validated data', () => {
  it('round-trips Chinese, emoji, dialogue and world effects', () => {
    const history = [createWorld(), applyRound(applyEvent(createWorld(), 'rain'), round)];
    history[1].agents[0].memories.unshift('你好 🌌');
    const result = importReplay(exportReplay(history));
    expect(result[1].agents[0].memories[0]).toBe('你好 🌌');
    expect(result[1].effects[0].id).toBe('rain');
  });
  it('rejects malformed, oversized, duplicate-resident and out of bounds data', () => {
    expect(() => importReplay('bad')).toThrow('JSON');
    expect(() => importReplay(' '.repeat(5000001))).toThrow('5 MB');
    const invalid = createWorld();
    invalid.agents[0].energy = 1000;
    expect(() => importReplay(JSON.stringify({ version: 1, snapshots: [invalid] }))).toThrow(
      '格式',
    );
    invalid.agents[0].energy = 50;
    invalid.agents[1].id = 'mira';
    expect(() => importReplay(JSON.stringify({ version: 1, snapshots: [invalid] }))).toThrow();
    expect(() => importReplay('{"version":2,"snapshots":[]}')).toThrow();
  });
  it('only permits praise-for-bread exchanges while compliments are currency', () => {
    const initial = applyEvent(createWorld(), 'compliments');
    initial.agents[0].hunger = 90;
    const working = structuredClone(round);
    working.decisions[0] = { ...working.decisions[0], action: 'work', location: 'market' };
    const notBought = applyRound(initial, working);
    expect(notBought.agents[0].hunger).toBe(94);
    const praising = structuredClone(working);
    praising.decisions[0].action = 'socialize';
    praising.decisions[0].target = 'otto';
    praising.decisions[0].intent = 'praise';
    expect(applyRound(initial, praising).agents[0].hunger).toBe(66);
  });
  it('exports at most 120 snapshots', () =>
    expect(
      importReplay(exportReplay(Array.from({ length: 125 }, () => createWorld()))),
    ).toHaveLength(120));
});

describe('resident conversations', () => {
  it('keeps direct replies paired with their human message after town chatter rolls over', () => {
    let world = addHumanMessage(createWorld(), 'mira', '你好 🌌');
    const id = world.conversations[0].id;
    world = applyChatReply(
      world,
      'mira',
      { action: 'socialize', location: 'square', speech: '欢迎来到星落镇。', reason: '接待人类' },
      id,
    );
    for (let i = 0; i < 40; i++) world = applyRound(world, round);
    expect(world.feed.some((e) => e.id === id)).toBe(false);
    expect(world.conversations).toHaveLength(2);
    expect(world.conversations[1]).toMatchObject({
      role: 'model',
      replyTo: id,
      text: '欢迎来到星落镇。',
    });
    expect(importReplay(exportReplay([world]))[0].conversations).toEqual(world.conversations);
  });
  it('loads version-one replays that predate conversation history', () => {
    const { conversations: _old, ...legacy } = createWorld();
    expect(
      importReplay(JSON.stringify({ version: 1, snapshots: [legacy] }))[0].conversations,
    ).toEqual([]);
  });
});
