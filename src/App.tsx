import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Town, type CameraControls } from './components/Town';
import { Icon } from './components/Icons';
import { Conversation } from './components/Conversation';
import { ActivityFeed } from './components/ActivityFeed';
import { useSharedTown } from './hooks/useSharedTown';
import type { TownAction } from './shared/town';
import { RequestScheduler, type ScheduledTask } from './world/request-scheduler';
import { DecisionSchema, RoundSchema, type Agent, type World } from './shared/schema';
import {
  addHumanMessage,
  applyChatReply,
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

type Status = { configured: boolean; model: string | null; wireApi: string; shared?: boolean };
type Modal = 'events' | 'settings' | 'reset' | null;
type ModelAction = TownAction;
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
  const [residentTab, setResidentTab] = useState<'chat' | 'details'>('chat');
  const [status, setStatus] = useState<Status | null>(null);
  const [paused, setPaused] = useState(
    () => new URLSearchParams(location.search).get('paused') === '1',
  );
  const [visible, setVisible] = useState(!document.hidden);
  const [speed, setSpeed] = useState<keyof typeof intervals>('20s');
  const [connectionError, setConnectionError] = useState('');
  const [drafts, setDrafts] = useState<Partial<Record<AgentId, string>>>({});
  const executeRef = useRef<
    (task: ScheduledTask<ModelAction>, signal: AbortSignal) => Promise<void>
  >(async () => {});
  const [scheduler] = useState(
    () => new RequestScheduler<ModelAction>((task, signal) => executeRef.current(task, signal)),
  );
  const localSchedule = useSyncExternalStore(scheduler.subscribe, scheduler.getSnapshot);
  const sharedMode = status?.shared === true;
  const shared = useSharedTown(sharedMode, !paused && replay === null);
  const sharedData = shared.data;
  const ownTasks = sharedData?.tasks.filter((t) => t.mine) || [];
  const schedule = sharedMode
    ? {
        active: sharedData?.active
          ? sharedData.tasks.find((t) => t.id === sharedData.active!.id) || {
              ...sharedData.active,
              action: { type: 'round' } as ModelAction,
            }
          : null,
        waiting: sharedData?.tasks.filter((t) => t.state === 'pending') || [],
        failed: ownTasks.find((t) => t.state === 'failed') || null,
        error:
          shared.error ||
          ownTasks.find((t) => t.state === 'failed')?.error ||
          sharedData?.autoError ||
          '',
        suspended: false,
      }
    : localSchedule;
  const busy = schedule.active !== null;
  const error = connectionError || schedule.error;
  const pausedWorld = useRef<World | null>(null);
  const sharedVersion = useRef(0);
  const humanTasks = [schedule.active, schedule.failed, ...schedule.waiting].filter(
    (task): task is ScheduledTask<ModelAction> => task?.kind === 'human',
  );
  const humanPending = humanTasks.length > 0;
  const queueFull = sharedMode
    ? shared.sending ||
      ownTasks.filter((t) => t.state !== 'failed').length >=
        (sharedData?.limits.perVisitorPending || 2)
    : humanTasks.length >= scheduler.limit;
  const [usage, setUsage] = useState({ calls: 0, input: 0, output: 0 });
  const [modal, setModal] = useState<Modal>(null);
  const [night, setNight] = useState(true);
  const [notice, setNotice] = useState('');
  const [sound, setSound] = useState(false);
  const idleSince = useRef(Date.now());
  const camera = useRef<CameraControls>(null);
  const file = useRef<HTMLInputElement>(null);
  const firstRound = useRef(false);
  const spokenThrough = useRef<number | null>(null);
  useEffect(() => {
    if (!sharedData) return;
    const through = sharedData.world.nextId;
    const previous = spokenThrough.current;
    spokenThrough.current = through;
    if (previous === null || previous > through || !sound || !('speechSynthesis' in window)) return;
    const reply = sharedData.world.conversations
      .filter(
        (entry) => entry.id >= previous && entry.role === 'model' && entry.agentId === selected,
      )
      .at(-1);
    if (!reply) return;
    try {
      const utterance = new SpeechSynthesisUtterance(reply.text);
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    } catch {
      setNotice('回复已保存，当前浏览器暂时无法朗读。');
    }
  }, [sharedData, sound, selected]);

  const commit = useCallback((next: World) => {
    worldRef.current = next;
    setWorld(next);
    const history = [...snapshotsRef.current, next].slice(-120);
    snapshotsRef.current = history;
    setSnapshots(history);
  }, []);
  useEffect(() => {
    if (!sharedMode) return;
    const controller = new AbortController();
    fetch('/api/history', { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (
          controller.signal.aborted ||
          replayRef.current !== null ||
          !Array.isArray(data.snapshots)
        )
          return;
        const history = (
          sharedVersion.current > data.version
            ? [...data.snapshots, worldRef.current]
            : data.snapshots
        ).slice(-120) as World[];
        snapshotsRef.current = history;
        setSnapshots(history);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [sharedMode]);
  const pause = useCallback((value: boolean) => {
    pausedWorld.current = value ? worldRef.current : null;
    setPaused(value);
    idleSince.current = Date.now();
  }, []);
  useEffect(() => {
    if (!sharedData || sharedData.version === sharedVersion.current) return;
    sharedVersion.current = sharedData.version;
    if (paused && !pausedWorld.current) pausedWorld.current = sharedData.world;
    worldRef.current = sharedData.world;
    setWorld(sharedData.world);
    // Freeze the replay index while viewing history; live state still stays up to date.
    if (replayRef.current === null) {
      const history = [...snapshotsRef.current, sharedData.world].slice(-120);
      snapshotsRef.current = history;
      setSnapshots(history);
    }
  }, [sharedData, paused]);
  const cancel = useCallback(() => scheduler.clear(), [scheduler]);
  const select = useCallback((id: AgentId) => {
    setSelected(id);
    setPanel('resident');
    setResidentTab('chat');
    idleSince.current = Date.now();
  }, []);

  executeRef.current = async (task, signal) => {
    if (signal.aborted) return;
    firstRound.current = true;
    const action = task.action;
    let current = worldRef.current;
    try {
      if (action.type === 'event' && !action.prepared) {
        current = applyEvent(current, action.eventId);
        action.prepared = true;
        commit(current);
      }
      if (action.type === 'join') {
        if (!current.human) commit(joinWorld(current));
        return;
      }
      if (action.type === 'chat' && action.messageId === undefined) {
        current = addHumanMessage(current, action.agentId, action.text);
        action.messageId = current.conversations.at(-1)!.id;
        commit(current);
      }
      const response = await fetch(action.type === 'chat' ? '/api/decide' : '/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          world: current,
          ...(action.type === 'chat' ? { agentId: action.agentId, prompt: action.text } : {}),
        }),
      });
      const result = await response.json();
      // A preempted request must never commit, even if the provider ignores cancellation.
      if (signal.aborted) return;
      if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
      const next =
        action.type === 'chat'
          ? (() => {
              const parsed = DecisionSchema.safeParse(result.decision);
              if (!parsed.success) throw new Error('模型没有返回完整、有效的决策，请重试。');
              return applyChatReply(current, action.agentId, parsed.data, action.messageId!);
            })()
          : (() => {
              const parsed = RoundSchema.safeParse(result.round);
              if (!parsed.success) throw new Error('模型没有返回完整、有效的决策，请重试。');
              return applyRound(current, parsed.data);
            })();
      commit(next);
      setUsage((old) => ({
        calls: old.calls + 1,
        input: old.input + Math.max(0, Number(result.usage?.input) || 0),
        output: old.output + Math.max(0, Number(result.usage?.output) || 0),
      }));
      if (action.type === 'chat' && sound && 'speechSynthesis' in window) {
        try {
          const speech = new SpeechSynthesisUtterance(
            next.agents.find((a) => a.id === action.agentId)!.speech,
          );
          speech.lang = 'zh-CN';
          window.speechSynthesis.speak(speech);
        } catch {
          setNotice('回复已保存，当前浏览器暂时无法朗读。');
        }
      }
    } catch (error) {
      if (!signal.aborted) pause(true);
      throw error;
    }
  };
  const run = useCallback(() => {
    if (sharedMode || replayRef.current !== null || !status?.configured || document.hidden)
      return false;
    return scheduler.automatic({ type: 'round' });
  }, [scheduler, status, sharedMode]);
  function describe(task: ScheduledTask<ModelAction>) {
    const action = task.action;
    if (action.type === 'event')
      return `投放「${events.find((e) => e.id === action.eventId)!.title}」`;
    if (action.type === 'chat')
      return `对${worldRef.current.agents.find((a) => a.id === action.agentId)!.name}说：${action.text}`;
    return action.type === 'join' ? '作为人类加入小镇' : '小镇自动决策';
  }
  async function submit(action: ModelAction) {
    if (sharedMode) {
      if (replayRef.current !== null || !shared.connected) return false;
      const accepted = await shared.command(action);
      if (accepted) {
        pause(false);
        setNotice('已加入共享队列，所有人都能看到这次互动。');
      }
      return accepted;
    }
    if (replayRef.current !== null || !status?.configured) return false;
    const task = scheduler.enqueue(action);
    if (!task) {
      setNotice('等待队列已满，请稍后再提交。草稿已保留。');
      return false;
    }
    firstRound.current = true;
    idleSince.current = Date.now();
    setNotice(
      scheduler.getSnapshot().active?.id === task.id
        ? '已优先处理，无需暂停小镇。'
        : '已加入等待队列，将依次处理。',
    );
    return true;
  }

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
          setConnectionError('尚未配置模型。请填写服务器 .env 后重启。');
          pause(true);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setConnectionError('无法连接本地服务器，请检查服务是否运行。');
          pause(true);
        }
      });
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) scheduler.suspend();
      else if (replayRef.current === null) scheduler.resume();
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
  }, [cancel, pause, scheduler]);
  useEffect(() => {
    if (
      !sharedMode &&
      status?.configured &&
      !firstRound.current &&
      visible &&
      replay === null &&
      !paused &&
      !humanPending
    ) {
      if (run()) firstRound.current = true;
    }
  }, [status, visible, replay, paused, run, humanPending, sharedMode]);
  useEffect(() => {
    if (
      sharedMode ||
      !status?.configured ||
      paused ||
      !visible ||
      replay !== null ||
      humanPending ||
      (modal && modal !== 'events')
    )
      return;
    const interval = setInterval(() => {
      if (Date.now() - idleSince.current > 600000) {
        pause(true);
        setNotice('已观察 10 分钟，自动暂停。继续时再调用模型。');
        return;
      }
      void run();
    }, intervals[speed]);
    return () => clearInterval(interval);
  }, [status, paused, visible, replay, modal, speed, run, pause, humanPending, sharedMode]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const view =
    replay === null
      ? sharedMode && paused && pausedWorld.current
        ? pausedWorld.current
        : world
      : snapshots[replay] || world;
  const agent = view.agents.find((a) => a.id === selected) || null;
  const interactionLocked =
    replay !== null ||
    !status?.configured ||
    (sharedMode && (!shared.connected || !sharedData?.running));
  const disabled = busy || humanPending || interactionLocked;
  const message = selected ? drafts[selected] || '' : '';
  const joinPending = humanTasks.some((t) => t.action.type === 'join');
  function enterReplay(index: number) {
    scheduler.suspend();
    pause(true);
    replayRef.current = index;
    setReplay(index);
  }
  function leaveReplay() {
    replayRef.current = null;
    setReplay(null);
    if (!document.hidden) scheduler.resume();
    if (sharedMode) {
      pause(false);
      const history = [...snapshotsRef.current, worldRef.current].slice(-120);
      snapshotsRef.current = history;
      setSnapshots(history);
    }
    setNotice('已返回当前世界。');
  }
  async function event(id: EventId) {
    if (await submit({ type: 'event', eventId: id })) setModal(null);
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
    if (sharedMode) {
      setNotice('共享世界只允许管理员导入存档。');
      return;
    }
    try {
      if (input.size > 5000000) throw new Error('回放文件不能超过 5 MB。');
      const history = importReplay(await input.text());
      cancel();
      scheduler.suspend();
      setDrafts({});
      firstRound.current = true;
      pause(true);
      snapshotsRef.current = history;
      setSnapshots(history);
      const last = history.at(-1)!;
      worldRef.current = last;
      setWorld(last);
      replayRef.current = 0;
      setReplay(0);
      setModal(null);
      setConnectionError('');
      setNotice('回放已导入，自动运行已暂停。返回当前世界后可以继续。');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '无法导入回放。');
    } finally {
      if (file.current) file.current.value = '';
    }
  }
  function reset() {
    if (sharedMode) {
      setNotice('共享世界只允许管理员重置。');
      return;
    }
    cancel();
    if (!document.hidden) scheduler.resume();
    setDrafts({});
    firstRound.current = false;
    pause(true);
    const next = createWorld();
    worldRef.current = next;
    setWorld(next);
    snapshotsRef.current = [next];
    setSnapshots([next]);
    replayRef.current = null;
    setReplay(null);
    setConnectionError('');
    setModal(null);
    setNotice('世界已重置。点击播放，等待模型为居民做出第一轮决定。');
  }
  const stateLabel =
    replay !== null
      ? '正在回放'
      : busy
        ? schedule.active?.kind === 'human'
          ? sharedMode
            ? '正在回应人类互动'
            : '正在回应你的操作'
          : '居民思考中'
        : !visible
          ? '页面已休眠'
          : paused
            ? '观察已暂停'
            : sharedMode && !shared.connected
              ? '正在重新连接'
              : sharedMode && !sharedData?.running
                ? '小镇暂时休息'
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
            <span className="tiny-dot" />6 位 AI 居民 ·{' '}
            {sharedMode
              ? `${sharedData?.online || 0} 个在线观察窗口`
              : view.human
                ? '1 位人类'
                : '0 位人类'}
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
              {!sharedMode && (
                <>
                  <ToolButton
                    label="运行一轮"
                    icon="skip"
                    disabled={disabled || sharedMode}
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
                        disabled={sharedMode}
                        onClick={() => setSpeed(s)}
                        aria-pressed={speed === s}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <span className="round-label">第 {view.tick} 轮</span>
            </div>
            <div className="deck-actions">
              <button
                className="secondary-button join-button"
                disabled={interactionLocked || queueFull || view.human || joinPending}
                onClick={() => {
                  submit({ type: 'join' });
                }}
              >
                <Icon name={view.human ? 'check' : 'people'} size={16} />
                {view.human ? '已加入小镇' : joinPending ? '等待加入…' : '作为人类加入'}
              </button>
              <button
                className="primary-button"
                disabled={interactionLocked}
                onClick={() => setModal('events')}
              >
                <Icon name="spark" size={16} />
                投放事件
              </button>
            </div>
          </div>
          {sharedMode && (
            <div className="shared-status" role="status" aria-label="共享小镇状态">
              <span>{shared.connected ? '共享小镇 · 实时连接' : '连接中 · 暂时无法提交'}</span>
              <span>
                今日参与 {sharedData?.quota.usedDay || 0}/{sharedData?.quota.dayLimit || 60} ·
                每小时 {sharedData?.quota.hourLimit || 20} 次 · 间隔 10 秒
              </span>
              <span>
                全站今日模型 {sharedData?.budget.dayUsed || 0}/{sharedData?.budget.dayLimit || 500}{' '}
                次
              </span>
              {!!sharedData?.budget.resetsAt && (
                <span>额度恢复：{new Date(sharedData.budget.resetsAt).toLocaleString()}</span>
              )}
              <small>
                聊天和事件对所有访客公开。匿名限额结合 Cookie 与 IP，累计用量保存在服务器。
              </small>
            </div>
          )}
          {humanPending && (
            <section className="interaction-queue" aria-label="人类操作队列">
              <div className="queue-heading" role="status">
                <Icon name="people" size={15} />
                <strong>
                  {schedule.suspended
                    ? '等待返回当前世界后继续'
                    : schedule.failed
                      ? '回应失败，等待重试'
                      : schedule.active?.kind === 'human'
                        ? sharedMode
                          ? '正在处理共享互动'
                          : '正在处理你的操作'
                        : '等待处理'}
                </strong>
                <small>{schedule.waiting.length} 项等待</small>
              </div>
              {humanTasks.map((task) => (
                <div className="queue-item" key={task.id}>
                  <span>{describe(task)}</span>
                  <small>
                    {schedule.failed?.id === task.id
                      ? '需重试'
                      : schedule.active?.id === task.id
                        ? '处理中'
                        : '等待中'}
                  </small>
                  {schedule.waiting.some((t) => t.id === task.id) &&
                    (!sharedMode || ownTasks.some((t) => t.id === task.id)) && (
                      <button
                        aria-label={`取消等待：${describe(task)}`}
                        title="取消等待"
                        onClick={() => {
                          if (sharedMode) {
                            void shared.cancel(task.id);
                            return;
                          }
                          scheduler.remove(task.id);
                          if (task.action.type === 'chat' && task.action.messageId === undefined) {
                            const action = task.action;
                            setDrafts((old) => ({
                              ...old,
                              [action.agentId]: old[action.agentId] || action.text,
                            }));
                          }
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                </div>
              ))}
            </section>
          )}
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
                  if (sharedMode) {
                    if (schedule.failed)
                      void shared.command({ type: 'retry', id: schedule.failed.id });
                    else if (shared.error) shared.clearError();
                    else setModal('events');
                    return;
                  }
                  scheduler.retry();
                }}
                disabled={busy || schedule.suspended}
              >
                {status?.configured ? '重试' : '查看配置'}
                <Icon name="refresh" size={13} />
              </button>
              {schedule.failed?.kind === 'human' && (
                <button
                  onClick={() =>
                    sharedMode ? void shared.cancel(schedule.failed!.id) : scheduler.skipFailed()
                  }
                >
                  跳过本次回应
                </button>
              )}
            </div>
          )}
          <div className="timeline">
            <div className="timeline-title">
              <span>
                <Icon name="history" size={14} />
                世界回放
              </span>
              <small>
                {snapshots.length} 个瞬间 · {sharedMode ? '共享世界已自动存档' : '仅保存在内存'}
              </small>
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
                  : sharedMode
                    ? '全镇共享进度 · 暂停仅影响自己观看'
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
              居民互动
            </button>
          </div>
          {panel === 'feed' ? (
            <ActivityFeed
              key={replay === null ? 'live' : `replay-${replay}`}
              world={view}
              busy={busy}
              avatar={(actor) => <Avatar agent={actor} small />}
            />
          ) : agent ? (
            <div
              className={`profile-panel ${residentTab === 'chat' ? 'conversation-open' : 'details-open'}`}
            >
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
              <div
                className="resident-tabs"
                role="tablist"
                aria-label="居民信息"
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const next =
                    e.key === 'Home'
                      ? 'chat'
                      : e.key === 'End'
                        ? 'details'
                        : residentTab === 'chat'
                          ? 'details'
                          : 'chat';
                  setResidentTab(next);
                  e.currentTarget
                    .querySelectorAll<HTMLButtonElement>('[role=tab]')
                    [next === 'chat' ? 0 : 1].focus();
                }}
              >
                <button
                  role="tab"
                  id="conversation-tab"
                  tabIndex={residentTab === 'chat' ? 0 : -1}
                  aria-selected={residentTab === 'chat'}
                  aria-controls="conversation-panel"
                  onClick={() => setResidentTab('chat')}
                >
                  对话
                </button>
                <button
                  role="tab"
                  id="details-tab"
                  tabIndex={residentTab === 'details' ? 0 : -1}
                  aria-selected={residentTab === 'details'}
                  aria-controls="details-panel"
                  onClick={() => setResidentTab('details')}
                >
                  档案
                </button>
              </div>
              {residentTab === 'chat' ? (
                <div
                  className="conversation-pane"
                  id="conversation-panel"
                  role="tabpanel"
                  aria-labelledby="conversation-tab"
                >
                  <Conversation
                    visitor={sharedData?.you}
                    agent={agent}
                    entries={view.conversations.filter((e) => e.agentId === agent.id)}
                    pending={
                      replay !== null
                        ? []
                        : humanTasks
                            .filter(
                              (t) => t.action.type === 'chat' && t.action.agentId === agent.id,
                            )
                            .map((t) => ({
                              id: t.id,
                              author: sharedMode
                                ? sharedData?.tasks.find((task) => task.id === t.id)?.author
                                : undefined,
                              text: t.action.type === 'chat' ? t.action.text : '',
                              messageId: t.action.type === 'chat' ? t.action.messageId : undefined,
                              state:
                                schedule.failed?.id === t.id
                                  ? 'failed'
                                  : schedule.active?.id === t.id
                                    ? 'active'
                                    : 'waiting',
                            }))
                    }
                    draft={message}
                    onDraft={(text) => setDrafts((old) => ({ ...old, [agent.id]: text }))}
                    onSend={async () => {
                      if (await submit({ type: 'chat', agentId: agent.id, text: message.trim() }))
                        setDrafts((old) => ({
                          ...old,
                          [agent.id]: old[agent.id] === message ? '' : old[agent.id],
                        }));
                    }}
                    locked={interactionLocked}
                    full={queueFull}
                  />
                </div>
              ) : (
                <div id="details-panel" role="tabpanel" aria-labelledby="details-tab">
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
                </div>
              )}
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
          {sharedMode ? sharedData?.usage.calls || 0 : usage.calls} 次调用
          <span className="tiny-dot" />
          {(sharedMode
            ? (sharedData?.usage.input || 0) + (sharedData?.usage.output || 0)
            : usage.input + usage.output
          ).toLocaleString()}{' '}
          tokens
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
                disabled={interactionLocked || queueFull}
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
            {sharedMode && shared.error
              ? shared.error
              : queueFull
                ? sharedMode
                  ? '你已有待处理操作，请等待完成后继续。'
                  : '等待队列已满（最多 12 项），请等待完成或取消部分操作。'
                : '提交后自动请求居民回应，无需暂停。连续投放将按顺序处理。'}
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
              <p>随时投放事件或发送消息。人类操作优先，连续提交会依次处理，无需先暂停。</p>
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
              {sharedMode
                ? '密钥仅在服务器。所有人的对话与事件公开；暂停观看、回放、关闭页面不影响别人。无人观看时停止自动推进。'
                : '密钥仅留在本地服务器。页面隐藏或观察 10 分钟无操作时停止调用。回放期间不调用模型。'}
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
            <button
              className="secondary-button"
              disabled={sharedMode}
              onClick={() => file.current?.click()}
            >
              <Icon name="upload" size={15} />
              导入回放
            </button>
            <button
              className="danger-button"
              disabled={sharedMode}
              onClick={() => setModal('reset')}
            >
              <Icon name="refresh" size={15} />
              重置世界
            </button>
          </div>
          <p className="modal-footnote">
            {sharedMode
              ? '小镇由服务器 SQLite 自动保存，刷新后继续同一座小镇。匿名访客可以参与，管理操作由站点管理员执行。'
              : '世界只保存在本页内存，刷新后重新开始。请导出回放以保存进展。此预览尚未绑定域名。'}
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
