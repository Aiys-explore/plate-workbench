import type {
  CommandRequest,
  ContextVersion,
  MissionState,
  MissionStatus,
  SlotState,
  SlotStatus,
  TerminalHandle,
} from './contract'
import type { CommandRequestId, EventId, EventSeq, MissionId, SlotId } from './ids'
import { eventSeq } from './ids'
import type { MissionEvent } from './events'

export type EventRejectionCode =
  | 'mission-mismatch'
  | 'duplicate-event'
  | 'stale-seq'
  | 'seq-gap'
  | 'already-created'
  | 'duplicate-context-version'
  | 'unknown-context-version'
  | 'duplicate-slot'
  | 'confirm-not-allowed'
  | 'cancel-not-allowed'
  | 'archive-not-allowed'
  | 'unknown-slot'
  | 'duplicate-request'
  | 'slot-not-launchable'
  | 'uncertain-no-auto-retry'
  | 'slot-not-commandable'
  | 'slot-not-stoppable'
  | 'slot-status-conflict'
  | 'unknown-request'
  | 'request-slot-mismatch'
  | 'request-already-resolved'
  | 'missing-terminal-handle'
  | 'duplicate-handle'
  | 'handle-slot-mismatch'
  | 'invalid-handle'
  | 'unknown-handle'
  | 'receipt-contradicts-liveness'
  | 'duplicate-artifact'

export interface EventRejection {
  readonly code: EventRejectionCode
  readonly eventId: EventId
  readonly detail: string
}

export interface EventApplication {
  readonly state: MissionState
  readonly accepted: boolean
  readonly rejection: EventRejection | null
}

export interface MissionRebuild {
  readonly state: MissionState
  readonly rejections: readonly EventRejection[]
  readonly appliedCount: number
}

export const activeSlotStatuses: ReadonlySet<SlotStatus> = new Set<SlotStatus>([
  'launching',
  'running',
  'waiting-input',
  'blocked',
])

export const terminalSlotStatuses: ReadonlySet<SlotStatus> = new Set<SlotStatus>([
  'failed',
  'uncertain',
  'completed',
  'stopped',
])

const inputFromStatuses: ReadonlySet<SlotStatus> = new Set<SlotStatus>([
  'running',
  'waiting-input',
  'blocked',
])

const stopFromStatuses: ReadonlySet<SlotStatus> = new Set<SlotStatus>([
  'launching',
  'running',
  'waiting-input',
  'blocked',
])

const putEntry = <V>(record: Readonly<Record<string, V>>, key: string, value: V): Record<string, V> => {
  const next = { ...record } as Record<string, V>
  next[key] = value
  return next
}

const appendItem = <T>(list: readonly T[], item: T): T[] => [...list, item]

const withSlot = (state: MissionState, key: SlotId, patch: Partial<SlotState>): MissionState => {
  const current = state.slots[key]
  if (!current) return state
  return { ...state, slots: putEntry(state.slots, key, { ...current, ...patch }) }
}

const deriveMissionStatus = (state: MissionState): MissionStatus => {
  if (state.terminalOverride !== null) return state.terminalOverride
  if (!state.confirmed) return 'draft'
  const slots = state.slotOrder
    .map((key) => state.slots[key])
    .filter((slot): slot is SlotState => slot !== undefined)
  if (slots.length === 0) return 'confirmed'
  if (slots.some((slot) => slot.status === 'failed' || slot.status === 'uncertain')) return 'partial-failure'
  if (slots.every((slot) => slot.status === 'completed')) return 'completed'
  if (slots.some((slot) => slot.status === 'waiting-input')) return 'waiting-input'
  if (slots.some((slot) => activeSlotStatuses.has(slot.status))) return 'running'
  return 'confirmed'
}

export const emptyMissionState = (value: MissionId): MissionState => ({
  missionId: value,
  title: null,
  confirmed: false,
  terminalOverride: null,
  status: 'draft',
  createdAt: null,
  confirmedAt: null,
  hostEpoch: null,
  crew: null,
  contextVersions: {},
  slots: {},
  slotOrder: [],
  requests: {},
  handles: {},
  lastAppliedSeq: eventSeq(0),
  appliedEventIds: new Set<EventId>(),
})

