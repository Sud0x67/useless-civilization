import { useEffect, useReducer, type CSSProperties } from 'react';
import type { FeedItem, World } from '../shared/schema';
import { dialogueDuration, emptyDialogue, liveDialogue } from '../world/live-dialogue';

export function MapDialogue({
  world,
  selected,
  focus,
  replaying,
  replayLine,
  running,
  visible,
}: {
  world: World;
  selected: string | null;
  focus: number;
  replaying: boolean;
  replayLine?: FeedItem;
  running: boolean;
  visible: boolean;
}) {
  const [state, dispatch] = useReducer(liveDialogue, emptyDialogue);
  useEffect(() => {
    dispatch(replaying ? { type: 'clear' } : { type: 'observe', world, selected, focus });
  }, [world, selected, focus, replaying]);
  useEffect(() => {
    if (replaying || !running || !visible || !state.current) return;
    const line = state.current;
    const timer = window.setTimeout(
      () => dispatch({ type: 'next', id: line.id }),
      dialogueDuration(line.text),
    );
    return () => window.clearTimeout(timer);
  }, [state.current, state.focus, replaying, running, visible]);
  const line = replaying ? replayLine : state.current;
  const speaker = world.agents.find((agent) => agent.id === line?.actor);
  if (!line || !speaker) return null;
  return (
    <div
      key={`${replaying ? 'replay' : 'live'}-${line.id}`}
      className="speech-preview"
      aria-label="地图对白"
      data-line-id={line.id}
      style={{ '--agent': speaker.color } as CSSProperties}
    >
      <span className="speech-name">
        {line.source === 'human'
          ? `${line.author || '人类观察员'} → ${speaker.name}`
          : speaker.name}
        <small>{line.source === 'human' ? '访客' : 'AI'}</small>
      </span>
      <p>“{line.text}”</p>
    </div>
  );
}
