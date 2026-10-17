import type { World } from '../shared/schema';

export function dialogueLines(world: World, previous?: World) {
  return world.feed.filter(
    (entry) =>
      entry.actor !== null &&
      (entry.source === 'model' || (entry.source === 'human' && entry.type === 'chat')) &&
      (!previous || entry.id >= previous.nextId),
  );
}

export function frameDialogues(world: World, previous?: World, selected?: string | null) {
  const recorded = dialogueLines(world, previous);
  // The first retained snapshot has no boundary: show its latest round, not the entire feed.
  const lines = (previous ? recorded : recorded.slice(0, 6)).reverse();
  if (!selected) return lines;
  return [
    ...lines.filter((entry) => entry.actor === selected),
    ...lines.filter((entry) => entry.actor !== selected),
  ];
}