export const nextSeq = (state: MissionState): EventSeq => eventSeq(state.lastAppliedSeq + 1)

type MergeResult =
  | { readonly ok: true; readonly state: MissionState }
  | { readonly ok: false; readonly code: EventRejectionCode; readonly detail: string }

const mergeOk = (state: MissionState): MergeResult => ({ ok: true, state })
const mergeFail = (code: EventRejectionCode, detail: string): MergeResult => ({ ok: false, code, detail })

const mergeMissionCreated = (state: MissionState, event: Extract<MissionEvent, { kind: 'mission-created' }>): MergeResult => {
  if (state.crew !== null) return mergeFail('already-created', 'mission-created was already applied')
  const contextVersions: Record<string, ContextVersion> = {}
  for (const version of event.contextVersions) {
    if (contextVersions[version.versionId] !== undefined) {
      return mergeFail('duplicate-context-version', `context version ${version.versionId} appears twice`)
    }
    contextVersions[version.versionId] = version
  }
  const slots: Record<string, SlotState> = {}
  const slotOrder: SlotId[] = []
  for (const spec of event.crew.slots) {
    if (slots[spec.slotId] !== undefined) return mergeFail('duplicate-slot', `slot ${spec.slotId} appears twice`)
    if (contextVersions[spec.contextVersionId] === undefined) {
      return mergeFail('unknown-context-version', `slot ${spec.slotId} references missing context ${spec.contextVersionId}`)
    }
    slots[spec.slotId] = {
      slotId: spec.slotId,
      spec,
      status: 'pending',
      statusSince: event.occurredAt,
      outcome: 'none',
      autoRetryBlocked: false,
      failureReason: null,
      uncertainReason: null,
      handleIds: [],
      livenessUnverified: false,
      lastReport: null,
      artifacts: [],
    }
    slotOrder.push(spec.slotId)
  }
  return mergeOk({
    ...state,
    title: event.title,
    crew: event.crew,
    createdAt: event.occurredAt,
    contextVersions: contextVersions as MissionState['contextVersions'],
    slots: slots as MissionState['slots'],
    slotOrder,
  })
}

const mergeMissionConfirmed = (state: MissionState, occurredAt: number): MergeResult => {
  if (state.crew === null) return mergeFail('confirm-not-allowed', 'mission has not been created')
  if (state.confirmed) return mergeFail('confirm-not-allowed', 'mission was already confirmed')
  if (state.terminalOverride !== null) return mergeFail('confirm-not-allowed', 'mission is already terminal')
  let slots = state.slots
  for (const key of state.slotOrder) {
    const slot = slots[key]
    if (slot && slot.status === 'pending') {
      slots = putEntry(slots, key, { ...slot, status: 'confirmed', statusSince: occurredAt })
    }
  }
  return mergeOk({ ...state, confirmed: true, confirmedAt: occurredAt, slots })
}

const resolvePendingRequest = (
  state: MissionState,
  requestId: CommandRequestId,
  status: CommandRequest['status'],
): MissionState => {
  const request = state.requests[requestId]
  if (!request) return state
  return { ...state, requests: putEntry(state.requests, requestId, { ...request, status }) }
}

