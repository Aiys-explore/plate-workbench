import type { RunKey } from './p10'
import type { SessionAdapter } from './sessions'

export type ResumeOrigin =
  | { kind: 'log'; adapter: SessionAdapter; id: string; revision: string }
  | ({ kind: 'run'; revision: string } & RunKey)
export type ResumeAction = 'desktop' | 'terminal' | 'copy-id' | 'copy-command'
export type ResumeView = {
  reason: string
  ticket?: string
  methods: ResumeAction[]
  subject?: { agent: string; id: string; cwd: string | null }
  conversation?: Extract<ResumeOrigin, { kind: 'log' }>
}
export type ResumeResult = { state: 'copied' | 'requested' | 'failed' | 'stale'; message: string; next?: ResumeView }
export interface ResumeApi {
  review(origin: ResumeOrigin): Promise<ResumeView>
  act(ticket: string, action: ResumeAction): Promise<ResumeResult>
  close(ticket: string): Promise<void>
}
