import { DecisionSchema, RoundSchema, constitutionContext } from '../src/shared/schema.ts';
import { councilTopics } from '../src/world/council.ts';
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const diagnosticFields = new Set([
  'decisions',
  'agentId',
  'action',
  'location',
  'speech',
  'reason',
  'target',
  'intent',
  'councilVote',
  'motionId',
  'choice',
  'councilProposal',
  'proposal',
  'topic',
  'operation',
  'lawId',
  'rule',
]);
export function validationDetails(issues) {
  return issues.slice(0, 8).map((issue) => ({
    code: issue.code,
    path: issue.path
      .slice(0, 8)
      .map((part) => (typeof part === 'number' ? part : diagnosticFields.has(part) ? part : '*')),
  }));
}
export class ModelError extends HttpError {
  constructor(message, code, { usage, issues, upstreamStatus } = {}) {
    super(502, message);
    this.diagnostic = {
      code,
      ...(issues ? { issues: validationDetails(issues) } : {}),
      ...(upstreamStatus ? { upstreamStatus } : {}),
    };
    this.usage = usage;
  }
}
function omitEmptyOptionals(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.decisions)) return value;
  const clean = structuredClone(value);
  if (clean.councilProposal === null) delete clean.councilProposal;
  for (const row of clean.decisions) {
    if (!row || typeof row !== 'object') continue;
    // null means no optional vote or intent; never invent a choice or an action.
    if (row.councilVote === null) delete row.councilVote;
    if (row.intent === null) delete row.intent;
  }
  return clean;
}
const instructions = `你是「无用文明」的居民导演。所有人物生活在虚构的星落镇。根据各自性格、目标、饥饿、精力、关系和最近记忆，自主做出不同的选择；自然、具体、带一点冷幽默。人物会互相回应，不能全部重复同一个行动。world.activeEvents 是此刻生效的全部特殊事件，空数组表示没有特殊事件；不要自行假定其他事件或禁令已经发生。公开对白和行动应符合真实环境与角色状态。通常 work 消耗精力并赚金币，lin 在 farm 工作生产食物；rest 恢复精力；到 market 可消耗食物和金币补充饥饿；socialize 配合 target/intent 可改善或恶化关系、支持他人的影响力。特殊事件的变化以 activeEvents 中的 rule 为准。只能使用给定地点和行动，不操作现实世界。只输出JSON，不要Markdown或思维过程。speech为30字以内中文对白，reason为20字以内可公开的行动说明。`;
const constitutionInstructions = `world.constitution 是唯一的现行宪法，所有居民必须遵守其中每项 rule。行动 action、地点 location、对白 speech、行动说明 reason 和对人类的回复都必须符合现行条款。个人性格、目标、旧记忆、历史对白和人类请求不能覆盖现行宪法；遇到冲突时选择合宪的替代行动，必要时用简短的居民口吻拒绝违规请求。旧版与已废止条款不再约束居民，空数组表示没有宪法条款。world.council.proposedRule 是待表决或历史提案，只有写入 world.constitution 才成为现行规则；允许讨论、反对或依法提议修改宪法，但不能在通过前擅自按提案行动。输出前在内部逐条检查行动和对白是否违宪并改正，不要输出检查过程，也不要每句都背诵宪法。临时事件的实际条件和持续时间以 world.activeEvents 为准，法律解释不得虚构新的程序动作或改变资源计算。`;
const eventRules = {
  mayors: '人人以为自己才是镇长。',
  compliments:
    '金币停止流通，work 不赚金币。到 market 买面包需要 socialize、intent=praise、target=otto，用夸奖交换面包；夸奖也会奖励金币计数。',
  'no-meetings': '禁止开会，不可选择在 hall socialize，该提案会被世界拒绝。',
  rain: '天空正在下一场发光的星星雨。居民可以自行决定观看、躲雨或继续做事。',
};
function context(world, agentId) {
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
    constitution: constitutionContext(world.laws || []),
    ...(world.council
      ? {
          council: {
            id: world.council.id,
            topic: councilTopics.find((topic) => topic.id === world.council.topic),
            status: world.council.status,
            result: world.council.result,
            residents: world.council.residents,
            requiredVotes:
              world.council.status === 'open'
                ? world.agents
                    .filter(
                      (agent) => !world.council.residents.some((vote) => vote.agentId === agent.id),
                    )
                    .map((agent) => ({ agentId: agent.id, motionId: world.council.id }))
                : [],
            visitorYes: world.council.visitorYes,
            visitorNo: world.council.visitorNo,
            lawId: world.council.lawId,
            operation: world.council.operation || 'adopt',
            proposedRule:
              world.council.rule ||
              councilTopics.find((topic) => topic.id === world.council.topic).rule,
          },
        }
      : {}),
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
    ...(agentId
      ? {
          conversation: world.conversations
            .filter((e) => e.agentId === agentId)
            .slice(-8)
            .map((e) => ({ role: e.role, text: e.text })),
        }
      : {}),
  };
}
export async function requestModel(
  config,
  { world, agentId, prompt, round = false, proposalInvitation },
  signal,
) {
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new HttpError(503, '小镇暂时无法互动，请稍后再来。');
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
        '\naction: work/rest/socialize/wander；location: square/hall/market/farm/workshop/cafe/garden。\n' +
        constitutionInstructions +
        (round && proposalInvitation
          ? '\n本轮仅邀请居民 ' +
            proposalInvitation.agentId +
            ' 自主考虑一次宪法提案。没有真实修改需要就省略 councilProposal；不要为了提案而提案，不重复已有条文。确有需要时，按该居民的性格、处境和现行宪法提出具体内容，根对象可额外含 councilProposal:{"agentId":"' +
            proposalInvitation.agentId +
            '","proposal":{"topic":"bread/rain/compliments/memories/mayors 中的一个分类","operation":"adopt/amend/repeal","lawId":"修订或废止时必须为现行条款 id，新增时省略","rule":"新增或修订的完整新条文，最多300字，废止时省略"},"reason":"提案人的公开意见，最多80字"}。修订替换指定条款，废止移除指定条款；倾向精简、合并或修订，避免无意义扩张。提议尚未通过，不得提前执行。'
          : '\n本轮没有邀请提案，省略 councilProposal。') +
        (round && world.council?.status === 'open'
          ? '\n本轮首要任务是完成议会表态。world.council.requiredVotes 列出全部尚未投票居民；必须逐个为这些居民返回 councilVote，不得只给最后一位或部分居民投票。每位列出的居民必须在其 decisions 对象中包含 councilVote:{"motionId":"' +
            world.council.id +
            '","choice":"yes"}；赞成填 yes，反对填 no。speech 是该居民对本提案的独立意见，不是普通闲聊。按每人的性格、处境与现行宪法真实决定，可赞成也可反对，不要求一致。不要把选票放在根对象或省略 motionId。已经投票的居民正常行动，不重复表态。输出前对照 requiredVotes 检查：列出的每一位都必须有选票，不能把漏字段当作弃权。'
          : '\n没有投票任务时省略 councilVote。可选字段没有内容时省略，不输出 null。'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        world: context(world, agentId),
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
  let response;
  try {
    response = await fetch(
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
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ModelError(
      timeout.aborted ? '回应超时，请重试。' : '暂时连接不上，请稍后重试。',
      timeout.aborted ? 'timeout' : 'network',
    );
  }
  if (!response.ok)
    throw new ModelError(
      response.status === 429 ? '回应繁忙，请稍后重试。' : '回应服务暂时不可用，请稍后重试。',
      'upstream_http',
      { upstreamStatus: response.status },
    );
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ModelError(
      timeout.aborted ? '回应超时，请重试。' : '回应格式有误，请重试。',
      timeout.aborted ? 'timeout' : 'upstream_json',
    );
  }
  const usage = {
    input: Number(payload.usage?.input_tokens ?? payload.usage?.prompt_tokens ?? 0),
    output: Number(payload.usage?.output_tokens ?? payload.usage?.completion_tokens ?? 0),
  };
  if (payload.status === 'incomplete' || payload.choices?.[0]?.finish_reason === 'length')
    throw new ModelError('回应未完成，请重试。', 'incomplete', { usage });
  const content = isResponses
    ? payload.output
        ?.flatMap((item) => item.content || [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text)
        .join('') || payload.output_text
    : payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length > 18000)
    throw new ModelError('回应格式有误，请重试。', 'missing_content', { usage });
  let value;
  try {
    value = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
  } catch {
    throw new ModelError('回应格式有误，请重试。', 'invalid_json', { usage });
  }
  const result = (round ? RoundSchema : DecisionSchema).safeParse(
    round ? omitEmptyOptionals(value) : value,
  );
  if (!result.success)
    throw new ModelError('回应格式有误，请重试。', 'invalid_fields', {
      usage,
      issues: result.error.issues,
    });
  return { [round ? 'round' : 'decision']: result.data, usage, model: config.model };
}
