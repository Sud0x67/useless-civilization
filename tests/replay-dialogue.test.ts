import { describe, expect, it } from 'vitest';
import { frameDialogue } from '../src/world/replay-dialogue';
import {
  addHumanMessage,
  applyChatReply,
  applyEvent,
  applyRound,
  createWorld,
} from '../src/world/engine';
import { decision, round } from './fixture';

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
    expect(frameDialogue(reply)?.text).toBe('这是奥托的新回复 👋');
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
