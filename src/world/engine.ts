import {
  DecisionSchema,
  RoundSchema,
  ReplaySchema,
  FEED_LIMIT,
  type Round,
  type Agent,
  type Decision,
  type World,
  type FeedItem,
  type IDS,
  type PLACES,
} from '../shared/schema.ts';
export type AgentId = (typeof IDS)[number];
export type PlaceId = (typeof PLACES)[number];
export const places: Record<PlaceId, { name: string; x: number; z: number; description: string }> =
  {
    square: { name: '星落广场', x: 0, z: 0, description: '事情通常从这里开始失控。' },
    hall: { name: '镇公所', x: -5, z: -4, description: '镇长的办公室，偶尔也是辩论现场。' },
    market: { name: '杂货铺', x: 5, z: -4, description: '任何东西都有价格，除了此刻的价格。' },
    farm: { name: '面包农场', x: 6, z: 3, description: '种下小麦，收获碳水与希望。' },
    workshop: { name: '修理工坊', x: -5, z: 3, description: '还没坏的东西也可以修一下。' },
    cafe: { name: '午夜咖啡', x: 0, z: -6, description: '没有人睡觉时，这里最热闹。' },
    garden: { name: '发呆花园', x: 0, z: 5, description: '不做任何事，也是一种行动。' },
  };