const mergeTerminalReceipt = (state: MissionState, event: Extract<MissionEvent, { kind: 'terminal-receipt' }>): MergeResult => {
  const handle = state.handles[event.handleId]
  if (!handle) return mergeFail('unknown-handle', `handle ${event.handleId} is not registered`)
  if (handle.slotId !== event.slotId) {
    return mergeFail('handle-slot-mismatch', `handle ${event.handleId} belongs to slot ${handle.slotId}`)
  }
  if (event.liveness === 'alive') {
    if (handle.liveness !== 'unverified') {
      return mergeFail('receipt-contradicts-liveness', `handle is ${handle.liveness}; only unverified handles accept an alive receipt`)
    }
    const confirmed: TerminalHandle = { ...handle, liveness: 'alive-confirmed', lastReceiptEventId: event.eventId }
    let next: MissionState = { ...state, handles: putEntry(state.handles, event.handleId, confirmed) }
    const slot = next.slots[event.slotId]
    if (slot && activeSlotStatuses.has(slot.status)) {
      next = withSlot(next, event.slotId, { livenessUnverified: false })
    }
    return mergeOk(next)
  }
  if (handle.liveness === 'exited') {
    return mergeFail('receipt-contradicts-liveness', 'handle already has an exited receipt')
  }
  const exited: TerminalHandle = { ...handle, liveness: 'exited', lastReceiptEventId: event.eventId }
  return mergeOk({ ...state, handles: putEntry(state.handles, event.handleId, exited) })
}

