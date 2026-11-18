import type { Sha256Hash } from './mission/ids'

// R4-CV 协作层：角色标记、发给审查、带材料转交。
// 身份映射是页签、接收人列表与活动入口共用的唯一来源（R4-CV-01）。
export type CollaborationConnectivity = 'unconnected'

export interface SlotIdentity {
  missionId: string
  slotId: string
  role: string
  providerFlavor: string
  providerName: string
  displayName: string
  displayVersion: number
  // 同任务内 (displayName, providerName) 重复时的可见短编号；首个为 null。
  shortIndex: number | null
  connectivity: CollaborationConnectivity
}

export const slotTitle = (slot: Pick<SlotIdentity, 'displayName' | 'providerName' | 'shortIndex'>) =>
  `${slot.displayName} · ${slot.providerName}` + (slot.shortIndex === null ? '' : ` ·${slot.shortIndex}`)

export const slotAriaLabel = (slot: SlotIdentity) =>
  slotTitle(slot) + (slot.shortIndex === null ? '' : `（编号 ${slot.shortIndex}）`) + '，未接入真实终端'

export type DeliveryStatus =
  | 'draft' | 'sent' | 'received' | 'failed' | 'uncertain' | 'copied' | 'cancelled'

export const deliveryStatusLabels: Record<DeliveryStatus, string> = {
  draft: '待确认', sent: '发出待回执', received: '已收到', failed: '失败',
  uncertain: '发送不明', copied: '已复制待粘贴', cancelled: '已取消'
}

export type MaterialKind = 'note-selection' | 'board-cards'

export interface MaterialView {
  kind: MaterialKind
  noteId?: string
  noteTitle?: string
  boardId?: string
  blockId?: string | null
  lineFrom?: number
  lineTo?: number
  cardIds?: string[]
  // 发送时快照：不可变；来源编辑不影响。note 类来源始终保留全文快照。
  snapshotText: string
  snapshotHash: Sha256Hash
  // block-id = 命中委派锚点等稳定 ID；selection-snapshot = 明示的选区快照。
  sourceMode: 'block-id' | 'selection-snapshot' | 'board-card'
}

export type RequestKind = 'review' | 'handoff'

export interface CollaborationRequestView {
  requestId: string
  missionId: string
  kind: RequestKind
  status: DeliveryStatus
  fromSlotId: string | null
  toSlotId: string
  message: string | null
  doneText: string | null
  todoText: string | null
  blockerNote: string | null
  materials: MaterialView[]
  artifact: { name: string; path: string; contentHash: Sha256Hash; availableNow: boolean } | null
  createdAt: number
  sentAt: number | null
  resolvedAt: number | null
  receiptEvidence: string | null
  sourceAvailableNow: boolean
}

export interface ActivityEntry {
  id: string
  missionId: string
  requestId: string
  kind: RequestKind
  event: 'sent' | 'copied' | 'received' | 'failed' | 'uncertain' | 'cancelled'
  summary: string
  // 发送时的身份快照，角色改名不重写历史。
  senderSlotId: string | null
  senderRoleDisplay: string | null
  senderProvider: string | null
  recipientSlotId: string | null
  recipientRoleDisplay: string | null
  recipientProvider: string | null
  at: number
}

export interface CollaborationTaskView {
  missionId: string
  title: string
  createdAt: number
  slots: SlotIdentity[]
}

export interface CollaborationOverview {
  schemaVersion: number
  tasks: CollaborationTaskView[]
  requests: CollaborationRequestView[]
  activities: ActivityEntry[]
}

export interface NoteMaterialInput {
  kind: 'note-selection'
  noteId: string
  baseRevision: string
  lineFrom: number
  lineTo: number
}

export interface BoardMaterialInput {
  kind: 'board-cards'
  boardId: string
  cards: { cardId: string; version: string }[]
}

export type MaterialInput = NoteMaterialInput | BoardMaterialInput

export interface ReviewDraftInput {
  missionId: string
  toSlotId: string
  message: string
  materials: MaterialInput[]
}

export interface HandoffDraftInput {
  missionId: string
  fromSlotId: string
  toSlotId: string
  doneText: string
  todoText: string
  blockerNote: string
  materials: MaterialInput[]
  artifactPath: string | null
}

export type SendChannel = 'pipe' | 'copy'

export type ConfirmOutcome = { requestId: string; status: DeliveryStatus } | { error: string }
export type PrepareOutcome = { requestId: string } | { error: string }

export interface CollaborationApi {
  overview(): Promise<CollaborationOverview>
  createTask(title: string): Promise<{ missionId: string } | { error: string }>
  addSlot(missionId: string, input: { role: string; providerFlavor: string; providerName: string }):
    Promise<{ slotId: string } | { error: string }>
  renameRole(missionId: string, slotId: string, displayName: string, expectedDisplayVersion: number):
    Promise<{ displayVersion: number } | { error: string }>
  prepareReview(input: ReviewDraftInput): Promise<PrepareOutcome>
  prepareHandoff(input: HandoffDraftInput): Promise<PrepareOutcome>
  confirmRequest(requestId: string, channel: SendChannel): Promise<ConfirmOutcome>
  cancelRequest(requestId: string): Promise<ConfirmOutcome>
  copyRequestText(requestId: string): Promise<{ text: string } | { error: string }>
}

export const collaborationIPC = {
  overview: 'collab:overview',
  createTask: 'collab:create-task',
  addSlot: 'collab:add-slot',
  renameRole: 'collab:rename-role',
  prepareReview: 'collab:prepare-review',
  prepareHandoff: 'collab:prepare-handoff',
  confirmRequest: 'collab:confirm-request',
  cancelRequest: 'collab:cancel-request',
  copyRequestText: 'collab:copy-request-text'
} as const
