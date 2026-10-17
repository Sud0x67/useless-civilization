import { describe, expect, it } from 'vitest';
import { addHumanMessage, applyChatReply, applyRound, createWorld } from '../src/world/engine';
import { dialogueDuration, emptyDialogue, liveDialogue } from '../src/world/live-dialogue';
import { decision, round } from './fixture';

describe('live map dialogue', () => {
  it('rotates a new round in order without replaying the same records twice', () => {
    const world = applyRound(createWorld(), round);
    let state = liveDialogue(emptyDialogue, { type: 'observe', world, selected: null, focus: 0 });
    const seen = [];
    while (state.current) {
      seen.push(state.current.actor);
      state = liveDialogue(state, { type: 'next', id: state.current.id });
    }
    expect(seen).toEqual(round.decisions.map((line) => line.agentId));
    expect(liveDialogue(state, { type: 'observe', world, selected: null, focus: 0 })).toBe(state);
    expect(liveDialogue(state, { type: 'next', id: 123 })).toBe(state);
  });
  it('prioritizes the selected resident and their incoming human conversation', () => {
    let world = applyRound(createWorld(), round);
    let state = liveDialogue(emptyDialogue, { type: 'observe', world, selected: null, focus: 0 });
    state = liveDialogue(state, { type: 'observe', world, selected: 'echo', focus: 1 });
    expect(state.current?.actor).toBe('echo');
    world = addHumanMessage(world, 'echo', '你好，回声 👋');
    state = liveDialogue(state, { type: 'observe', world, selected: 'echo', focus: 1 });
    expect(state.current).toMatchObject({ source: 'human', text: '你好，回声 👋' });
    world = applyChatReply(world, 'echo', decision, world.conversations.at(-1)!.id);
    state = liveDialogue(state, { type: 'observe', world, selected: 'echo', focus: 1 });
    expect(state.current).toMatchObject({ source: 'model', text: decision.speech });
    world = applyRound(world, round);
    state = liveDialogue(state, { type: 'observe', world, selected: 'echo', focus: 1 });
    expect(state.current?.text).toBe(round.decisions[4].speech);
    expect(state.pending.some((line) => line.id === state.current?.id)).toBe(false);
    const next = state.pending[0];
    state = liveDialogue(state, { type: 'observe', world, selected: null, focus: 2 });
    expect(state.current).toEqual(next);
  });
  it('bounds pending dialogue and discards it on reset or entry into replay', () => {
    let world = createWorld();
    let state = emptyDialogue;
    for (let i = 0; i < 60; i++) {
      world = applyRound(world, round);
      state = liveDialogue(state, { type: 'observe', world, selected: null, focus: 0 });
    }
    expect(state.pending.length).toBeLessThanOrEqual(12);
    const arrival = liveDialogue(emptyDialogue, {
      type: 'observe',
      world,
      selected: null,
      focus: 0,
    });
    expect(arrival.pending).toHaveLength(5);
    expect(arrival.current!.id).toBeGreaterThan(world.nextId - 8);
    expect(liveDialogue(state, { type: 'clear' })).toBe(emptyDialogue);
    const reset = liveDialogue(state, {
      type: 'observe',
      world: createWorld(),
      selected: null,
      focus: 0,
    });
    expect(reset.current).toBeUndefined();
    expect(reset.pending).toEqual([]);
    expect(dialogueDuration('短句')).toBe(3000);
    expect(dialogueDuration('长'.repeat(180))).toBe(6000);
  });
  it('clears Soren priority on deselection and keeps later shared rounds in order', () => {
    const first = applyRound(createWorld(), round);
    let state = liveDialogue(emptyDialogue, {
      type: 'observe',
      world: first,
      selected: null,
      focus: 0,
    });
    state = liveDialogue(state, { type: 'observe', world: first, selected: 'soren', focus: 1 });
    expect(state.current?.actor).toBe('soren');
    state = liveDialogue(state, { type: 'observe', world: first, selected: null, focus: 2 });
    expect(state.current?.actor).toBe('otto');
    const second = applyRound(first, round);
    state = liveDialogue(state, { type: 'observe', world: second, selected: null, focus: 2 });
    const speakers = [];
    while (state.current) {
      speakers.push(state.current.actor);
      state = liveDialogue(state, { type: 'next', id: state.current.id });
    }
    expect(speakers).toEqual([
      'otto',
      'lin',
      'ada',
      'echo',
      ...round.decisions.map((line) => line.agentId),
    ]);
    expect(liveDialogue(state, { type: 'observe', world: second, selected: null, focus: 2 })).toBe(
      state,
    );
  });
});