const mergeEvent = (state: MissionState, event: MissionEvent): MergeResult => {
  switch (event.kind) {
    case 'mission-created':
      return mergeMissionCreated(state, event)

    case 'mission-confirmed':
      return mergeMissionConfirmed(state, event.occurredAt)

    case 'mission-cancelled': {
      if (state.terminalOverride !== null) {
        return mergeFail('cancel-not-allowed', `mission is already ${state.terminalOverride}`)
      }
      return mergeOk({ ...state, terminalOverride: 'cancelled' })
    }

    case 'mission-archived': {
      const derived = deriveMissionStatus(state)
      if (derived !== 'completed' && state.terminalOverride !== 'cancelled') {
        return mergeFail('archive-not-allowed', 'only completed or cancelled missions can be archived')
      }
      return mergeOk({ ...state, terminalOverride: 'archived' })
    }

    case 'host-restarted': {
      let handles = { ...state.handles } as Record<string, TerminalHandle>
      for (const key of Object.keys(handles)) {
        const handle = handles[key]
        if (handle && handle.liveness !== 'exited') {
          handles = putEntry<TerminalHandle>(handles, key, { ...handle, liveness: 'unverified', lastReceiptEventId: null })
        }
      }
      let slots = state.slots
      for (const key of state.slotOrder) {
        const slot = slots[key]
        if (slot && activeSlotStatuses.has(slot.status)) {
          slots = putEntry(slots, key, { ...slot, livenessUnverified: true })
        }
      }
      return mergeOk({ ...state, hostEpoch: event.hostEpoch, handles, slots })
    }

    case 'command-requested': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (state.requests[event.requestId] !== undefined) {
        return mergeFail('duplicate-request', `request ${event.requestId} was already recorded`)
      }
      const request: CommandRequest = {
        requestId: event.requestId,
        slotId: event.slotId,
        kind: event.commandKind,
        payloadDigest: event.payloadDigest,
        status: 'pending',
        requestedAt: event.occurredAt,
      }
      const withRequest = { ...state, requests: putEntry(state.requests, event.requestId, request) }
      if (event.commandKind === 'launch') {
        if (slot.status === 'uncertain') {
          return mergeFail('uncertain-no-auto-retry', 'uncertain slots require an explicit user decision retry-launch; automatic relaunch is forbidden')
        }
        if (slot.status !== 'confirmed') {
          return mergeFail('slot-not-launchable', `slot status is ${slot.status}; launch requires confirmed`)
        }
        return mergeOk(
          withSlot(withRequest, event.slotId, { status: 'launching', statusSince: event.occurredAt, autoRetryBlocked: false }),
        )
      }
      if (event.commandKind === 'send-input' || event.commandKind === 'deliver-context') {
        if (!inputFromStatuses.has(slot.status)) {
          return mergeFail('slot-not-commandable', `slot status is ${slot.status}; input and context delivery require an active slot`)
        }
        return mergeOk(withRequest)
      }
      if (!stopFromStatuses.has(slot.status)) {
        return mergeFail('slot-not-stoppable', `slot status is ${slot.status}; stop requires an active slot`)
      }
      return mergeOk(withRequest)
    }

    case 'command-acknowledged': {
      const request = state.requests[event.requestId]
      if (!request) return mergeFail('unknown-request', `request ${event.requestId} was never requested`)
      if (request.slotId !== event.slotId) {
        return mergeFail('request-slot-mismatch', `request ${event.requestId} belongs to slot ${request.slotId}`)
      }
      if (request.status !== 'pending') {
        return mergeFail('request-already-resolved', `request ${event.requestId} is already ${request.status}`)
      }
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      const withRequest = resolvePendingRequest(state, event.requestId, 'acknowledged')
      if (request.kind === 'launch') {
        if (slot.status !== 'launching') {
          return mergeFail('slot-status-conflict', `late launch acknowledgement cannot overwrite slot status ${slot.status}`)
        }
        const handle = event.terminalHandle
        if (!handle) return mergeFail('missing-terminal-handle', 'launch acknowledgement must carry a terminal handle')
        if (handle.slotId !== event.slotId) {
          return mergeFail('handle-slot-mismatch', `handle ${handle.handleId} claims slot ${handle.slotId}`)
        }
        if (state.handles[handle.handleId] !== undefined) {
          return mergeFail('duplicate-handle', `handle ${handle.handleId} already exists`)
        }
        if (handle.kind === 'local-conpty' && handle.pid !== null && (!Number.isInteger(handle.pid) || handle.pid <= 0)) {
          return mergeFail('invalid-handle', 'pid must be a positive integer or null')
        }
        if (handle.liveness !== 'unverified') {
          return mergeFail('invalid-handle', 'newly acknowledged handles must start unverified')
        }
        const withHandle: MissionState = {
          ...withRequest,
          handles: putEntry(withRequest.handles, handle.handleId, handle),
        }
        return mergeOk(
          withSlot(withHandle, event.slotId, {
            status: 'running',
            statusSince: event.occurredAt,
            livenessUnverified: true,
            handleIds: appendItem(slot.handleIds, handle.handleId),
          }),
        )
      }
      if (request.kind === 'send-input') {
        if (slot.status === 'waiting-input') {
          return mergeOk(withSlot(withRequest, event.slotId, { status: 'running', statusSince: event.occurredAt }))
        }
        return mergeOk(withRequest)
      }
      if (request.kind === 'stop-round' || request.kind === 'terminate') {
        if (!stopFromStatuses.has(slot.status)) {
          return mergeFail('slot-status-conflict', `late stop acknowledgement cannot overwrite slot status ${slot.status}`)
        }
        return mergeOk(
          withSlot(withRequest, event.slotId, {
            status: 'stopped',
            statusSince: event.occurredAt,
            outcome: 'stopped',
            livenessUnverified: false,
          }),
        )
      }
      return mergeOk(withRequest)
    }

    case 'command-failed': {
      const request = state.requests[event.requestId]
      if (!request) return mergeFail('unknown-request', `request ${event.requestId} was never requested`)
      if (request.slotId !== event.slotId) {
        return mergeFail('request-slot-mismatch', `request ${event.requestId} belongs to slot ${request.slotId}`)
      }
      if (request.status !== 'pending') {
        return mergeFail('request-already-resolved', `request ${event.requestId} is already ${request.status}`)
      }
      const withRequest = resolvePendingRequest(state, event.requestId, 'failed')
      if (request.kind !== 'launch') return mergeOk(withRequest)
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (slot.status !== 'launching') {
        return mergeFail('slot-status-conflict', `late launch failure cannot overwrite slot status ${slot.status}`)
      }
      return mergeOk(
        withSlot(withRequest, event.slotId, {
          status: 'failed',
          statusSince: event.occurredAt,
          outcome: 'failed',
          failureReason: event.reason,
          livenessUnverified: false,
        }),
      )
    }

    case 'command-uncertain': {
      const request = state.requests[event.requestId]
      if (!request) return mergeFail('unknown-request', `request ${event.requestId} was never requested`)
      if (request.slotId !== event.slotId) {
        return mergeFail('request-slot-mismatch', `request ${event.requestId} belongs to slot ${request.slotId}`)
      }
      if (request.status !== 'pending') {
        return mergeFail('request-already-resolved', `request ${event.requestId} is already ${request.status}`)
      }
      const withRequest = resolvePendingRequest(state, event.requestId, 'uncertain')
      if (request.kind !== 'launch') return mergeOk(withRequest)
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (slot.status !== 'launching') {
        return mergeFail('slot-status-conflict', `late launch uncertainty cannot overwrite slot status ${slot.status}`)
      }
      return mergeOk(
        withSlot(withRequest, event.slotId, {
          status: 'uncertain',
          statusSince: event.occurredAt,
          outcome: 'uncertain',
          uncertainReason: event.reason,
          autoRetryBlocked: true,
          livenessUnverified: false,
        }),
      )
    }

    case 'terminal-receipt':
      return mergeTerminalReceipt(state, event)

    case 'slot-waiting-input': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (slot.status !== 'running' && slot.status !== 'blocked') {
        return mergeFail('slot-status-conflict', `slot status is ${slot.status}; waiting-input requires running or blocked`)
      }
      return mergeOk(withSlot(state, event.slotId, { status: 'waiting-input', statusSince: event.occurredAt }))
    }

    case 'slot-blocked': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (slot.status !== 'running' && slot.status !== 'waiting-input') {
        return mergeFail('slot-status-conflict', `slot status is ${slot.status}; blocked requires running or waiting-input`)
      }
      return mergeOk(withSlot(state, event.slotId, { status: 'blocked', statusSince: event.occurredAt }))
    }

    case 'slot-reported': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (!activeSlotStatuses.has(slot.status)) {
        return mergeFail('slot-status-conflict', `late report cannot overwrite terminal slot status ${slot.status}`)
      }
      return mergeOk(withSlot(state, event.slotId, { lastReport: event.summary }))
    }

    case 'slot-completed': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (slot.status !== 'running' && slot.status !== 'waiting-input' && slot.status !== 'blocked') {
        return mergeFail('slot-status-conflict', `late completion cannot overwrite slot status ${slot.status}`)
      }
      return mergeOk(
        withSlot(state, event.slotId, {
          status: 'completed',
          statusSince: event.occurredAt,
          outcome: 'completed',
          livenessUnverified: false,
        }),
      )
    }

    case 'artifact-registered': {
      const slot = state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', `slot ${event.slotId} does not exist`)
      if (!activeSlotStatuses.has(slot.status) && slot.status !== 'completed') {
        return mergeFail('slot-status-conflict', `slot status is ${slot.status}; artifacts register on active or completed slots`)
      }
      if (slot.artifacts.includes(event.artifactId)) {
        return mergeFail('duplicate-artifact', `artifact ${event.artifactId} is already registered`)
      }
      return mergeOk(withSlot(state, event.slotId, { artifacts: appendItem(slot.artifacts, event.artifactId) }))
    }

    case 'user-decision-recorded': {
      if (event.decision === 'note-acknowledged') return mergeOk(state)
      const slot = event.slotId === null ? undefined : state.slots[event.slotId]
      if (!slot) return mergeFail('unknown-slot', 'decision requires the slotId of an existing slot')
      if (slot.status !== 'failed' && slot.status !== 'uncertain') {
        return mergeFail('slot-status-conflict', `decision applies only to failed or uncertain slots, not ${slot.status}`)
      }
      if (event.decision === 'retry-launch') {
        return mergeOk(
          withSlot(state, event.slotId!, {
            status: 'confirmed',
            statusSince: event.occurredAt,
            outcome: 'none',
            autoRetryBlocked: false,
            failureReason: null,
            uncertainReason: null,
          }),
        )
      }
      return mergeOk(
        withSlot(state, event.slotId!, {
          status: 'stopped',
          statusSince: event.occurredAt,
          outcome: 'stopped',
          livenessUnverified: false,
        }),
      )
    }
  }
}

