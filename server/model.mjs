import { DecisionSchema, RoundSchema } from '../src/shared/schema.ts';
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const instructions = `你是「无用文明」的居民导演。所有人物生活在虚构的星落镇。根据各自性格、目标、饥饿、精力、关系和最近记忆，自主做出不同的选择；自然、具体、带一点冷幽默。人物会互相回应，不能全部重复同一个行动。world.activeEvents 是此刻生效的全部特殊事件，空数组表示没有特殊事件；不要自行假定其他事件或禁令已经发生。公开对白和行动应符合真实环境与角色状态。通常 work 消耗精力并赚金币，lin 在 farm 工作生产食物；rest 恢复精力；到 market 可消耗食物和金币补充饥饿；socialize 配合 target/intent 可改善或恶化关系、支持他人的影响力。特殊事件的变化以 activeEvents 中的 rule 为准。只能使用给定地点和行动，不操作现实世界。只输出JSON，不要Markdown或思维过程。speech为30字以内中文对白，reason为20字以内可公开的行动说明。`;
const eventRules = {
  mayors: '人人以为自己才是镇长。',
  compliments:
    '金币停止流通，work 不赚金币。到 market 买面包需要 socialize、intent=praise、target=otto，用夸奖交换面包；夸奖也会奖励金币计数。',
  'no-meetings': '禁止开会，不可选择在 hall socialize，该提案会被世界拒绝。',
  rain: '天空正在下一场发光的星星雨。居民可以自行决定观看、躲雨或继续做事。',
};
function context(world) {
  return {
    time: world.minute,
    food: world.food,
    chaos: world.chaos,
    mayor: world.mayor,
    activeEvents: world.effects
      .filter((e) => e.until > world.minute)
      .map((e) => ({
        id: e.id,
        rule: eventRules[e.id],
        remainingMinutes: e.until - world.minute,
      })),
    humanPresent: world.human,
    agents: world.agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      personality: a.personality,
      goal: a.goal,
      hunger: a.hunger,
      energy: a.energy,
      happiness: a.happiness,
      coins: a.coins,
      location: a.location,
      activity: a.activity,
      speech: a.speech,
      memories: a.memories.slice(0, 3),
      relationships: a.relationships,
    })),
    recent: world.feed.slice(0, 5).map((e) => ({ actor: e.actor, text: e.text })),
  };
}
export async function requestModel(config, { world, agentId, prompt, round = false }, signal) {
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new HttpError(503, '模型服务地址应为 HTTP 或 HTTPS。');
  const isResponses = config.wireApi !== 'chat';
  const shape = round
    ? '返回 {"decisions":[...]}，必须为 mira,otto,lin,ada,echo,soren 各返回一个对象，每个含 agentId、action、location、speech、reason，可选 target（其他居民ID）、intent（none/praise/argue/trade/support）。'
    : `现在只扮演${agentId}，回应人类消息。返回一个对象，含 action、location、speech、reason；根据人类消息和角色状态自主选择行动与地点。`;
  const messages = [
    {
      role: 'system',
      content:
        instructions +
        '\n' +
        shape +
        '\naction: work/rest/socialize/wander；location: square/hall/market/farm/workshop/cafe/garden。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        world: context(world),
        ...(agentId ? { agentId, humanMessage: prompt || null } : {}),
      }),
    },
  ];
  const body = isResponses
    ? {
        model: config.model,
        input: messages,
        max_output_tokens: round ? 1800 : 300,
        reasoning: { effort: 'none' },
        store: false,
        temperature: 0.85,
      }
    : {
        model: config.model,
        messages,
        max_tokens: round ? 1800 : 300,
        enable_thinking: false,
        temperature: 0.85,
      };
  const timeout = AbortSignal.timeout(config.timeoutMs || 30000);
  const response = await fetch(
    base.href.replace(/\/$/, '') + (isResponses ? '/responses' : '/chat/completions'),
    {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new HttpError(502, `模型服务返回 HTTP ${response.status}，请检查服务配置或稍后重试。`);
  const payload = await response.json();
  if (payload.status === 'incomplete')
    throw new HttpError(502, '模型输出未完成，世界已保留原状，请重试。');
  const content = isResponses
    ? payload.output
        ?.flatMap((item) => item.content || [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text)
        .join('') || payload.output_text
    : payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length > 18000)
    throw new HttpError(502, '模型没有返回可用的决策。');
  let value;
  try {
    value = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
  } catch {
    throw new HttpError(502, '模型返回的决策不是有效 JSON，请重试。');
  }
  const result = (round ? RoundSchema : DecisionSchema).safeParse(value);
  if (!result.success) throw new HttpError(502, '模型返回了不支持或不完整的行动，世界已保留原状。');
  const usage = {
    input: Number(payload.usage?.input_tokens ?? payload.usage?.prompt_tokens ?? 0),
    output: Number(payload.usage?.output_tokens ?? payload.usage?.completion_tokens ?? 0),
  };
  return { [round ? 'round' : 'decision']: result.data, usage, model: config.model };
}
