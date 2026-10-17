import type { FeedItem, World } from '../shared/schema';
import { dialogueLines } from './replay-dialogue';

export type LiveDialogue = {
  current?: FeedItem;
  pending: FeedItem[];
  seen: number | null;
  seed: number | null;
  focus: number;
  started: boolean;
};
export const emptyDialogue: LiveDialogue = {
  pending: [],
  seen: null,
  seed: null,
  focus: 0,
  started: false,
};
type Action =
  | { type: 'observe'; world: World; selected: string | null; focus: number }
  | { type: 'next'; id: number }
  | { type: 'clear' };

export function liveDialogue(state: LiveDialogue, action: Action): LiveDialogue {
  if (action.type === 'clear') return emptyDialogue;
  if (action.type === 'next') {
    if (state.current?.id !== action.id) return state;
    return { ...state, current: state.pending[0], pending: state.pending.slice(1) };
  }
  const { world, selected, focus } = action;
  const reset = state.seen === null || state.seed !== world.seed || world.nextId < state.seen;
  if (!reset && state.seen === world.nextId && state.focus === focus) return state;
  const all = dialogueLines(world);
  let incoming = all.filter((line) => reset || line.id >= state.seen!).reverse();
  // On arrival, show the most recent round rather than replaying the entire feed.
  const started = !reset && state.started;
  if (!started) incoming = incoming.slice(-6);
  let current = reset ? undefined : state.current;
  let pending = [
    ...(reset ? [] : state.pending),
    ...incoming.filter((line) => line.id !== current?.id),
  ];
  const priority = selected
    ? focus !== state.focus
      ? all.find((line) => line.actor === selected)
      : [...incoming].reverse().find((line) => line.actor === selected)
    : undefined;
  if (priority) {
    current = priority;
    pending = pending.filter((line) => line.id !== priority.id);
  }
  if (!selected && focus !== state.focus && !reset) current = pending.shift();
  if (!current) current = pending.shift();
  return {
    current,
    pending: pending.slice(-12),
    seen: world.nextId,
    seed: world.seed,
    focus,
    started: started || incoming.length > 0,
  };
}

export const dialogueDuration = (text: string) =>
  Math.min(6000, Math.max(3000, [...text].length * 80));
