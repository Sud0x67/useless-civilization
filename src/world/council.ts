import type { Council, CouncilProposal, Round, World } from '../shared/schema';
import { lawId, constitutionSizeError } from '../shared/schema.ts';
import { addFeed, applyEvent } from './engine.ts';

export const councilTopics = [
  {
    id: 'bread',
    lawTitle: '面包共享',
    rule: '粮仓开放时优先保障基本饮食，避免浪费和囤积。',
    alternative: '面包优先分给饥饿的居民，余粮由大家协商分配。',
    title: '今天的面包，要不要免费？',
    description: '开放粮仓，办一场免费面包日。',
    effect: '补充 75 食物，所有居民饥饿降低 35、幸福提升 12。',
  },
  {
    id: 'rain',
    lawTitle: '星雨与休息',
    rule: '居民可以自由欣赏星星雨、休息或继续工作。',
    alternative: '星星雨期间安排轮流值守，让每位居民都有观赏与休息的机会。',
    title: '要不要为小镇下一场星星雨？',
    description: '让普通的一天，有一点值得抬头的事。',
    effect: '触发星星雨，持续小镇时间 3 小时。',
  },
  {
    id: 'compliments',
    lawTitle: '公平交易',
    rule: '夸奖作为货币期间，交易应真诚、平等，不得以羞辱换取面包。',
    alternative: '交易时尊重对方，接受朴实的感谢，不强求夸张的赞美。',
    title: '用夸奖代替金币，试一试？',
    description: '面包的价格，暂时是一句真心话。',
    effect: '夸奖成为货币，持续小镇时间 6 小时。',
  },
  {
    id: 'memories',
    lawTitle: '记忆与身份',
    rule: '尊重记忆交换者的感受，允许居民讨论与重新认识自己的身份。',
    alternative: '交换记忆后先听取参与者的感受，不以获得的记忆嘲弄他人。',
    title: '要不要交换两个人的记忆？',
    description: '随机两位居民交换最近记忆，看看故事会往哪里走。',
    effect: '两位居民立即交换记忆，混乱提升 9。',
  },
  {
    id: 'mayors',
    lawTitle: '公共协商',
    rule: '公共事务通过协商处理，不得以镇长身份压制其他居民。',
    alternative: '公共事务轮流听取六位居民的意见，再公开说明共同决定。',
    title: '让每个人都当一次镇长？',
    description: '六位镇长，一座小镇。也许没有人需要开会。',
    effect: '触发全民镇长，混乱提升 22，持续小镇时间 3 小时。',
  },
] as const;
export const COUNCIL_DURATION = 45000;
export const COUNCIL_BREAK = 15 * 60000;
export const AI_PROPOSAL_MAX_DELAY = 30 * 60000;
export function proposalTarget(input: World, proposal: CouncilProposal) {
  const matches = (input.laws || []).filter((law) => law.topic === proposal.topic);
  return proposal.lawId
    ? matches.find((law) => lawId(law) === proposal.lawId)
    : matches.length === 1
      ? matches[0]
      : undefined;
}
export function proposedLaws(
  input: World,
  proposal: CouncilProposal,
  motionId: string,
  now: number,
) {
  const previous = proposal.operation === 'adopt' ? undefined : proposalTarget(input, proposal);
  const laws = (input.laws || []).filter((law) => !previous || lawId(law) !== lawId(previous));
  if (proposal.operation !== 'repeal')
    laws.push({
      id: previous ? lawId(previous) : motionId,
      topic: proposal.topic,
      rule: proposal.rule!,
      revision: (previous?.revision || 0) + 1,
      updatedAt: now,
      motionId,
    });
  return laws;
}
export function proposalError(
  input: World,
  proposal: CouncilProposal,
  motionId: string,
  now: number,
) {
  const previous = proposal.operation === 'adopt' ? undefined : proposalTarget(input, proposal);
  if (proposal.operation !== 'adopt' && !previous) return '条款已变化，请按现行宪法重新提交。';
  if (proposal.operation === 'adopt' && proposal.lawId) return '新增条款不能指定已有编号。';
  if (proposal.operation === 'amend' && proposal.rule === previous?.rule) return '条款内容未改变。';
  if (
    proposal.operation !== 'repeal' &&
    input.laws?.some((law) => law.rule === proposal.rule && law !== previous)
  )
    return '已有相同条款，请勿重复提议。';
  return constitutionSizeError(proposedLaws(input, proposal, motionId, now));
}
export function councilDescription(motion: Council) {
  const topic = councilTopics.find((item) => item.id === motion.topic)!;
  const operation = motion.operation || 'adopt';
  return {
    title:
      operation === 'adopt'
        ? topic.title
        : `${operation === 'amend' ? '修订' : '废止'}「${topic.lawTitle}」条款？`,
    description:
      operation === 'adopt'
        ? topic.description
        : operation === 'amend'
          ? '以新条文替换现行条文，票决通过后生效。'
          : '移除这项现行条款，票决通过后不再约束居民。',
    effect:
      operation === 'adopt'
        ? `${topic.effect} 将「${topic.lawTitle}」写入宪法。`
        : operation === 'amend'
          ? '更新原条款及修订版本，不新增重复条款。'
          : '从现行宪法中移除该条款。',
    rule: motion.rule || topic.rule,
    operation,
  };
}
export function councilTally(motion: Council) {
  const residentYes = motion.residents.filter((vote) => vote.choice === 'yes').length;
  const residentNo = motion.residents.length - residentYes;
  return {
    residentYes,
    residentNo,
    yes: residentYes + motion.visitorYes,
    no: residentNo + motion.visitorNo,
  };
}
export function openCouncil(
  input: World,
  topic: Council['topic'],
  id: string,
  now: number,
  proposal?: CouncilProposal,
): World {
  const world = structuredClone(input);
  const existing =
    proposal?.operation === 'adopt'
      ? undefined
      : proposal
        ? proposalTarget(world, proposal)
        : world.laws?.find((law) => law.topic === topic);
  const definition = councilTopics.find((item) => item.id === topic)!;
  world.council = {
    id,
    topic,
    operation: proposal?.operation || (existing ? 'amend' : 'adopt'),
    ...(proposal?.lawId ? { lawId: proposal.lawId } : existing ? { lawId: lawId(existing) } : {}),
    rule:
      proposal?.operation === 'repeal'
        ? existing?.rule || definition.rule
        : proposal?.rule ||
          (existing?.rule === definition.rule ? definition.alternative : definition.rule),
    openedAt: now,
    closesAt: now + COUNCIL_DURATION,
    status: 'open',
    residents: [],
    visitorYes: 0,
    visitorNo: 0,
    visitorAbstain: 0,
    closedAt: null,
    result: null,
  };
  addFeed(world, `小镇议会开题：${councilDescription(world.council).title}`, null, 'event');
  return world;
}
export function recordCouncilOpinions(
  input: World,
  round: Round,
  motionId: string | undefined,
  now: number,
): World {
  const motion = input.council;
  if (!motion || motion.id !== motionId || motion.status !== 'open' || now >= motion.closesAt)
    return input;
  const world = structuredClone(input);
  for (const plan of round.decisions) {
    if (
      plan.councilVote?.motionId !== motion.id ||
      world.council!.residents.some((vote) => vote.agentId === plan.agentId)
    )
      continue;
    world.council!.residents.push({
      agentId: plan.agentId,
      choice: plan.councilVote.choice,
      opinion: plan.speech,
    });
  }
  return world;
}
export function closeCouncil(input: World, now: number): World {
  const motion = input.council;
  if (!motion || motion.status !== 'open' || now < motion.closesAt) return input;
  const { yes, no } = councilTally(motion);
  let result: 'tied' | 'passed' | 'rejected' =
    yes === no ? 'tied' : yes > no ? 'passed' : 'rejected';
  const operation = motion.operation || 'adopt';
  const proposal = {
    topic: motion.topic,
    operation,
    lawId: motion.lawId,
    rule: councilDescription(motion).rule,
  };
  const error = result === 'passed' ? proposalError(input, proposal, motion.id, now) : null;
  if (error) result = 'rejected';
  const world =
    result === 'passed' && operation === 'adopt'
      ? applyEvent(input, motion.topic, 'council')
      : structuredClone(input);
  if (result === 'passed') world.laws = proposedLaws(input, proposal, motion.id, now);
  world.council = {
    ...world.council!,
    status: 'closed',
    result,
    closedAt: now,
    ...(error ? { resolutionNote: error } : {}),
  };
  addFeed(
    world,
    `议会结果：${councilDescription(motion).title} 赞成 ${yes} · 反对 ${no}。${result === 'passed' ? '提案通过，已更新小镇宪法。' : result === 'tied' ? '平票，维持现状。' : '提案未通过，维持现状。'}`,
    null,
    'event',
  );
  return world;
}
