import type { Note } from './ipc'

export type RunState = 'STARTING' | 'DOING' | 'PENDING' | 'REVIEW' | 'DONE' | 'ERROR' | 'PAUSED' | 'UNKNOWN'
export type WriteState = 'none' | 'pending' | 'written' | 'conflict' | 'failed'
export type RunKey = { noteId: string; blockId: string; runId: string }
export type Basis = {
  ref: string; summary: string | null; startedAt: number | null; endedAt: number | null;
  tokens: number | null; source: string; tokenSource: string | null; archived: boolean
}
export type Wait = { id: string; kind: 'approval' | 'question'; at: number; text: string | null }
export type RunCard = RunKey & {
  state: RunState; reason: string; externalId?: string; client?: string; cwd?: string
  resumeRevision?: string
  hasDiagnostic?: boolean
  write: WriteState; issue: string; located: boolean; cancellable: boolean
  durationMs: number | null; active: boolean; observedAt: number | null; startedAt: number | null
  clockSource: string | null; region?: string; lastAt?: number; stale: boolean; noProgress: boolean; waits: Wait[]; basis?: Basis
}
export type EditorProof = { revision: string; generation: number; clean: boolean }
export type Candidate = { line: number; rawLine: string; context: string }
export type Review = {
  revision: string | null; draft: boolean; reason: string; current: string; proposed: string
  candidates: Candidate[]; action: 'insert' | 'update' | 'locate' | null; token?: string
}
export type Patch = { note: Note; from: number; to: number; insert: string; generation: number; revision: string }
export type Action = 'auto' | 'inspect' | 'apply' | 'locate' | 'done' | 'cancel' | 'reconcile'
export type ActionResult = { message: string; review?: Review; patch?: Patch }
export interface P10Api {
  list(noteId: string): Promise<RunCard[]>
  act(key: RunKey, action: Action, editor: EditorProof, token?: string, line?: number): Promise<ActionResult>
}

