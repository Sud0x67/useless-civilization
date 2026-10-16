import type { World } from './schema';
import type { AgentId, EventId } from '../world/engine';
export type TownAction =
  | { type: 'round' }
  | { type: 'event'; eventId: EventId; prepared?: boolean }
  | { type: 'chat'; agentId: AgentId; text: string; messageId?: number }
  | { type: 'join' };
export type TownTask = {
  id: number;
  kind: 'human';
  action: TownAction;
  mine: boolean;
  author: string;
  state: string;
  error: string;
};
export type SharedState = {
  you: string;
  world: World;
  version: number;
  tasks: TownTask[];
  active: { id: number; kind: 'automatic' | 'human' } | null;
  online: number;
  running: boolean;
  autoError: string;
  quota: { usedHour: number; hourLimit: number; usedDay: number; dayLimit: number; nextAt: number };
  budget: { minuteUsed: number; dayUsed: number; dayLimit: number; resetsAt: number };
  usage: { calls: number; input: number; output: number };
  limits: { perVisitorPending: number; queue: number; interval: number };
};
