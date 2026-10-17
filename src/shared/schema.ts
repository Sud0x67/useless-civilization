import { z } from 'zod';
export const FEED_LIMIT = 200;
export const CONSTITUTION_LIMIT = 1024;
export const CONSTITUTION_TEXT_LIMIT = 16384;
export const CONSTITUTION_BYTES_LIMIT = 256 * 1024;
export const CONSTITUTION_CONTEXT_LIMIT = 128 * 1024;
export const IDS = ['mira', 'otto', 'lin', 'ada', 'echo', 'soren'] as const;
export const VoteChoiceSchema = z.enum(['yes', 'no']);
export const CouncilTopicSchema = z.enum(['bread', 'rain', 'compliments', 'memories', 'mayors']);
export const CouncilOperationSchema = z.enum(['adopt', 'amend', 'repeal']);
export const CouncilProposalSchema = z
  .object({
    topic: CouncilTopicSchema,
    operation: CouncilOperationSchema,
    lawId: z.string().uuid().optional(),
    rule: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((proposal) => proposal.operation === 'repeal' || Boolean(proposal.rule));
export type CouncilProposal = z.infer<typeof CouncilProposalSchema>;
export const ConstitutionLawSchema = z.object({
  id: z.string().uuid().optional(),
  topic: CouncilTopicSchema,
  rule: z.string().trim().min(1).max(300),
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  motionId: z.string().uuid(),
});
export type ConstitutionLaw = z.infer<typeof ConstitutionLawSchema>;
export const lawId = (law: ConstitutionLaw) => law.id || law.motionId;
export const constitutionContext = (laws: ConstitutionLaw[]) =>
  laws.map((law) => ({ id: lawId(law), topic: law.topic, rule: law.rule }));
export function constitutionSizeError(laws: ConstitutionLaw[]): string | null {
  if (laws.length > CONSTITUTION_LIMIT) return '宪法最多保留 1024 条，请修订或废止已有条款。';
  if (laws.reduce((total, law) => total + law.rule.length, 0) > CONSTITUTION_TEXT_LIMIT)
    return '宪法正文已达总量上限，请精简已有条款。';
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (
    bytes(laws) > CONSTITUTION_BYTES_LIMIT ||
    bytes(constitutionContext(laws)) > CONSTITUTION_CONTEXT_LIMIT
  )
    return '宪法已达容量上限，请精简已有条款。';
  return null;
}
export const ConstitutionLawsSchema = z.array(ConstitutionLawSchema).superRefine((laws, ctx) => {
  const error = constitutionSizeError(laws);
  if (error) ctx.addIssue({ code: 'custom', message: error });
  if (new Set(laws.map(lawId)).size !== laws.length)
    ctx.addIssue({ code: 'custom', message: '条款编号必须唯一。' });
});
export const CouncilSchema = z
  .object({
    id: z.string().uuid(),
    topic: CouncilTopicSchema,
    operation: CouncilOperationSchema.optional(),
    lawId: z.string().uuid().optional(),
    proposer: z.enum(IDS).optional(),
    resolutionNote: z.string().max(200).optional(),
    rule: z.string().trim().min(1).max(300).optional(),
    openedAt: z.number().int().nonnegative(),
    closesAt: z.number().int().nonnegative(),
    status: z.enum(['open', 'closed']),
    residents: z
      .array(
        z.object({
          agentId: z.enum(IDS),
          choice: VoteChoiceSchema,
          opinion: z.string().min(1).max(180),
        }),
      )
      .max(6)
      .refine((votes) => new Set(votes.map((vote) => vote.agentId)).size === votes.length),
    visitorYes: z.number().int().nonnegative(),
    visitorNo: z.number().int().nonnegative(),
    visitorAbstain: z.number().int().nonnegative(),
    closedAt: z.number().int().nonnegative().nullable(),
    result: z.enum(['passed', 'rejected', 'tied']).nullable(),
  })
  .refine(
    (motion) =>
      motion.closesAt > motion.openedAt &&
      (motion.status === 'open'
        ? motion.result === null && motion.closedAt === null
        : motion.result !== null && motion.closedAt !== null && motion.closedAt >= motion.closesAt),
  );
export type Council = z.infer<typeof CouncilSchema>;
export type VoteChoice = z.infer<typeof VoteChoiceSchema>;
export const ConstitutionArticleSchema = z.object({
  id: z.number().int().positive(),
  motionId: z.string().uuid(),
  topic: CouncilTopicSchema,
  decidedAt: z.number().int().nonnegative(),
  result: z.enum(['passed', 'rejected', 'tied']),
  yes: z.number().int().nonnegative(),
  no: z.number().int().nonnegative(),
  residentAbstain: z.number().int().min(0).max(6),
  visitorAbstain: z.number().int().nonnegative(),
  operation: CouncilOperationSchema.optional(),
  lawId: z.string().uuid().optional(),
  rule: z.string().trim().min(1).max(300).optional(),
});
export type ConstitutionArticle = z.infer<typeof ConstitutionArticleSchema>;
export const PLACES = ['square', 'hall', 'market', 'farm', 'workshop', 'cafe', 'garden'] as const;
export const ACTIONS = ['work', 'rest', 'socialize', 'wander'] as const;
export const DecisionSchema = z
  .object({
    action: z.enum(ACTIONS),
    location: z.enum(PLACES),
    speech: z.string().min(1).max(180),
    reason: z.string().min(1).max(180),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;
const bounded = z.number().finite().min(0).max(100);
export const AgentSchema = z.object({
  id: z.enum(IDS),
  name: z.string().max(30),
  role: z.string().max(30),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  personality: z.string().max(300),
  goal: z.string().max(160),
  hunger: bounded,
  energy: bounded,
  happiness: bounded,
  coins: z.number().finite().min(0).max(999),
  influence: bounded,
  location: z.enum(PLACES),
  action: z.enum(ACTIONS),
  activity: z.string().max(160),
  speech: z.string().max(200),
  memories: z.array(z.string().max(300)).max(12),
  relationships: z.record(z.enum(IDS), z.number().min(-100).max(100)),
  source: z.enum(['local', 'model']),
});
export type Agent = z.infer<typeof AgentSchema>;
export const EVENT_IDS = [
  'mayors',
  'compliments',
  'no-meetings',
  'memories',
  'bread',
  'rain',
] as const;
export const FeedSchema = z.object({
  id: z.number().int().nonnegative(),
  minute: z.number().int().nonnegative(),
  type: z.enum(['arrival', 'social', 'work', 'event', 'system', 'chat']),
  actor: z.enum(IDS).nullable(),
  text: z.string().max(500),
  source: z.enum(['local', 'model', 'human']),
  author: z.string().max(20).optional(),
});
export const WorldSchema = z.object({
  seed: z.number().int().min(0).max(4294967295),
  minute: z.number().int().min(0).max(10000000),
  tick: z.number().int().nonnegative(),
  agents: z
    .array(AgentSchema)
    .length(6)
    .refine((a) => new Set(a.map((x) => x.id)).size === 6, '居民 ID 必须唯一'),
  food: z.number().finite().min(0).max(200),
  harmony: bounded,
  chaos: bounded,
  mayor: z.enum(IDS),
  effects: z
    .array(z.object({ id: z.enum(EVENT_IDS), until: z.number().int().nonnegative() }))
    .max(6),
  feed: z.array(FeedSchema).max(FEED_LIMIT),
  nextId: z.number().int().nonnegative(),
  human: z.boolean(),
  council: CouncilSchema.optional(),
  constitution: z.array(ConstitutionArticleSchema).max(20).optional(),
  laws: ConstitutionLawsSchema.optional(),
  conversations: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        agentId: z.enum(IDS),
        role: z.enum(['human', 'model']),
        author: z.string().max(20).optional(),
        text: z.string().max(500),
        minute: z.number().int().nonnegative(),
        replyTo: z.number().int().nonnegative().optional(),
      }),
    )
    .max(120)
    .default([]),
});
export type World = z.infer<typeof WorldSchema>;
export type ChatEntry = World['conversations'][number];
export type FeedItem = z.infer<typeof FeedSchema>;
export const ReplaySchema = z.object({
  version: z.literal(1),
  snapshots: z.array(WorldSchema).min(1).max(120),
});
export const ModelRequestSchema = z.object({
  agentId: z.enum(IDS),
  world: WorldSchema,
  prompt: z.string().max(300).optional(),
});
export const RoundDecisionSchema = DecisionSchema.extend({
  agentId: z.enum(IDS),
  target: z.enum(IDS).nullable().optional(),
  intent: z.enum(['none', 'praise', 'argue', 'trade', 'support']).optional(),
  councilVote: z
    .object({ motionId: z.string().uuid(), choice: VoteChoiceSchema })
    .strict()
    .optional(),
});
export const RoundSchema = z
  .object({
    councilProposal: z
      .object({
        agentId: z.enum(IDS),
        proposal: CouncilProposalSchema,
        reason: z.string().trim().min(1).max(80),
      })
      .strict()
      .optional(),
    decisions: z
      .array(RoundDecisionSchema)
      .length(6)
      .refine(
        (rows) => new Set(rows.map((a) => a.agentId)).size === 6,
        '每名居民必须有且仅有一个决策',
      ),
  })
  .strict();
export type Round = z.infer<typeof RoundSchema>;
export const TurnRequestSchema = z.object({ world: WorldSchema });
