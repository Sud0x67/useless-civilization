import { useEffect, useState } from 'react';
import type { World } from '../shared/schema';
import { formatDay, formatTime } from '../world/engine';
import { Icon } from './Icons';

const speeds = [0.5, 1, 2, 4];
const timestamp = (world: World) => `第 ${formatDay(world.minute)} 天 ${formatTime(world.minute)}`;

export function WorldReplay({
  snapshots,
  position,
  visible,
  onSeek,
  onLive,
  onExport,
}: {
  snapshots: World[];
  position: number | null;
  visible: boolean;
  onSeek: (index: number) => void;
  onLive: () => void;
  onExport: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = snapshots.length - 1;
  const index = Math.min(position ?? last, last);
  const canReplay = last > 0;

  useEffect(() => {
    if (!playing || position === null || !visible) return;
    const timer = window.setTimeout(() => {
      const next = Math.min(position + 1, last);
      onSeek(next);
      if (next === last) setPlaying(false);
    }, 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, position, visible, last, speed, onSeek]);

  function seek(value: number) {
    setPlaying(false);
    onSeek(Math.max(0, Math.min(value, last)));
  }
  const progress = `${timestamp(snapshots[index])} · ${index + 1}/${snapshots.length}`;
  return (
    <section className="timeline" aria-label="世界回放">
      <div className="timeline-title">
        <span>
          <Icon name="history" size={14} />
          世界回放
        </span>
        <small>{snapshots.length} 个瞬间</small>
        {position !== null && (
          <button
            onClick={() => {
              setPlaying(false);
              onLive();
            }}
          >
            返回当前世界
            <Icon name="arrow" size={12} />
          </button>
        )}
      </div>
      <div className="timeline-track">
        <span title={timestamp(snapshots[0])}>
          D{formatDay(snapshots[0].minute)} {formatTime(snapshots[0].minute)}
        </span>
        <input
          type="range"
          min="0"
          max={Math.max(1, last)}
          value={index}
          disabled={!canReplay}
          aria-label="回放时间线"
          aria-valuetext={progress}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span title={timestamp(snapshots[last])}>
          D{formatDay(snapshots[last].minute)} {formatTime(snapshots[last].minute)}
        </span>
        <button className="icon-button" aria-label="导出回放" title="导出回放" onClick={onExport}>
          <Icon name="download" size={14} />
        </button>
      </div>
      <div className="replay-controls">
        <button
          className="icon-button"
          aria-label="上一帧"
          title="上一帧"
          disabled={!canReplay || index === 0}
          onClick={() => seek(index - 1)}
        >
          <Icon name="step-back" size={16} />
        </button>
        <button
          className={`icon-button replay-play ${playing ? 'active' : ''}`}
          aria-label={playing ? '暂停回放' : '播放回放'}
          title={playing ? '暂停回放' : '播放回放'}
          disabled={!canReplay}
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            if (position === null || index === last) onSeek(0);
            setPlaying(true);
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button
          className="icon-button"
          aria-label="下一帧"
          title="下一帧"
          disabled={!canReplay || index === last}
          onClick={() => seek(index + 1)}
        >
          <Icon name="step-forward" size={16} />
        </button>
        <output className="replay-progress" aria-label="回放进度" aria-live="off">
          {progress}
        </output>
        <select
          aria-label="回放倍速"
          title="1× 每秒播放一个瞬间"
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
        >
          {speeds.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
