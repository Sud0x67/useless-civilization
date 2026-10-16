import { useEffect, useRef } from 'react';
import type { Agent, ChatEntry } from '../shared/schema';
import { formatTime } from '../world/engine';
import { Icon } from './Icons';

export type PendingChat = {
  id: number;
  text: string;
  messageId?: number;
  author?: string;
  state: 'active' | 'waiting' | 'failed';
};
export function Conversation({
  agent,
  entries,
  pending,
  draft,
  onDraft,
  onSend,
  locked,
  full,
  visitor,
}: {
  agent: Agent;
  entries: ChatEntry[];
  pending: PendingChat[];
  draft: string;
  onDraft: (text: string) => void;
  onSend: () => void;
  locked: boolean;
  full: boolean;
  visitor?: string;
}) {
  const history = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const following = useRef(true);
  const previousAgent = useRef(agent.id);
  useEffect(() => {
    if (previousAgent.current !== agent.id) {
      following.current = true;
      previousAgent.current = agent.id;
    }
    if (history.current && following.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [agent.id, entries.length, pending.length, pending.map((p) => p.state).join(',')]);
  const label = (state: PendingChat['state']) =>
    state === 'active' ? '等待回应' : state === 'failed' ? '回应失败，可重试' : '已排队';
  return (
    <section className="conversation" aria-label={`与${agent.name}的对话`}>
      <div
        className="conversation-history"
        ref={history}
        onScroll={(e) => {
          const element = e.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 45;
        }}
      >
        {!entries.length && !pending.length && (
          <div className="conversation-empty">
            <Icon name="chat" size={25} />
            <p>和{agent.name}聊聊吧</p>
          </div>
        )}
        {entries.map((entry) => {
          const task = pending.find((p) => p.messageId === entry.id);
          const answered = entries.some((e) => e.replyTo === entry.id);
          return (
            <article key={entry.id} className={`chat-bubble ${entry.role}`}>
              <span>
                {entry.role === 'human'
                  ? entry.author
                    ? entry.author === visitor
                      ? '你 · ' + entry.author
                      : entry.author
                    : '你'
                  : agent.name}
                <time>{formatTime(entry.minute)}</time>
              </span>
              <p>{entry.text}</p>
              {entry.role === 'human' && !answered && (
                <small>{task ? label(task.state) : '暂无回复'}</small>
              )}
            </article>
          );
        })}
        {pending
          .filter((p) => p.messageId === undefined)
          .map((task) => (
            <article key={`pending-${task.id}`} className="chat-bubble human pending">
              <span>
                {task.author || '你'}
                <small>{label(task.state)}</small>
              </span>
              <p>{task.text}</p>
            </article>
          ))}
        {pending.some((p) => p.state === 'active') && (
          <p className="chat-typing" role="status">
            {agent.name}正在回应…
          </p>
        )}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!locked && !full && draft.trim()) onSend();
        }}
      >
        <label htmlFor="chat-message">对{agent.name}说句话</label>
        <div>
          <textarea
            id="chat-message"
            maxLength={300}
            aria-describedby="chat-shortcuts"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (
                e.key !== 'Enter' ||
                e.shiftKey ||
                e.nativeEvent.isComposing ||
                composing.current ||
                e.keyCode === 229
              )
                return;
              e.preventDefault();
              if (
                !e.repeat &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.metaKey &&
                !locked &&
                !full &&
                draft.trim()
              )
                e.currentTarget.form?.requestSubmit();
            }}
            disabled={locked}
            placeholder="说点什么…"
            rows={2}
          />
          <button type="submit" aria-label="发送消息" disabled={locked || full || !draft.trim()}>
            <Icon name="arrow" size={18} />
          </button>
        </div>
        <span>
          {full && '请稍后发送 · '}
          {draft.length}
          /300
        </span>
        <small className="chat-shortcuts" id="chat-shortcuts">
          Enter 发送 · Shift+Enter 换行 · 对话公开
        </small>
      </form>
    </section>
  );
}
