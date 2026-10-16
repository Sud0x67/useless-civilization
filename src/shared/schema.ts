import { z } from 'zod';
export const IDS = ['mira', 'otto', 'lin', 'ada', 'echo', 'soren'] as const;
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
  feed: z.array(FeedSchema).max(90),
  nextId: z.number().int().nonnegative(),
  human: z.boolean(),
  conversations: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        agentId: z.enum(IDS),
        role: z.enum(['human', 'model']),
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
});
export const RoundSchema = z
  .object({
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