export const profiles = [
  {
    id: 'mira',
    name: '米拉',
    role: '镇长',
    color: '#b2a0ff',
    personality: '热情、有控制欲，认为一切问题都可以通过开会解决。',
    goal: '让每个人都承认自己是最好的镇长。',
    home: 'hall',
  },
  {
    id: 'otto',
    name: '奥托',
    role: '商人',
    color: '#f2b56e',
    personality: '精明、爱讨价还价，但对朋友很大方。',
    goal: '赚到 100 枚金币，开第二家杂货铺。',
    home: 'market',
  },
  {
    id: 'lin',
    name: '小林',
    role: '农夫',
    color: '#86d8a0',
    personality: '勤劳、温和，相信一块面包胜过一百个建议。',
    goal: '让镇上再也没有人饿肚子。',
    home: 'farm',
  },
  {
    id: 'ada',
    name: '阿达',
    role: '工程师',
    color: '#71c9ee',
    personality: '好奇、务实，喜欢修理东西，也会制造新的问题。',
    goal: '造一台能够自己休息的工作机器。',
    home: 'workshop',
  },
  {
    id: 'echo',
    name: '回声',
    role: '艺术家',
    color: '#ee91ba',
    personality: '浪漫、戏剧化，会为一盏路灯写一首诗。',
    goal: '让每个人在生活里发现一点没用的美。',
    home: 'cafe',
  },
  {
    id: 'soren',
    name: '索伦',
    role: '哲学家',
    color: '#c5cc7d',
    personality: '冷幽默、慢条斯理，经常怀疑问题本身是否存在。',
    goal: '证明发呆也是一种对小镇的贡献。',
    home: 'garden',
  },
] as const;
export const events = [
  {
    id: 'mayors',
    icon: 'crown',
    title: '全民镇长',
    label: '权力实验',
    description: '每个人都觉得自己才是镇长。六份任命书，一座小镇。',
    duration: '持续 3 小时',
    color: '#b2a0ff',
  },
  {
    id: 'compliments',
    icon: 'spark',
    title: '夸奖变成货币',
    label: '经济实验',
    description: '金币停止流通。想买面包？先真诚地夸一下老板。',
    duration: '持续 6 小时',
    color: '#f2b56e',
  },
  {
    id: 'no-meetings',
    icon: 'ban',
    title: '全镇禁止开会',
    label: '社会实验',
    description: '所有会议必须取消。镇长需要找到一种新的人生意义。',
    duration: '持续 6 小时',
    color: '#ee91ba',
  },
  {
    id: 'memories',
    icon: 'shuffle',
    title: '随机交换记忆',
    label: '身份实验',
    description: '两名居民交换最近的记忆。今天的我，还算昨天的我吗？',
    duration: '立即生效',
    color: '#71c9ee',
  },
  {
    id: 'bread',
    icon: 'bread',
    title: '免费面包日',
    label: '幸福实验',
    description: '农场突然丰收。面包免费，快乐也许可以。',
    duration: '即时补充食物',
    color: '#86d8a0',
  },
  {
    id: 'rain',
    icon: 'rain',
    title: '下一场星星雨',
    label: '天气实验',
    description: '天空开始发光，大家去咖啡馆躲雨，也顺便聊聊。',
    duration: '持续 3 小时',
    color: '#83aafa',
  },
] as const;
export type EventId = (typeof events)[number]['id'];
const clamp = (n: number, max = 100) => Math.max(0, Math.min(max, Number.isFinite(n) ? n : 0));
function random(w: World) {
  let x = w.seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  w.seed = x >>> 0 || 1;
  return w.seed / 4294967296;
}
function pick<T>(w: World, list: readonly T[]) {
  return list[Math.floor(random(w) * list.length)];
}
function copy(w: World): World {
  return structuredClone(w);
}
export function hasEffect(w: World, id: EventId) {
  return w.effects.some((e) => e.id === id && e.until > w.minute);
}
export function addFeed(
  w: World,
  text: string,
  actor: AgentId | null = null,
  type: FeedItem['type'] = 'social',
  source: FeedItem['source'] = 'local',
) {
  w.feed.unshift({
    id: w.nextId++,
    minute: w.minute,
    text: text.slice(0, 500),
    actor,
    type,
    source,
  });
  w.feed = w.feed.slice(0, FEED_LIMIT);
}
function remember(a: Agent, text: string) {
  a.memories = [text.slice(0, 300), ...a.memories].slice(0, 12);
}
export function createWorld(seed = 6712026): World {
  const w: World = {
    seed: seed >>> 0 || 1,
    minute: 8 * 60,
    tick: 0,
    food: 74,
    harmony: 72,
    chaos: 12,
    mayor: 'mira',
    effects: [],
    feed: [],
    nextId: 1,
    human: false,
    conversations: [],
    agents: profiles.map((p, i) => ({
      ...p,
      hunger: 18 + i * 3,
      energy: 75 - i * 4,
      happiness: 68 + i * 3,
      coins: 18 + i * 5,
      influence: i === 0 ? 76 : 30 + i * 5,
      location: p.home,
      action: 'work',
      activity: [
        '准备新一轮镇民大会',
        '整理今日货架',
        '照料面包小麦',
        '研究自动休息机',
        '为午夜写一首诗',
        '进行有意义的发呆',
      ][i],
      speech: '',
      memories: ['今天搬进了星落镇。'],
      relationships: Object.fromEntries(
        profiles.map((x) => [x.id, x.id === p.id ? 100 : 10]),
      ) as Agent['relationships'],
      source: 'model',
    })),
  };
  addFeed(w, '星落镇开始了新的一天。六位居民，六种想法，暂时还算和平。', null, 'arrival');
  return w;
}
export function stepWorld(input: World): World {
  // Physics advances only after a real model round succeeds. No choices or dialogue are generated here.
  const w = copy(input);
  w.tick++;
  w.minute += 15;
  const expired = w.effects.filter((e) => e.until <= w.minute);
  w.effects = w.effects.filter((e) => e.until > w.minute);
  for (const e of expired)
    addFeed(w, `${events.find((x) => x.id === e.id)?.title}结束了。`, null, 'system');
  for (const a of w.agents) {
    a.hunger = clamp(a.hunger + 4);
    a.energy = clamp(a.energy - 2);
    if (a.hunger > 80) a.happiness = clamp(a.happiness - 3);
  }
  w.chaos = clamp(w.chaos - 1);
  return w;
}
export function applyEvent(input: World, id: EventId): World {
  const event = events.find((e) => e.id === id);
  if (!event) return input;
  const w = copy(input);
  const length = id === 'compliments' || id === 'no-meetings' ? 360 : 180;
  if (!['memories', 'bread'].includes(id))
    w.effects = [...w.effects.filter((e) => e.id !== id), { id, until: w.minute + length }];
  if (id === 'mayors') w.chaos = clamp(w.chaos + 22);
  if (id === 'compliments') w.harmony = clamp(w.harmony + 5);
  if (id === 'memories') {
    const a = pick(w, w.agents);
    const b = pick(
      w,
      w.agents.filter((x) => x.id !== a.id),
    );
    [a.memories, b.memories] = [b.memories, a.memories];
    remember(a, `与${b.name}交换了最近的记忆。`);
    remember(b, `与${a.name}交换了最近的记忆。`);
    addFeed(w, `${a.name}和${b.name}交换了记忆。等待他们决定如何回应。`, null, 'event', 'human');
    w.chaos = clamp(w.chaos + 9);
  }
  if (id === 'bread') {
    w.food = clamp(w.food + 75, 200);
    for (const a of w.agents) {
      a.hunger = clamp(a.hunger - 35);
      a.happiness = clamp(a.happiness + 12);
    }
  }
  addFeed(w, `你投放了「${event.title}」。${event.description}`, null, 'event', 'human');
  return w;
}
export function applyDecision(input: World, id: AgentId, proposal: Decision): World {
  const parsed = DecisionSchema.safeParse(proposal);
  if (!parsed.success) return input;
  const w = copy(input);
  const a = w.agents.find((x) => x.id === id);
  if (!a) return input;
  a.action = parsed.data.action;
  a.location = parsed.data.location;
  a.speech = parsed.data.speech;
  a.activity = parsed.data.reason.slice(0, 160);
  a.source = 'model';
  remember(a, parsed.data.reason);
  addFeed(w, parsed.data.speech, id, 'social', 'model');
  return w;
}
export function applyRound(input: World, data: Round): World {
  const parsed = RoundSchema.safeParse(data);
  if (!parsed.success) return input;
  let w = stepWorld(input);
  for (const plan of parsed.data.decisions) {
    if (hasEffect(w, 'no-meetings') && plan.location === 'hall' && plan.action === 'socialize') {
      addFeed(w, '镇公所暂停会议，相关提案未执行，等待下一轮新计划。', plan.agentId, 'system');
      continue;
    }
    const { agentId, target: _target, intent: _intent, ...decision } = plan;
    w = applyDecision(w, agentId, decision);
    const a = w.agents.find((x) => x.id === plan.agentId)!;
    if (plan.action === 'rest') {
      a.energy = clamp(a.energy + 14);
      a.happiness = clamp(a.happiness + 2);
    }
    if (plan.action === 'work') {
      a.energy = clamp(a.energy - 4);
      a.coins = clamp(a.coins + (hasEffect(w, 'compliments') ? 0 : 3), 999);
      if (a.id === 'lin' && plan.location === 'farm') w.food = clamp(w.food + 12, 200);
      if (a.id === 'mira') a.influence = clamp(a.influence + 2);
    }
    if (
      plan.location === 'market' &&
      a.hunger > 25 &&
      w.food >= 4 &&
      (hasEffect(w, 'compliments')
        ? plan.action === 'socialize' && plan.intent === 'praise' && plan.target === 'otto'
        : a.coins >= 2)
    ) {
      w.food -= 4;
      a.hunger = clamp(a.hunger - 28);
      a.happiness = clamp(a.happiness + 4);
      if (!hasEffect(w, 'compliments')) a.coins -= 2;
    }
    const target = w.agents.find((x) => x.id === plan.target && x.id !== a.id);
    if (target && plan.action === 'socialize') {
      const delta = plan.intent === 'argue' ? -6 : 5;
      a.relationships[target.id] = Math.max(
        -100,
        Math.min(100, a.relationships[target.id] + delta),
      );
      target.relationships[a.id] = Math.max(
        -100,
        Math.min(100, target.relationships[a.id] + delta),
      );
      a.happiness = clamp(a.happiness + Math.sign(delta) * 2);
      if (plan.intent === 'argue') w.chaos = clamp(w.chaos + 4);
      if (plan.intent === 'support') target.influence = clamp(target.influence + 4);
      if (plan.intent === 'praise' && hasEffect(w, 'compliments')) {
        a.coins = clamp(a.coins + 4, 999);
        target.happiness = clamp(target.happiness + 5);
      }
    }
  }
  w.harmony = clamp(w.agents.reduce((sum, a) => sum + a.happiness, 0) / 6 - w.chaos * 0.12);
  if (w.tick % 24 === 0) {
    const winner = [...w.agents].sort((a, b) => b.influence - a.influence)[0];
    w.mayor = winner.id;
    addFeed(w, `${winner.name}以当前影响力成为新任值班镇长。`, null, 'system');
  }
  return w;
}
export function addHumanMessage(input: World, id: AgentId, message: string): World {
  if (!message.trim()) return input;
  const w = copy(input);
  const a = w.agents.find((x) => x.id === id);
  if (!a) return input;
  const text = message.trim().slice(0, 300);
  remember(a, `人类对我说：${text}`);
  addFeed(w, text, id, 'chat', 'human');
  w.conversations = [
    ...w.conversations,
    { id: w.feed[0].id, agentId: id, role: 'human' as const, text, minute: w.minute },
  ].slice(-120);
  return w;
}
export function applyChatReply(
  input: World,
  id: AgentId,
  proposal: Decision,
  replyTo: number,
): World {
  const w = applyDecision(input, id, proposal);
  if (w === input) return input;
  w.feed[0].type = 'chat';
  w.conversations = [
    ...w.conversations,
    {
      id: w.feed[0].id,
      agentId: id,
      role: 'model' as const,
      text: proposal.speech,
      minute: w.minute,
      replyTo,
    },
  ].slice(-120);
  return w;
}
export function joinWorld(input: World): World {
  if (input.human) return input;
  const w = copy(input);
  w.human = true;
  addFeed(w, '一位人类出现在星落广场。', null, 'arrival', 'human');
  for (const a of w.agents) remember(a, '小镇迎来了一位真正的人类。');
  return w;
}
export function formatTime(minute: number) {
  const h = Math.floor((minute % 1440) / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export function formatDay(minute: number) {
  return Math.floor(minute / 1440) + 1;
}
export function exportReplay(snapshots: World[]) {
  const frames = snapshots.slice(-120);
  let raw = JSON.stringify({ version: 1, snapshots: frames });
  while (frames.length > 1 && new TextEncoder().encode(raw).length > 5_000_000) {
    frames.shift();
    raw = JSON.stringify({ version: 1, snapshots: frames });
  }
  return raw;
}
export function importReplay(raw: string): World[] {
  if (new TextEncoder().encode(raw).length > 5_000_000) throw new Error('回放文件不能超过 5 MB。');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('这不是有效的 JSON 回放文件。');
  }
  const parsed = ReplaySchema.safeParse(data);
  if (!parsed.success) throw new Error('回放格式不正确，或包含不支持的数据。');
  return parsed.data.snapshots;
}
