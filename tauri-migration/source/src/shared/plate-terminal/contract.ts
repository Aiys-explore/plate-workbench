/**
 * Plate terminal contracts: slot identity, discovery, delivery and receipts.
 * Pure data + pure functions only; host/IPC code lives in src/main/plate-terminal.
 *
 * Identity chain per R4: mission/slot/runtime/session/process. Two roles may
 * share a display name; slotId keeps them apart. A delivery is only "sent"
 * once; unknown outcomes are never re-sent on restart.
 */

export type ProviderFlavor = 'claude-code' | 'codex' | 'zcode' | 'deepseek-harness' | 'other'

/** Discovery statuses shown to the user; login state is never guessed. */
export type DiscoveryStatus =
  | 'startable' // 可启动（登录状态未验证）
  | 'not-installed' // 未安装
  | 'desktop'
  | 'installed-not-wired' // 已安装但未接入（如桌面版 ZCode）
  | 'detect-failed' // 检测失败

export interface ProviderCandidate {
  readonly flavor: ProviderFlavor
  readonly displayName: string
  readonly status: DiscoveryStatus
  /** Verified native executable path; null unless a real .exe was located. */
  readonly executable: string | null
  /** Exact argv prefix used to launch (never a shell string). */
  readonly argv: readonly string[] | null
  /** Extra environment required by a bundled launcher, e.g. ELECTRON_RUN_AS_NODE. */
  readonly env: Readonly<Record<string, string>> | null
  readonly workingDirectory: string | null
  readonly version: string | null
  /** Why this status: short Chinese explanation for the discovery panel. */
  readonly reason: string
  /** A bundled launcher resolved to an argv vector (DeepSeek Harness desktop). */
  readonly bundledLauncher: boolean
}

export interface DiscoveryResult {
  readonly candidates: readonly ProviderCandidate[]
  readonly startedAt: number
  readonly finishedAt: number
  readonly truncated: boolean
  readonly installed?: readonly TerminalPlugin[]
}

export type TerminalPluginId = Exclude<ProviderFlavor, 'other'>
export const terminalPluginNames: Record<TerminalPluginId, string> = {
  codex: 'Codex', 'claude-code': 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', zcode: 'ZCode',
}
export interface TerminalPlugin { id: TerminalPluginId; version: string; source: string }
export interface CatalogListing { repository: string; plugins: TerminalPlugin[] }

export type RolePresetId = 'draft' | 'review' | 'organize'

export interface RolePreset {
  readonly id: RolePresetId
  readonly label: string
  /** Prompt fragment delivered with the context; not an instruction to Plate itself. */
  readonly promptFragment: string
}

export const rolePresets: readonly RolePreset[] = [
  { id: 'draft', label: '起草', promptFragment: '请基于给定资料起草内容，不改动资料之外的范围。' },
  { id: 'review', label: '复核', promptFragment: '请复核给定资料，逐条列出问题与依据，不直接改写。' },
  { id: 'organize', label: '整理', promptFragment: '请整理给定资料为结构化要点，不新增事实。' },
] as const

export const rolePresetById = (id: string): RolePreset | null =>
  rolePresets.find((p) => p.id === id) ?? null

/** Stable identity of one terminal slot inside one mission. */
export interface SlotIdentity {
  readonly missionId: string
  readonly slotId: string
  /** Role display label; NOT part of identity. Two roles may share a label. */
  readonly roleLabel: string
  /** runtime = provider flavor + executable identity stamp. */
  readonly runtimeId: string
  /** External CLI session id when known; null until the provider reports one. */
  readonly sessionId: string | null
  /** Local process id of the launched child. */
  readonly processId: number | null
}

export const slotTargetKey = (slot: SlotIdentity): string =>
  [slot.missionId, slot.slotId, slot.runtimeId].join('\u0000')

export const slotSessionKey = (slot: SlotIdentity): string =>
  [slot.missionId, slot.slotId, slot.runtimeId, slot.sessionId ?? '-', slot.processId ?? '-'].join('\u0000')

/** Fixed-version context snapshot delivered to a slot. Immutable once sent. */
export interface ContextPackage {
  readonly contextVersionId: string
  /** sha256:<hex> of the exact delivered text. */
  readonly contentHash: string
  readonly createdAt: number
  readonly blocks: readonly { noteId: string; blockId: string; text: string }[]
  readonly preset: RolePresetId | null
}

export type DeliveryStatus =
  | 'draft'
  | 'pending'
  | 'sent' // bytes handed to the terminal; receipt not yet proven
  | 'receipt-confirmed'
  | 'failed'
  | 'cancelled'

/** Outcome of one deliver() call against the ledger. */
export type DeliverAction = 'sent' | 'failed' | 'slot-offline' | 'skipped-duplicate'

export interface DeliveryAttempt {
  readonly requestId: string
  readonly target: SlotIdentity
  readonly packageHash: string
  readonly contextVersionId: string
  readonly preset: RolePresetId | null
  readonly status: DeliveryStatus
  readonly createdAt: number
  readonly updatedAt: number
  /** Receipt marker seen from the receiving side, when validated. */
  readonly receipt: { readonly seenAt: number; readonly matchedHash: boolean } | null
  readonly note: string
}

