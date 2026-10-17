import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, World } from '../shared/schema';
import { FEED_LIMIT } from '../shared/schema';
import { formatTime, places } from '../world/engine';
import { Icon } from './Icons';

export function ActivityFeed({
  world,
  busy,
  avatar,
}: {
  world: World;
  busy: boolean;
  avatar: (agent: Agent) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const newest = world.feed[0]?.id ?? 0;
  const latest = useRef(newest);
  latest.current = newest;
  const lastRead = useRef(newest);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const unread = world.feed.filter((item) => item.id > lastRead.current).length;
  const align = useCallback(() => {
    const element = list.current;
    if (!element) return;
    if (followingRef.current) {
      element.scrollTop = element.scrollHeight;
      lastRead.current = latest.current;
    } else if (anchor.current) {
      const row = element.querySelector<HTMLElement>(`[data-feed-id="${anchor.current.id}"]`);
      if (row)
        element.scrollTop +=
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          anchor.current.offset;
      else element.scrollTop = 0;
    }
  }, []);
  useLayoutEffect(align, [world.feed, following, align]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(align);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [align]);
  function onScroll() {
    const element = list.current!;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    followingRef.current = bottom;
    if (bottom) {
      lastRead.current = latest.current;
      anchor.current = null;
    } else {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('[data-feed-id]')].find(
        (item) => item.getBoundingClientRect().bottom > top + 1,
      );
      if (row)
        anchor.current = { id: row.dataset.feedId!, offset: row.getBoundingClientRect().top - top };
    }
    setFollowing(bottom);
  }
  return (
    <>
      <div className="feed-intro">
        <span className="tiny-dot" />
        小镇里发生的那些小事
        <span>最新 {FEED_LIMIT} 条</span>
      </div>
      <div
        className="feed-list"
        ref={list}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label="小镇动态时间线"
      >
        {[...world.feed].reverse().map((item) => {
          const actor = world.agents.find((a) => a.id === item.actor);
          return (
            <article
              key={item.id}
              data-feed-id={item.id}
              className={`feed-item ${item.type === 'event' ? 'event-feed' : ''}`}
            >
              <div className="feed-icon">
                {actor && item.source === 'model' ? (
                  avatar(actor)
                ) : (
                  <Icon name={item.source === 'human' ? 'spark' : 'cube'} size={17} />
                )}
              </div>
              <div className="feed-body">
                <div className="feed-meta">
                  <strong>
                    {item.source === 'human'
                      ? item.type === 'chat'
                        ? `${item.author || '你'} → ${actor?.name}`
                        : item.author || '人类观察员'
                      : actor?.name || '世界旁白'}
                  </strong>
                  {item.source === 'model' && <span className="model-tag">AI</span>}
                  <time>{formatTime(item.minute)}</time>
                </div>
                <p>{item.text}</p>
                {item.source === 'model' && actor && (
                  <small className="feed-place">
                    <Icon name="map" size={10} />
                    {places[actor.location].name}
                  </small>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <button
        className="follow-toggle"
        disabled={following}
        onClick={() => {
          followingRef.current = true;
          anchor.current = null;
          setFollowing(true);
          align();
        }}
      >
        <Icon name={following ? 'check' : 'arrow'} size={13} />
        {following
          ? '正在跟随最新动态'
          : unread > 0
            ? `回到最新（${unread} 条新动态）`
            : '回到最新'}
      </button>
      {following && (
        <span className="sr-only" role="status">
          {world.feed[0]?.text}
        </span>
      )}
    </>
  );
}
