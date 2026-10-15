import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Town, type CameraControls } from './components/Town';
import { Icon } from './components/Icons';
import { DecisionSchema, RoundSchema, type Agent, type World } from './shared/schema';
import {
  addHumanMessage,
  applyDecision,
  applyEvent,
  applyRound,
  createWorld,
  events,
  exportReplay,
  formatDay,
  formatTime,
  importReplay,
  joinWorld,
  places,
  type AgentId,
  type EventId,
} from './world/engine';

type Status = { configured: boolean; model: string | null; wireApi: string };
type Modal = 'events' | 'settings' | 'reset' | null;
const intervals = { '20s': 20000, '12s': 12000, '8s': 8000 };
function Avatar({ agent, small = false }: { agent: Agent; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? 'small' : ''}`}
      style={{ '--agent': agent.color } as CSSProperties}
    >
      <span className="avatar-hair" />
      <span className="avatar-face">
        <i />
        <i />
      </span>
      <span className="avatar-shirt" />
    </span>
  );
}
function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  active,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );
}
function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">OBSERVER CONSOLE</span>
          <h2 id="modal-title">{title}</h2>
          <p>{subtitle}</p>
        </div>
        <ToolButton label="关闭弹窗" icon="close" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [world, setWorld] = useState(createWorld);
  const worldRef = useRef(world);
  const [snapshots, setSnapshots] = useState<World[]>([world]);
  const snapshotsRef = useRef(snapshots);
  const [replay, setReplay] = useState<number | null>(null);
  const replayRef = useRef<number | null>(null);
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [panel, setPanel] = useState<'feed' | 'resident'>('feed');
  const [status, setStatus] = useState<Status | null>(null);
  const [paused, setPaused] = useState(
    () => new URLSearchParams(location.search).get('paused') === '1',
  );
  const pausedRef = useRef(paused);
  const [visible, setVisible] = useState(!document.hidden);
  const [speed, setSpeed] = useState<keyof typeof intervals>('20s');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<'round' | 'chat'>('round');
  const [message, setMessage] = useState('');
  const lastChat = useRef<{ id: AgentId; message: string } | null>(null);
  const [usage, setUsage] = useState({ calls: 0, input: 0, output: 0 });
  const [modal, setModal] = useState<Modal>(null);
  const [night, setNight] = useState(true);
  const [notice, setNotice] = useState('');
  const [sound, setSound] = useState(false);
  const [following, setFollowing] = useState(true);
  const feedList = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const idleSince = useRef(Date.now());
  const camera = useRef<CameraControls>(null);
  const file = useRef<HTMLInputElement>(null);
  const firstRound = useRef(false);

  const commit = useCallback((next: World) => {
    worldRef.current = next;
    setWorld(next);
    const history = [...snapshotsRef.current, next].slice(-120);
    snapshotsRef.current = history;
    setSnapshots(history);
  }, []);
  const pause = useCallback((value: boolean) => {
    pausedRef.current = value;
    setPaused(value);
    idleSince.current = Date.now();
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    busyRef.current = false;
    setBusy(false);
  }, []);
  const select = useCallback((id: AgentId) => {
    setSelected(id);
    setPanel('resident');
    idleSince.current = Date.now();
  }, []);

  const run = useCallback(
    async (chat?: { id: AgentId; message: string }, retry = false) => {
      if (busyRef.current || replayRef.current !== null || !status?.configured || document.hidden)
        return;
      const token = ++generation.current;
      const abort = new AbortController();
      controller.current = abort;
      busyRef.current = true;
      setBusy(true);
      setError('');
      setFailed(chat ? 'chat' : 'round');
      let current = worldRef.current;
      if (chat) {
        lastChat.current = chat;
        if (!retry) {
          current = addHumanMessage(current, chat.id, chat.message);
          commit(current);
        }
      }
      try {
        const response = await fetch(chat ? '/api/decide' : '/api/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            world: current,
            ...(chat ? { agentId: chat.id, prompt: chat.message } : {}),
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
        if (token !== generation.current) return;
        const validated = chat
          ? DecisionSchema.safeParse(result.decision)
          : RoundSchema.safeParse(result.round);
        if (!validated.success) throw new Error('模型没有返回完整、有效的决策，请重试。');
        const next = chat
          ? applyDecision(current, chat.id, DecisionSchema.parse(validated.data))
          : applyRound(current, RoundSchema.parse(validated.data));
        commit(next);
        setUsage((old) => ({
          calls: old.calls + 1,
          input: old.input + Math.max(0, Number(result.usage?.input) || 0),
          output: old.output + Math.max(0, Number(result.usage?.output) || 0),
        }));
        if (chat) {
          setMessage('');
          if (sound && 'speechSynthesis' in window) {
            const speech = new SpeechSynthesisUtterance(
              next.agents.find((a) => a.id === chat.id)!.speech,
            );
            speech.lang = 'zh-CN';
            window.speechSynthesis.speak(speech);
          }
        }
      } catch (e) {
        if (token === generation.current && !abort.signal.aborted) {
          setError(e instanceof Error ? e.message : '请求失败，请重试。');
          pause(true);
        }
      } finally {
        if (token === generation.current) {
          busyRef.current = false;
          setBusy(false);
          controller.current = null;
        }
      }
    },
    [status, commit, pause, sound],
  );

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/status', { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data: Status) => {
        setStatus(data);
        if (!data.configured) {
          setError('尚未配置模型。请填写服务器 .env 后重启。');
          pause(true);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError('无法连接本地服务器，请检查服务是否运行。');
          pause(true);
        }
      });
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) {
        cancel();
      }
      idleSince.current = Date.now();
    };
    const active = () => {
      idleSince.current = Date.now();
    };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('pointerdown', active);
    document.addEventListener('keydown', active);
    return () => {
      abort.abort();
      cancel();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('pointerdown', active);
      document.removeEventListener('keydown', active);
      window.speechSynthesis?.cancel();
    };
  }, [cancel, pause]);
  useEffect(() => {
    if (status?.configured && !firstRound.current && visible && replay === null && !paused) {
      firstRound.current = true;
      void run();
    }
  }, [status, visible, replay, paused, run]);
  useEffect(() => {
    if (!status?.configured || paused || !visible || replay !== null || modal) return;
    const interval = setInterval(() => {
      if (Date.now() - idleSince.current > 600000) {
        pause(true);
        setNotice('已观察 10 分钟，自动暂停。继续时再调用模型。');
        return;
      }
      void run();
    }, intervals[speed]);
    return () => clearInterval(interval);
  }, [status, paused, visible, replay, modal, speed, run, pause]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (following && feedList.current) feedList.current.scrollTop = 0;
  }, [following, world, replay, panel]);

  const view = replay === null ? world : snapshots[replay] || world;
  const agent = view.agents.find((a) => a.id === selected) || null;
  const disabled = busy || replay !== null || !status?.configured;
  function enterReplay(index: number) {
    cancel();
    pause(true);
    replayRef.current = index;
    setReplay(index);
  }
  function leaveReplay() {
    replayRef.current = null;
    setReplay(null);
    setNotice('已返回当前世界，点击播放继续。');
  }
  function event(id: EventId) {
    if (disabled) return;
    commit(applyEvent(worldRef.current, id));
    setModal(null);
    setNotice('事件已投放，下一轮由模型决定居民的反应。');
  }
  function download() {
    const blob = new Blob([exportReplay(snapshotsRef.current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `starfall-day${formatDay(world.minute)}-${world.tick}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('回放已导出，不包含模型配置或密钥。');
  }
  async function upload(input: File | undefined) {
    if (!input) return;
    try {
      if (input.size > 5000000) throw new Error('回放文件不能超过 5 MB。');
      const history = importReplay(await input.text());
      cancel();
      pause(true);
      snapshotsRef.current = history;
      setSnapshots(history);
      const last = history.at(-1)!;
      worldRef.current = last;
      setWorld(last);
      replayRef.current = 0;
      setReplay(0);
      setModal(null);
      setError('');
      setNotice('回放已导入，自动运行已暂停。返回当前世界后可以继续。');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '无法导入回放。');
    } finally {
      if (file.current) file.current.value = '';
    }
  }
  function reset() {
    cancel();
    pause(true);
    const next = createWorld();
    worldRef.current = next;
    setWorld(next);
    snapshotsRef.current = [next];
    setSnapshots([next]);
    replayRef.current = null;
    setReplay(null);
    setError('');
    setModal(null);
    setNotice('世界已重置。点击播放，等待模型为居民做出第一轮决定。');
  }
  const stateLabel =
    replay !== null
      ? '正在回放'
      : busy
        ? '居民思考中'
        : !visible
          ? '页面已休眠'
          : paused
            ? '观察已暂停'
            : '世界运行中';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="无用文明首页">
          <span className="brand-mark">
            <Icon name="cube" size={26} />
          </span>
          <span>
            <strong>
              无用文明<span className="beta">LAB</span>
            </strong>
            <small>USELESS CIVILIZATION</small>
          </span>
        </a>
        <div className="top-center">
          <span
            className={`status-dot ${busy ? 'thinking' : paused || replay !== null ? 'off' : ''}`}
          />
          <span>{stateLabel}</span>
          <span className="divider" />
          <span className="clock">
            <Icon name="clock" size={14} /> DAY {String(formatDay(view.minute)).padStart(2, '0')}
            <b>{formatTime(view.minute)}</b>
          </span>
        </div>
        <div className="top-actions">
          <span className="model-badge">
            <Icon name="spark" size={13} />
            <span>{status?.model || '连接模型中'}</span>
          </span>
          <ToolButton label="世界设置" icon="settings" onClick={() => setModal('settings')} />
        </div>
      </header>

      <main className="workspace">
        <aside className="residents-panel">
          <div className="panel-heading">
            <h2>
              <Icon name="people" size={16} />
              小镇居民
            </h2>
            <span className="count">06</span>
          </div>
          <p className="panel-caption">各有想法，暂时住在一起。</p>
          <div className="residents-list">
            {view.agents.map((a) => (
              <button
                key={a.id}
                className={`resident-card ${selected === a.id ? 'selected' : ''}`}
                onClick={() => select(a.id)}
                aria-label={`选择居民${a.name}`}
                aria-pressed={selected === a.id}
              >
                <Avatar agent={a} />
                <span className="resident-info">
                  <span className="resident-name">
                    {a.name}
                    <small>{a.role}</small>
                    {view.mayor === a.id && <Icon name="crown" size={12} />}
                  </span>
                  <span className="activity">
                    {view.tick === 0 && !a.speech ? '等待第一轮模型决策' : a.activity}
                  </span>
                  <span className="resident-location">
                    <span style={{ background: a.color }} />
                    {places[a.location].name}
                  </span>
                </span>
                <Icon name="arrow" size={13} />
              </button>
            ))}
          </div>
          <div className="observer-note">
            <span className="eyebrow">A SMALL SOCIAL EXPERIMENT</span>
            <p>
              他们认真生活。
              <br />
              你负责偶尔添点乱。
            </p>
            <span className="note-orbit">
              <Icon name="spark" size={38} />
            </span>
          </div>
          <div className="sidebar-footer">
            <span className="tiny-dot" />6 位 AI 居民 · {view.human ? '1 位人类' : '0 位人类'}
          </div>
        </aside>

        <section className="world-column" aria-label="小镇观察台">
          <div className="world-stage">
            <div className="stage-header">
              <div>
                <span className="eyebrow">WORLD 001 / STARFALL</span>
                <h1>
                  星落镇<span className="live-pill">{replay !== null ? 'REPLAY' : 'LIVE'}</span>
                </h1>
                <p>一个不太有用，但正在发生的世界。</p>
              </div>
              <button className="subtle-button" onClick={() => setModal('settings')}>
                <Icon name="info" size={15} />
                <span>观察指南</span>
              </button>
            </div>
            <div className={`scene ${night ? 'night' : 'day'}`}>
              <div className="scene-halo" />
              <Town
                world={view}
                selected={selected}
                onSelect={select}
                night={night}
                controlsRef={camera}
              />
              {agent?.speech && (
                <div className="speech-preview" style={{ '--agent': agent.color } as CSSProperties}>
                  <span className="speech-name">
                    {agent.name}
                    <small>MODEL</small>
                  </span>
                  <p>“{agent.speech}”</p>
                </div>
              )}
              <div className="scene-caption">
                <span className="tiny-dot" />
                {view.effects.length ? '世界正在经历一点小变化' : '风很轻，一切皆有可能'}
              </div>
              <div className="camera-tools">
                <ToolButton label="放大地图" icon="plus" onClick={() => camera.current?.zoom(1)} />
                <ToolButton
                  label="缩小地图"
                  icon="minus"
                  onClick={() => camera.current?.zoom(-1)}
                />
                <ToolButton label="重置视角" icon="map" onClick={() => camera.current?.reset()} />
                <span />
                <ToolButton
                  label={night ? '切换白天灯光' : '切换夜晚灯光'}
                  icon={night ? 'moon' : 'sun'}
                  onClick={() => setNight(!night)}
                />
              </div>
              <div className="scene-instruction">拖动旋转 · 滚轮缩放 · 点击居民</div>
            </div>
            {view.effects.length > 0 && (
              <div className="effects-row">
                {view.effects.map((e) => {
                  const data = events.find((x) => x.id === e.id)!;
                  return (
                    <span key={e.id} style={{ '--effect': data.color } as CSSProperties}>
                      <Icon name={data.icon} size={13} />
                      {data.title}
                      <small>{Math.max(0, Math.ceil((e.until - view.minute) / 15))} 轮</small>
                    </span>
                  );
                })}
              </div>
            )}
            <div className="world-metrics">
              <div>
                <span>
                  <Icon name="bread" size={16} />
                  食物储备
                </span>
                <strong>
                  {Math.round(view.food)}
                  <small>/ 200</small>
                </strong>
                <div className="metric-line">
                  <i style={{ width: `${view.food / 2}%`, background: '#e4bb82' }} />
                </div>
              </div>
              <div>
                <span>
                  <Icon name="heart" size={16} />
                  小镇和谐
                </span>
                <strong>
                  {Math.round(view.harmony)}
                  <small>%</small>
                </strong>
                <div className="metric-line">
                  <i style={{ width: `${view.harmony}%`, background: '#86c5ad' }} />
                </div>
              </div>
              <div>
                <span>
                  <Icon name="bolt" size={16} />
                  混乱指数
                </span>
                <strong>
                  {Math.round(view.chaos)}
                  <small>%</small>
                </strong>
                <div className="metric-line">
                  <i style={{ width: `${view.chaos}%`, background: '#b49bdb' }} />
                </div>
              </div>
            </div>
          </div>
          <div className="control-deck">
            <div className="playback">
              <button
                className={`play-button ${paused ? 'is-paused' : ''}`}
                aria-label={paused ? '开始观察' : '暂停观察'}
                disabled={!status?.configured || replay !== null}
                onClick={() => pause(!paused)}
              >
                <Icon name={paused ? 'play' : 'pause'} size={17} />
              </button>
              <ToolButton
                label="运行一轮"
                icon="skip"
                disabled={disabled}
                onClick={() => {
                  pause(true);
                  void run();
                }}
              />
              <span className="deck-divider" />
              <div className="speed-switch" aria-label="运行间隔">
                {(Object.keys(intervals) as (keyof typeof intervals)[]).map((s) => (
                  <button
                    key={s}
                    className={speed === s ? 'active' : ''}
                    onClick={() => setSpeed(s)}
                    aria-pressed={speed === s}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <span className="round-label">第 {view.tick} 轮</span>
            </div>
            <div className="deck-actions">
              <button
                className="secondary-button join-button"
                disabled={disabled || view.human}
                onClick={() => {
                  commit(joinWorld(worldRef.current));
                  setNotice('你已出现在星落广场。选择一位居民，和 TA 说句话。');
                }}
              >
                <Icon name={view.human ? 'check' : 'people'} size={16} />
                {view.human ? '已加入小镇' : '作为人类加入'}
              </button>
              <button
                className="primary-button"
                disabled={disabled}
                onClick={() => setModal('events')}
              >
                <Icon name="spark" size={16} />
                投放事件
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="info" size={17} />
              <span>
                {error}
                <small>世界状态已保留，未使用预设对白。</small>
              </span>
              <button
                onClick={() => {
                  if (!status?.configured) {
                    setModal('settings');
                    return;
                  }
                  void run(failed === 'chat' ? lastChat.current || undefined : undefined, true);
                }}
                disabled={busy}
              >
                {status?.configured ? '重试' : '查看配置'}
                <Icon name="refresh" size={13} />
              </button>
            </div>
          )}
          <div className="timeline">
            <div className="timeline-title">
              <span>
                <Icon name="history" size={14} />
                世界回放
              </span>
              <small>{snapshots.length} 个瞬间 · 仅保存在内存</small>
              {replay !== null && (
                <button onClick={leaveReplay}>
                  返回当前世界
                  <Icon name="arrow" size={12} />
                </button>
              )}
            </div>
            <div className="timeline-track">
              <span>{formatTime(snapshots[0].minute)}</span>
              <input
                type="range"
                min="0"
                max={Math.max(1, snapshots.length - 1)}
                value={replay ?? snapshots.length - 1}
                disabled={snapshots.length < 2}
                aria-label="回放时间线"
                onChange={(e) =>
                  enterReplay(Math.min(Number(e.target.value), snapshots.length - 1))
                }
              />
              <span>{formatTime(snapshots.at(-1)!.minute)}</span>
              <ToolButton label="导出回放" icon="download" onClick={download} />
            </div>
          </div>
          <div className="world-footnote">
            <span>
              <Icon name="spark" size={12} />
              居民的每次决定，来自真实模型。
            </span>
            <span>
              {busy
                ? '正在等待模型响应…'
                : paused
                  ? '点击播放继续观察'
                  : `每 ${intervals[speed] / 1000} 秒尝试一轮 · 每轮 15 分钟`}
            </span>
          </div>
        </section>

        <aside className="activity-panel">
          <div className="panel-tabs">
            <button className={panel === 'feed' ? 'active' : ''} onClick={() => setPanel('feed')}>
              <Icon name="bolt" size={15} />
              小镇动态<span>{view.feed.length}</span>
            </button>
            <button
              className={panel === 'resident' ? 'active' : ''}
              onClick={() => setPanel('resident')}
            >
              <Icon name="people" size={15} />
              居民档案
            </button>
          </div>
          {panel === 'feed' ? (
            <>
              <div className="feed-intro">
                <span className="tiny-dot" />
                {busy ? '模型正在为六位居民做决定' : '小镇里发生的那些小事'}
                <span>最新在上</span>
              </div>
              <div className="feed-list" ref={feedList}>
                {view.feed.map((item) => {
                  const actor = view.agents.find((a) => a.id === item.actor);
                  return (
                    <article
                      key={item.id}
                      className={`feed-item ${item.type === 'event' ? 'event-feed' : ''}`}
                    >
                      <div className="feed-icon">
                        {actor && item.source === 'model' ? (
                          <Avatar agent={actor} small />
                        ) : (
                          <Icon name={item.source === 'human' ? 'spark' : 'cube'} size={17} />
                        )}
                      </div>
                      <div className="feed-body">
                        <div className="feed-meta">
                          <strong>
                            {item.source === 'human'
                              ? item.type === 'chat'
                                ? `你 → ${actor?.name}`
                                : '人类观察员'
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
                onClick={() => setFollowing(!following)}
                aria-pressed={following}
              >
                <Icon name={following ? 'check' : 'target'} size={13} />
                {following ? '正在跟随最新动态' : '跟随最新动态'}
              </button>
              {following && (
                <span className="sr-only" role="status">
                  {view.feed[0]?.text}
                </span>
              )}
            </>
          ) : agent ? (
            <div className="profile-panel">
              <div className="profile-hero">
                <Avatar agent={agent} />
                <div>
                  <h2>
                    {agent.name}
                    <span>{agent.role}</span>
                  </h2>
                  <p>
                    <span style={{ background: agent.color }} />
                    {places[agent.location].name}
                  </p>
                </div>
              </div>
              <p className="personality">{agent.personality}</p>
              <div className="goal-card">
                <span>
                  <Icon name="target" size={13} />
                  当前人生目标
                </span>
                <p>{agent.goal}</p>
              </div>
              <div className="needs-grid">
                {[
                  { label: '精力', value: agent.energy, color: '#8ccbb7' },
                  { label: '快乐', value: agent.happiness, color: '#d7b47e' },
                  { label: '饥饿', value: agent.hunger, color: '#d99a9d' },
                ].map((n) => (
                  <div key={n.label}>
                    <span>
                      {n.label}
                      <b>{Math.round(n.value)}</b>
                    </span>
                    <i>
                      <em style={{ width: `${n.value}%`, background: n.color }} />
                    </i>
                  </div>
                ))}
              </div>
              <div className="profile-numbers">
                <span>
                  金币 <b>{agent.coins}</b>
                </span>
                <span>
                  影响力 <b>{Math.round(agent.influence)}</b>
                </span>
              </div>
              <h3>
                最近的记忆<small>{agent.memories.length} / 12</small>
              </h3>
              <div className="memories">
                {agent.memories.slice(0, 4).map((m, i) => (
                  <p key={i}>
                    <i />
                    {m}
                  </p>
                ))}
              </div>
              <h3>居民关系</h3>
              <div className="relationships">
                {view.agents
                  .filter((a) => a.id !== agent.id)
                  .map((a) => (
                    <button key={a.id} onClick={() => select(a.id)}>
                      <span style={{ background: a.color }} />
                      {a.name}
                      <b>
                        {agent.relationships[a.id] > 0 ? '+' : ''}
                        {agent.relationships[a.id]}
                      </b>
                    </button>
                  ))}
              </div>
              <form
                className="chat-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (message.trim() && !disabled)
                    void run({ id: agent.id, message: message.trim() });
                }}
              >
                <label htmlFor="chat-message">对{agent.name}说句话</label>
                <div>
                  <textarea
                    id="chat-message"
                    maxLength={300}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={disabled}
                    placeholder="比如：你对镇长有什么看法？"
                    rows={2}
                  />
                  <button
                    type="submit"
                    aria-label="发送消息"
                    disabled={disabled || !message.trim()}
                  >
                    <Icon name="arrow" size={18} />
                  </button>
                </div>
                <span>模型回应 · {message.length}/300</span>
              </form>
            </div>
          ) : (
            <div className="empty-profile">
              <Icon name="people" size={34} />
              <h3>每个人都有自己的故事</h3>
              <p>
                点击地图或左侧的居民，
                <br />
                看看 TA 正在想什么。
              </p>
            </div>
          )}
        </aside>
      </main>
      <footer className="bottom-bar">
        <span>
          useless-llm.com<span className="bottom-slash">/</span>一个关于 AI 和人类的无用实验
        </span>
        <span>
          无脚本对白
          <span className="tiny-dot" />
          {usage.calls} 次调用
          <span className="tiny-dot" />
          {(usage.input + usage.output).toLocaleString()} tokens
        </span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Icon name="info" size={16} />
          {notice}
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="导入回放文件"
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {modal === 'events' && (
        <ModalShell
          title="给小镇一点意外。"
          subtitle="改变世界的条件。至于如何回应，交给居民自己决定。"
          onClose={() => setModal(null)}
        >
          <div className="events-grid">
            {events.map((e) => (
              <button
                key={e.id}
                className="event-card"
                disabled={disabled}
                onClick={() => event(e.id)}
                style={{ '--effect': e.color } as CSSProperties}
              >
                <span className="event-card-icon">
                  <Icon name={e.icon} size={24} />
                </span>
                <small>{e.label}</small>
                <h3>
                  {e.title}
                  <Icon name="arrow" size={15} />
                </h3>
                <p>{e.description}</p>
                <span className="event-duration">
                  <Icon name="clock" size={11} />
                  {e.duration}
                </span>
              </button>
            ))}
          </div>
          <p className="modal-footnote">
            事件修改环境与资源；居民的行动和对白均由模型生成。暂停时可点击「运行一轮」观察反应。
          </p>
        </ModalShell>
      )}
      {modal === 'settings' && (
        <ModalShell
          title="观察这个小小的世界。"
          subtitle="六个人，各自认真地做一些有用或没用的事。"
          onClose={() => setModal(null)}
        >
          <div className="guide-grid">
            <div>
              <Icon name="map" />
              <h3>四处看看</h3>
              <p>拖动旋转地图，滚轮缩放。点击居民查看目标、记忆和关系。</p>
            </div>
            <div>
              <Icon name="spark" />
              <h3>制造一点意外</h3>
              <p>投放事件改变环境，再让模型决定居民的下一步。你也可以直接和 TA 对话。</p>
            </div>
          </div>
          <div className="settings-model">
            <span className="eyebrow">MODEL CONNECTION</span>
            <h3>
              <span className={`status-dot ${status?.configured ? '' : 'off'}`} />
              {status?.model || '模型未配置'}
            </h3>
            <p>
              {status?.wireApi || 'responses'} API ·
              每轮一个请求，为六位居民共同决策。失败会暂停，不生成替代对白。
            </p>
            {!status?.configured && (
              <p>
                在项目根目录的 <code>.env</code> 中设置 <code>LLM_BASE_URL</code>、
                <code>LLM_MODEL</code>、<code>LLM_API_KEY</code>，然后重启 <code>npm run dev</code>
                。
              </p>
            )}
            <small>
              密钥仅留在本地服务器。页面隐藏或观察 10 分钟无操作时停止调用。回放期间不调用模型。
            </small>
          </div>
          <div className="settings-row">
            <span>
              <strong>朗读对话回复</strong>
              <small>使用浏览器内置语音，默认关闭</small>
            </span>
            <button
              className={`toggle ${sound ? 'on' : ''}`}
              role="switch"
              aria-checked={sound}
              aria-label="朗读对话回复"
              disabled={!('speechSynthesis' in window)}
              onClick={() => {
                setSound(!sound);
                window.speechSynthesis?.cancel();
              }}
            >
              <i />
            </button>
          </div>
          <div className="settings-buttons">
            <button className="secondary-button" onClick={download}>
              <Icon name="download" size={15} />
              导出回放
            </button>
            <button className="secondary-button" onClick={() => file.current?.click()}>
              <Icon name="upload" size={15} />
              导入回放
            </button>
            <button className="danger-button" onClick={() => setModal('reset')}>
              <Icon name="refresh" size={15} />
              重置世界
            </button>
          </div>
          <p className="modal-footnote">
            世界只保存在本页内存，刷新后重新开始。请导出回放以保存进展。此预览尚未绑定域名。
          </p>
        </ModalShell>
      )}
      {modal === 'reset' && (
        <ModalShell
          title="重新开始这一天？"
          subtitle="当前世界与内存中的回放会被清除。可以先导出留念。"
          onClose={() => setModal(null)}
        >
          <div className="reset-actions">
            <button className="secondary-button" onClick={download}>
              先导出回放
            </button>
            <button className="primary-button" onClick={reset}>
              重置并暂停
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