/** Pure dedup: an identical (target, hash, request) attempt already sent/confirmed blocks a resend. */
export const shouldSkipDuplicate = (
  attempts: readonly DeliveryAttempt[],
  target: SlotIdentity,
  packageHash: string,
): boolean =>
  attempts.some(
    (a) =>
      a.target.slotId === target.slotId &&
      a.target.missionId === target.missionId &&
      a.target.runtimeId === target.runtimeId &&
      a.packageHash === packageHash &&
      (a.status === 'sent' || a.status === 'receipt-confirmed' || a.status === 'pending'),
  )

/** Restart rule: unknown outcomes are never re-sent; they stay uncertain. */
export const recoverAttemptsOnRestart = (
  attempts: readonly DeliveryAttempt[],
  now: number,
): DeliveryAttempt[] =>
  attempts.map((a) =>
    a.status === 'pending'
      ? { ...a, status: 'sent', updatedAt: now, note: `${a.note}; 重启后未知状态保留为已发送，不自动补发`.trim() }
      : a,
  )

/**
 * A synthetic receiver acknowledges with `PLATE-RECEIPT <contextVersionId> <contentHash>`.
 * The receipt is only confirmed when both fields match the delivered package.
 * Terminal echo or process start is never treated as a receipt.
 */
export const RECEIPT_PREFIX = 'PLATE-RECEIPT'

export const parseReceipt = (line: string): { contextVersionId: string; contentHash: string } | null => {
  const parts = line.trim().split(/\s+/)
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) return null
  if (!/^sha256:[0-9a-f]{64}$/.test(parts[2])) return null
  return { contextVersionId: parts[1], contentHash: parts[2] }
}

export const receiptMatches = (
  receipt: { readonly contextVersionId: string; readonly contentHash: string },
  pkg: Pick<ContextPackage, 'contextVersionId' | 'contentHash'>,
): boolean => receipt.contextVersionId === pkg.contextVersionId && receipt.contentHash === pkg.contentHash

/** Delivery envelope: the exact text typed into the target terminal. */
export const buildEnvelope = (pkg: ContextPackage, roleLabel: string): string => {
  const lines = [
    `[Plate 交接 · ${roleLabel}${pkg.preset ? ` · ${pkg.preset}` : ''}]`,
    `[资料版本 ${pkg.contextVersionId} · 内容哈希 ${pkg.contentHash}]`,
    ...pkg.blocks.map((b) => `--- ${b.noteId} / ${b.blockId} ---\n${b.text}`),
    `[请回复：${RECEIPT_PREFIX} ${pkg.contextVersionId} ${pkg.contentHash}]`,
  ]
  return lines.join('\n')
}

/** IPC channel names for the plate terminal host. */
export const plateTerminalIPC = {
  discover: 'plate-terminal:discover',
  catalog: 'plate-terminal:catalog',
  install: 'plate-terminal:install',
  remove: 'plate-terminal:remove',
  desktop: 'plate-terminal:desktop',
  copyDesktopTask: 'plate-terminal:copy-desktop-task',
  open: 'plate-terminal:open',
  write: 'plate-terminal:write',
  resize: 'plate-terminal:resize',
  sigint: 'plate-terminal:sigint',
  terminate: 'plate-terminal:terminate',
  close: 'plate-terminal:close',
  deliver: 'plate-terminal:deliver',
  attempts: 'plate-terminal:attempts',
  data: 'plate-terminal:data',
  exit: 'plate-terminal:exit',
} as const

export interface PlateTerminalSlotOpenInput {
  /** The host selects the launch command from its own discovery. */
  readonly provider: ProviderFlavor
  readonly identity: SlotIdentity
  readonly cols?: number
  readonly rows?: number
}

export interface PlateTerminalSlotOpenResult {
  readonly slotId: number
  readonly processId: number
}

export interface PlateTerminalDataEvent {
  readonly slotId: number
  readonly data: Uint8Array
}

export interface PlateTerminalExitEvent {
  readonly slotId: number
  readonly exitCode: number
  readonly dropped: number
}

/** Manual material delivery: the host fixes the version and hash before sending. */
export interface PlateTerminalDeliverInput {
  readonly target: SlotIdentity
  readonly terminalSlotId: number
  readonly text: string
  readonly preset: RolePresetId | null
  readonly note?: { id: string; revision: string; requestId: string }
}

export interface PlateTerminalDeliverResult {
  readonly action: DeliverAction
  readonly attempt: DeliveryAttempt
}

export interface PlateTerminalApi {
  discover(): Promise<DiscoveryResult>
  catalog(repository: string): Promise<CatalogListing>
  install(id: TerminalPluginId, repository?: string): Promise<TerminalPlugin[]>
  remove(id: TerminalPluginId): Promise<TerminalPlugin[]>
  desktop(): Promise<void>
  copyDesktopTask(text: string): Promise<void>
  open(input: PlateTerminalSlotOpenInput): Promise<PlateTerminalSlotOpenResult>
  write(slotId: number, data: string): Promise<void>
  resize(slotId: number, cols: number, rows: number): Promise<void>
  sigint(slotId: number): Promise<void>
  terminate(slotId: number): Promise<void>
  close(slotId: number): Promise<void>
  deliver(input: PlateTerminalDeliverInput): Promise<PlateTerminalDeliverResult>
  attempts(): Promise<DeliveryAttempt[]>
  onData(listener: (event: PlateTerminalDataEvent) => void): () => void
  onExit(listener: (event: PlateTerminalExitEvent) => void): () => void
}
