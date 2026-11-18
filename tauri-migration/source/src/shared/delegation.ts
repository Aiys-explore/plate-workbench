export interface DelegationContext {
  home: string
  noteDirectory: string
  platform: string
}

import type { Note } from './ipc'

export interface DelegationSource {
  readonly noteId: string
  readonly baseRevision: string
  readonly draft: boolean
  // Selection coordinates, used only to verify the saved source at this revision.
  readonly line: number
  readonly rawLine: string
  readonly blockId?: string
}

export interface DelegationRequest {
  readonly version: 2
  readonly intentId: string
  readonly source: DelegationSource & { readonly blockId: string }
  readonly profileId: string
  readonly model: string | null
  readonly effort: string | null
  readonly cwd: string
  // Only an explicit one-off override. The default prompt is derived in main.
  readonly textOverride?: string
}

export type DelegationPhase = 'reserved' | 'dispatching' | 'bound' | 'finished' | 'cancelled'
export const delegationRecovery = {
  reserved: 'retry-before-dispatch', dispatching: 'verify-dispatch', bound: 'track-bound-session',
  finished: 'finished', cancelled: 'cancelled'
} as const satisfies Record<DelegationPhase, string>
export type DelegationReceipt = {
  code: 'owner' | 'coalesced' | 'active-conflict'
  replay: boolean
  runId: string
  phase: DelegationPhase
  recovery: typeof delegationRecovery[DelegationPhase]
}
export type DelegationRejection = 'invalid-request' | 'source-changed' | 'source-unverified' |
  'anchor-missing' | 'anchor-ambiguous' | 'anchor-mismatch' | 'anchor-owner-mismatch' |
  'intent-mismatch' | 'bound-to-other-agent' | 'invalid-task' | 'invalid-profile' | 'storage-error'

export type DelegationResult = { status: 'not-executed'; reason: string; receipt: DelegationReceipt } |
  { status: 'rejected'; code: DelegationRejection; reason: string }
export type DelegationAnchorResult = { status: 'saved'; note: Note; at: number; insert: string } |
  { status: 'rejected'; code: DelegationRejection; reason: string }

export type LaunchState = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' |
  'timed-out' | 'not-started' | 'unresolved' | 'handoff-ready' | 'handoff-copied' | 'handoff-linked'
export interface LaunchView {
  runId: string
  state: LaunchState
  reason: string
  cancellable: boolean
  externalId?: string
  canMatch?: boolean
  hasDiagnostic?: boolean
}
export type LaunchResult = { status: 'run'; view: LaunchView } | { status: 'rejected'; reason: string }
export type HandoffCandidate = { token: string; externalId: string; at: string }
export type HandoffMatches = { candidates: HandoffCandidate[]; reason: string }

export type LaunchExpectation = { kind: 'resume' | 'reserved'; runId: string }
export type LaunchReview = { kind: 'new' } | { kind: 'resume'; runId: string; externalId: string; profileId: string } |
  { kind: 'pending'; view: LaunchView; phase: DelegationPhase; canContinue: boolean; canDiscard: boolean;
    confirmedMode?: 'cli' | 'manual' } | { kind: 'blocked'; reason: string }

export interface DelegationApi {
  context(noteId: string): Promise<DelegationContext>
  addAnchor(source: DelegationSource): Promise<DelegationAnchorResult>
  submit(request: DelegationRequest): Promise<DelegationResult>
  start(request: DelegationRequest, profileRevision: string, mode: 'cli' | 'manual', expected?: LaunchExpectation): Promise<LaunchResult>
  review(source: DelegationSource): Promise<LaunchReview>
  reconcile(source: DelegationSource, runId: string): Promise<LaunchReview>
  discardReservation(source: DelegationSource, runId: string): Promise<LaunchReview>
  status(runId: string): Promise<LaunchView | null>
  cancel(runId: string): Promise<LaunchView | null>
  copyHandoff(runId: string): Promise<LaunchView | null>
  findHandoff(runId: string): Promise<HandoffMatches>
  linkHandoff(runId: string, token: string): Promise<LaunchView | null>
}
