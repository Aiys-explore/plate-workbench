import type { DelegationSource } from './delegation'
import type { RunKey } from './p10'

export type DiagnosticTarget = { kind: 'p09'; source: DelegationSource; runId: string } |
  { kind: 'p10'; key: RunKey }
export type DiagnosticPreview = Readonly<{ ticket: string; text: string }>
export type DiagnosticCopy = 'copied' | 'failed' | 'stale'
export interface DelegationDiagnosticApi {
  open(target: DiagnosticTarget): Promise<DiagnosticPreview | null>
  copy(ticket: string): Promise<DiagnosticCopy>
  close(ticket: string): Promise<void>
}
