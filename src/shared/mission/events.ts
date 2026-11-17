import type { CommandKind, ContextVersion, Crew, TerminalHandle } from './contract'
import type {
  ArtifactId,
  CommandRequestId,
  EventId,
  EventSeq,
  MissionId,
  Sha256Hash,
  SlotId,
  TerminalHandleId,
} from './ids'

interface MissionEventBase {
  readonly eventId: EventId
  readonly seq: EventSeq
  readonly missionId: MissionId
  readonly occurredAt: number
}

export type LaunchFailureKind = 'launch-failed' | 'delivery-failed'

export type UserDecision = 'retry-launch' | 'abandon' | 'note-acknowledged'

export type MissionEvent =
  | (MissionEventBase & {
      readonly kind: 'mission-created'
      readonly title: string
      readonly crew: Crew
      readonly contextVersions: readonly ContextVersion[]
    })
  | (MissionEventBase & { readonly kind: 'mission-confirmed' })
  | (MissionEventBase & { readonly kind: 'mission-cancelled'; readonly reason: string })
  | (MissionEventBase & { readonly kind: 'mission-archived' })
  | (MissionEventBase & { readonly kind: 'host-restarted'; readonly hostEpoch: number })
  | (MissionEventBase & {
      readonly kind: 'command-requested'
      readonly slotId: SlotId
      readonly requestId: CommandRequestId
      readonly commandKind: CommandKind
      readonly payloadDigest: Sha256Hash | null
    })
  | (MissionEventBase & {
      readonly kind: 'command-acknowledged'
      readonly slotId: SlotId
      readonly requestId: CommandRequestId
      readonly terminalHandle: TerminalHandle | null
    })
  | (MissionEventBase & {
      readonly kind: 'command-failed'
      readonly slotId: SlotId
      readonly requestId: CommandRequestId
      readonly failureKind: LaunchFailureKind
      readonly reason: string
    })
  | (MissionEventBase & {
      readonly kind: 'command-uncertain'
      readonly slotId: SlotId
      readonly requestId: CommandRequestId
      readonly reason: string
    })
  | (MissionEventBase & {
      readonly kind: 'terminal-receipt'
      readonly slotId: SlotId
      readonly handleId: TerminalHandleId
      readonly liveness: 'alive' | 'exited'
      readonly receiptToken: string
    })
  | (MissionEventBase & { readonly kind: 'slot-waiting-input'; readonly slotId: SlotId; readonly prompt: string })
  | (MissionEventBase & { readonly kind: 'slot-blocked'; readonly slotId: SlotId; readonly reason: string })
  | (MissionEventBase & { readonly kind: 'slot-reported'; readonly slotId: SlotId; readonly summary: string })
  | (MissionEventBase & { readonly kind: 'slot-completed'; readonly slotId: SlotId; readonly summary: string })
  | (MissionEventBase & {
      readonly kind: 'artifact-registered'
      readonly slotId: SlotId
      readonly artifactId: ArtifactId
      readonly noteRef: string | null
    })
  | (MissionEventBase & {
      readonly kind: 'user-decision-recorded'
      readonly slotId: SlotId | null
      readonly decision: UserDecision
      readonly note: string
    })
