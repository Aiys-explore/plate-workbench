import type { SessionAdapter, Usage } from './sessions'

export type Dimension = 'adapter' | 'model' | 'project'
export type Scope = { adapter: SessionAdapter; model: string | null; project: string | null; projectKey: string | null }
export const usageFields = ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning', 'total'] as const
export type Measure = { value: number | null; known: number; missing: number }
export type Totals = { tokens: Record<keyof Usage, Measure>; sessions: Measure; turns: Measure; calls: Measure }
export type Bucket = { key: string | null; label: string; totals: Totals }
export type UsageDay = Totals & { id: string; adapter: SessionAdapter; endedTurns: number | null; tokenTotal: number | null }
export interface Quota {
  source: string; at: number; scope: string; slot: 'primary' | 'secondary' | 'credits'
  unit: '%' | 'Codex credits'; limit: number | null; used: number | null
  windowMinutes: number | null; resetAt: number | null; balance: string | null
}
export interface UsageReport {
  days: Bucket[]; groups: Bucket[]; models: Bucket[]; total: Totals
  filter: { key: string | null; label: string }[]; timeZone: string; through: number
  undated: number; badLines: number; modelDenominator: number | null
  quota: Quota[]; manual: { limit: number; at: number } | null
}

