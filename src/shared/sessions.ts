export const sessionAdapters = ['codex', 'deepseek', 'zcode'] as const
export type SessionAdapter = typeof sessionAdapters[number]
export type SessionStatus = 'UNKNOWN' | 'PAUSED' | 'STARTING' | 'DOING' | 'PENDING' | 'REVIEW' | 'ERROR' | 'DONE'
export interface Usage {
  input?: number; output?: number; cachedInput?: number; cacheWrite?: number; reasoning?: number; total?: number
}
export interface ObservedNumber { value: number; source: string; at: number | null }
export interface ContextOccupancy { used: number; window: number; source: string }
export interface SessionSummary {
  adapter: SessionAdapter; id: string; cwd: string | null; project: string | null; parentId: string | null
  model: string | null; status: SessionStatus; lastAt: number | null; lastKind: string | null
  noProgress: boolean; reason: string; eventCount: number; messageCount: number; toolCount: number
  turnCount: number; usage: Usage; usageBasis: string | null
  contextWindow: ObservedNumber | null; recentContext: ObservedNumber | null
  contextOccupancy: ContextOccupancy | null; effort: string | null; step: string | null
  turnStartedAt: number | null; turnStoppedAt: number | null
  messageRevision?: string
}
export interface SessionMessage { offset: number; at: number | null; role: 'user' | 'assistant'; text: string; source: string }
export interface SessionMessageCursor { revision: string; before: number }
export type SessionMessagePage = { adapter: SessionAdapter; id: string } & (
  | { status: 'ok'; revision: string; before: number | null; total: number; items: SessionMessage[] }
  | { status: 'changed' | 'missing' }
)
export interface SessionDashboard {
  sessions: SessionSummary[]; day: UsageDay[]; today: Totals; dayStart: number; timeZone: string; sources: number; badLines: number
}
export interface SessionsApi {
  list(): Promise<SessionSummary[]>
  dashboard(): Promise<SessionDashboard>
  usage(days: 7 | 30, dimension: Dimension, filter?: string | null): Promise<UsageReport>
  manualLimit(limit: number | null): Promise<void>
  messages(adapter: SessionAdapter, id: string, before?: number, limit?: number): Promise<SessionMessage[]>
  messagePage(adapter: SessionAdapter, id: string, cursor?: SessionMessageCursor): Promise<SessionMessagePage>
}
import type { Dimension, Totals, UsageDay, UsageReport } from './usage'

