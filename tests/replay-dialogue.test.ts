import { describe, expect, it } from 'vitest';
import { frameDialogues } from '../src/world/replay-dialogue';
import {
  addHumanMessage,
  applyChatReply,
  applyEvent,
  applyRound,
  createWorld,
} from '../src/world/engine';
import { decision, round } from './fixture';

const frameDialogue = (...args: Parameters<typeof frameDialogues>) => frameDialogues(...args)[0];

describe('map dialogue during replay', () => {
  it('shows recorded speech without selecting a resident and follows the current speaker', () => {
    const initial = createWorld();
    const first = applyRound(initial, round);
    expect(frameDialogue(first, initial)?.source).toBe('model');
    expect(frameDialogue(first, initial, 'mira')?.text).toBe(round.decisions[0].speech);
    const reply = applyChatReply(first, 'otto', { ...decision, speech: '这是奥托的新回复 👋' }, 0);
    expect(frameDialogue(reply, first, 'mira')).toMatchObject({
      actor: 'otto',
      text: '这是奥托的新回复 👋',
    });
    expect(frameDialogue(reply, first)?.text).toBe('这是奥托的新回复 👋');
  });
  it('plays every resident in chronological order and removes selection priority on cancellation', () => {
    const initial = createWorld();
    const first = applyRound(initial, round);
    expect(frameDialogues(first, initial).map((line) => line.actor)).toEqual(
      round.decisions.map((line) => line.agentId),
    );
    const focused = frameDialogues(first, initial, 'soren');
    expect(focused[0].actor).toBe('soren');
    expect(new Set(focused.map((line) => line.id)).size).toBe(6);
    expect(frameDialogues(first, initial, null)[0].actor).toBe('mira');
    const second = applyRound(first, round);
    expect(frameDialogues(second)).toHaveLength(6);
    expect(frameDialogues(second).every((line) => line.id >= first.nextId)).toBe(true);
  });
  it('shows human input and its recorded reply in their own frames without stale resident speech', () => {
    const first = applyRound(createWorld(), round);
    const human = addHumanMessage(first, 'mira', '你好，镇长');
    expect(frameDialogue(human, first, 'mira')).toMatchObject({
      source: 'human',
      text: '你好，镇长',
    });
    const reply = applyChatReply(human, 'mira', decision, human.conversations.at(-1)!.id);
    expect(frameDialogue(reply, human)).toMatchObject({ source: 'model', text: decision.speech });
  });
  it('does not fabricate dialogue for initial, unchanged or event-only frames', () => {
    const initial = createWorld();
    expect(frameDialogue(initial)).toBeUndefined();
    const first = applyRound(initial, round);
    expect(frameDialogue(first, first, 'mira')).toBeUndefined();
    expect(frameDialogue(applyEvent(first, 'rain'), first, 'mira')).toBeUndefined();
  });
});