export const applyEvent = (state: MissionState, event: MissionEvent): EventApplication => {
  const rejected = (code: EventRejectionCode, detail: string): EventApplication => ({
    state,
    accepted: false,
    rejection: { code, eventId: event.eventId, detail },
  })
  if (event.missionId !== state.missionId) {
    return rejected('mission-mismatch', `event belongs to ${event.missionId}, state belongs to ${state.missionId}`)
  }
  if (state.appliedEventIds.has(event.eventId)) {
    return rejected('duplicate-event', `event ${event.eventId} was already applied`)
  }
  if (event.seq <= state.lastAppliedSeq) {
    return rejected('stale-seq', `event seq ${event.seq} is not newer than applied seq ${state.lastAppliedSeq}`)
  }
  if (event.seq > state.lastAppliedSeq + 1) {
    return rejected('seq-gap', `event seq ${event.seq} skips expected seq ${state.lastAppliedSeq + 1}`)
  }
  const merged = mergeEvent(state, event)
  if (!merged.ok) return rejected(merged.code, merged.detail)
  const nextState: MissionState = {
    ...merged.state,
    lastAppliedSeq: event.seq,
    appliedEventIds: new Set(state.appliedEventIds).add(event.eventId),
    status: deriveMissionStatus(merged.state),
  }
  return { state: nextState, accepted: true, rejection: null }
}

