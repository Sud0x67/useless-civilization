import type { World } from '../shared/schema';

export function dialogueLines(world: World, previous?: World) {
  return world.feed.filter(
    (entry) =>
      entry.actor !== null &&
      (entry.source === 'model' || (entry.source === 'human' && entry.type === 'chat')) &&
      (!previous || entry.id >= previous.nextId),
  );
}

export function frameDialogue(world: World, previous?: World, selected?: string | null) {
  const lines = dialogueLines(world, previous);
  return lines.find((entry) => entry.actor === selected) ?? lines[0];
}
