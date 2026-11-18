import type {
  ArtifactId,
  CommandRequestId,
  ContextVersionId,
  CrewTemplateId,
  EventId,
  EventSeq,
  MissionId,
  ProviderId,
  ProviderSessionId,
  Sha256Hash,
  SlotId,
  TerminalHandleId,
} from './ids'

export type MissionStatus =
  | 'draft'
  | 'confirmed'
  | 'running'
  | 'waiting-input'
  | 'partial-failure'
  | 'completed'
  | 'cancelled'
  | 'archived'

export type SlotStatus =
  | 'pending'
  | 'confirmed'
  | 'launching'
  | 'running'
  | 'waiting-input'
  | 'blocked'
  | 'failed'
  | 'uncertain'
  | 'completed'
  | 'stopped'

export type SlotOutcome = 'none' | 'completed' | 'failed' | 'uncertain' | 'stopped'

export type CommandKind = 'launch' | 'send-input' | 'deliver-context' | 'stop-round' | 'terminate'

export type CommandRequestStatus = 'pending' | 'acknowledged' | 'failed' | 'uncertain'

export type TerminalHandleKind = 'local-conpty' | 'external-session'

export type TerminalLiveness = 'unverified' | 'alive-confirmed' | 'exited'

export type SlotPermission =
  | 'read-note-library'
  | 'write-mission-workspace'
  | 'write-git-worktree'
  | 'terminal-io'
  | 'network-access'

export type PermissionSpec = Readonly<Record<SlotPermission, boolean>>

export const slotPermissions: readonly SlotPermission[] = [
  'read-note-library',
  'write-mission-workspace',
  'write-git-worktree',
  'terminal-io',
  'network-access',
] as const

export const permissionSpec = (granted: readonly SlotPermission[]): PermissionSpec => {
  const grantedSet = new Set(granted)
  const entries = slotPermissions.map((permission) => [permission, grantedSet.has(permission)] as const)
  return Object.fromEntries(entries) as PermissionSpec
}

export type ProviderFlavor = 'claude-code' | 'codex' | 'zcode' | 'deepseek-harness' | 'other'

export type ProviderVerification = 'unverified' | 'verified' | 'unsupported'

export interface ProviderDescriptor {
  readonly providerId: ProviderId
  readonly flavor: ProviderFlavor
  readonly displayName: string
  readonly version: string | null
  readonly verification: ProviderVerification
}

export interface SlotSpec {
  readonly slotId: SlotId
  readonly role: string
  readonly provider: ProviderDescriptor
  readonly workingDirectory: string
  readonly permissions: PermissionSpec
  readonly contextVersionId: ContextVersionId
}

export interface Crew {
  readonly templateId: CrewTemplateId | null
  readonly slots: readonly SlotSpec[]
}

export interface ContextVersion {
  readonly versionId: ContextVersionId
  readonly contentHash: Sha256Hash
  readonly createdAt: number
  readonly noteRefs: readonly string[]
}

export interface ProviderSessionRef {
  readonly providerId: ProviderId
  readonly sessionId: ProviderSessionId
}

export interface TerminalHandle {
  readonly handleId: TerminalHandleId
  readonly slotId: SlotId
  readonly kind: TerminalHandleKind
  readonly pid: number | null
  readonly providerSession: ProviderSessionRef | null
  readonly liveness: TerminalLiveness
  readonly lastReceiptEventId: EventId | null
  readonly createdAt: number
}

export interface CommandRequest {
  readonly requestId: CommandRequestId
  readonly slotId: SlotId
  readonly kind: CommandKind
  readonly payloadDigest: Sha256Hash | null
  readonly status: CommandRequestStatus
  readonly requestedAt: number
}

export interface SlotState {
  readonly slotId: SlotId
  readonly spec: SlotSpec
  readonly status: SlotStatus
  readonly statusSince: number
  readonly outcome: SlotOutcome
  readonly autoRetryBlocked: boolean
  readonly failureReason: string | null
  readonly uncertainReason: string | null
  readonly handleIds: readonly TerminalHandleId[]
  readonly livenessUnverified: boolean
  readonly lastReport: string | null
  readonly artifacts: readonly ArtifactId[]
}

export interface MissionState {
  readonly missionId: MissionId
  readonly title: string | null
  readonly confirmed: boolean
  readonly terminalOverride: 'cancelled' | 'archived' | null
  readonly status: MissionStatus
  readonly createdAt: number | null
  readonly confirmedAt: number | null
  readonly hostEpoch: number | null
  readonly crew: Crew | null
  readonly contextVersions: Readonly<Record<ContextVersionId, ContextVersion>>
  readonly slots: Readonly<Record<SlotId, SlotState>>
  readonly slotOrder: readonly SlotId[]
  readonly requests: Readonly<Record<CommandRequestId, CommandRequest>>
  readonly handles: Readonly<Record<TerminalHandleId, TerminalHandle>>
  readonly lastAppliedSeq: EventSeq
  readonly appliedEventIds: ReadonlySet<EventId>
}