export const reduceEvents = (events: readonly MissionEvent[], initial: MissionState): EventApplication => {
  let current = initial
  for (const event of events) {
    const applied = applyEvent(current, event)
    if (!applied.accepted) {
      return { state: current, accepted: false, rejection: applied.rejection }
    }
    current = applied.state
  }
  return { state: current, accepted: true, rejection: null }
}

export const rebuildMissionState = (value: MissionId, events: readonly MissionEvent[]): MissionRebuild => {
  let state = emptyMissionState(value)
  const rejections: EventRejection[] = []
  let appliedCount = 0
  for (const event of events) {
    const applied = applyEvent(state, event)
    if (applied.accepted) {
      state = applied.state
      appliedCount += 1
    } else if (applied.rejection) {
      rejections.push(applied.rejection)
    }
  }
  return { state, rejections, appliedCount }
}

const recordEntries = <V>(record: Readonly<Record<string, V>>): Array<[string, V]> =>
  Object.keys(record)
    .sort()
    .map((key) => [key, record[key] as V])

export const snapshotMissionState = (state: MissionState): unknown => ({
  missionId: state.missionId,
  title: state.title,
  confirmed: state.confirmed,
  terminalOverride: state.terminalOverride,
  status: state.status,
  createdAt: state.createdAt,
  confirmedAt: state.confirmedAt,
  hostEpoch: state.hostEpoch,
  crew: state.crew === null ? null : { templateId: state.crew.templateId, slots: state.crew.slots },
  contextVersions: recordEntries(state.contextVersions).map(([key, version]) => [key, version]),
  slots: state.slotOrder.map((key) => {
    const slot = state.slots[key]
    if (!slot) return null
    return [
      key,
      {
        slotId: slot.slotId,
        spec: slot.spec,
        status: slot.status,
        statusSince: slot.statusSince,
        outcome: slot.outcome,
        autoRetryBlocked: slot.autoRetryBlocked,
        failureReason: slot.failureReason,
        uncertainReason: slot.uncertainReason,
        handleIds: [...slot.handleIds],
        livenessUnverified: slot.livenessUnverified,
        lastReport: slot.lastReport,
        artifacts: [...slot.artifacts],
      },
    ]
  }),
  requests: recordEntries(state.requests).map(([key, request]) => [key, request]),
  handles: recordEntries(state.handles).map(([key, handle]) => [key, handle]),
  lastAppliedSeq: state.lastAppliedSeq,
  appliedEventIds: [...state.appliedEventIds].sort(),
})
