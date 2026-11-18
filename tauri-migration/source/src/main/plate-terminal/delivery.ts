/**
 * Delivery ledger for plate-terminal slots. One JSON file per user-data
 * directory records every attempt against its fixed context version; a
 * receipt only upgrades a delivery when both the version id and the content
 * hash match. Unknown outcomes survive restart as "sent" and are never
 * re-sent automatically.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildEnvelope,
  parseReceipt,
  recoverAttemptsOnRestart,
  shouldSkipDuplicate,
  slotTargetKey,
} from '../../shared/plate-terminal/contract'
import type {
  ContextPackage,
  DeliverAction,
  DeliveryAttempt,
  SlotIdentity,
} from '../../shared/plate-terminal/contract'

const STORE_VERSION = 1

interface StoreFile {
  readonly version: number
  readonly savedAt: string
  readonly attempts: DeliveryAttempt[]
}

export interface DeliverInput {
  readonly target: SlotIdentity
  /** PTY slot id while the target is online; null means the slot is offline. */
  readonly terminalSlotId: number | null
  readonly pkg: ContextPackage
  /** Writes the fixed-version envelope into the terminal; returns the outcome of the write itself. */
  readonly send: (envelope: string) => { ok: true } | { ok: false; reason: string }
}

export interface DeliverOutcome {
  readonly action: DeliverAction
  readonly attempt: DeliveryAttempt
}

const sameSlot = (a: SlotIdentity, b: SlotIdentity): boolean =>
  slotTargetKey(a) === slotTargetKey(b)

export class DeliveryLog {
  private readonly storePath: string
  private attempts: DeliveryAttempt[]

  constructor(userDataDir: string) {
    this.storePath = join(userDataDir, 'plate-terminal-deliveries.json')
    this.attempts = []
    this.load()
  }

  list(): readonly DeliveryAttempt[] {
    return this.attempts
  }

  private load(): void {
    if (!existsSync(this.storePath)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.storePath, 'utf8'))
    } catch (error) {
      throw new Error(`投递账本不可读：${this.storePath}（${String(error)}）`)
    }
    const file = parsed as Partial<StoreFile>
    if (file.version !== STORE_VERSION || !Array.isArray(file.attempts)) {
      throw new Error(`投递账本版本不匹配：${this.storePath}`)
    }
    const recoveredAt = Date.now()
    this.attempts = recoverAttemptsOnRestart(file.attempts as DeliveryAttempt[], recoveredAt)
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true })
    const file: StoreFile = {
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      attempts: this.attempts,
    }
    const tmpPath = `${this.storePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmpPath, this.storePath)
  }

  private update(
    requestId: string,
    patch: (attempt: DeliveryAttempt, now: number) => DeliveryAttempt,
  ): DeliveryAttempt | null {
    const index = this.attempts.findIndex((a) => a.requestId === requestId)
    if (index < 0) return null
    const now = Date.now()
    const updated = patch(this.attempts[index], now)
    this.attempts[index] = updated
    this.save()
    return updated
  }

  deliver(input: DeliverInput): DeliverOutcome {
    if (shouldSkipDuplicate(this.attempts, input.target, input.pkg.contentHash)) {
      const existing = [...this.attempts]
        .reverse()
        .find((a) => sameSlot(a.target, input.target) && a.packageHash === input.pkg.contentHash)
      if (existing) return { action: 'skipped-duplicate', attempt: existing }
    }

    const now = Date.now()
    const attempt: DeliveryAttempt = {
      requestId: randomUUID(),
      target: input.target,
      packageHash: input.pkg.contentHash,
      contextVersionId: input.pkg.contextVersionId,
      preset: input.pkg.preset,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      receipt: null,
      note: '待写入终端',
    }
    this.attempts.push(attempt)
    this.save()

    if (input.terminalSlotId === null) {
      const failed = this.update(attempt.requestId, (a, t) => ({
        ...a,
        status: 'failed',
        updatedAt: t,
        note: `${a.note}; 槽位不在线，未写入终端`,
      }))
      return { action: 'slot-offline', attempt: failed ?? attempt }
    }

    let result: { ok: true } | { ok: false; reason: string }
    try {
      result = input.send(buildEnvelope(input.pkg, input.target.roleLabel))
    } catch (error) {
      result = { ok: false, reason: `写入异常：${String(error)}` }
    }

    if (!result.ok) {
      const reason = result.reason
      const failed = this.update(attempt.requestId, (a, t) => ({
        ...a,
        status: 'failed',
        updatedAt: t,
        note: `${a.note}; 写入失败：${reason}`,
      }))
      return { action: 'failed', attempt: failed ?? attempt }
    }

    const sent = this.update(attempt.requestId, (a, t) => ({
      ...a,
      status: 'sent',
      updatedAt: t,
      note: `${a.note}; 已写入终端槽位 ${input.terminalSlotId}，等待回执`,
    }))
    return { action: 'sent', attempt: sent ?? attempt }
  }

  /** A PLATE-RECEIPT line upgrades the matching sent delivery only on exact match. */
  observeLine(target: SlotIdentity, line: string): boolean {
    const parsed = parseReceipt(line)
    if (!parsed) return false
    const candidate = [...this.attempts]
      .reverse()
      .find(
        (a) =>
          sameSlot(a.target, target) &&
          a.status === 'sent' &&
          a.contextVersionId === parsed.contextVersionId &&
          a.packageHash === parsed.contentHash,
      )
    if (!candidate) return false
    return this.update(candidate.requestId, (a, t) => ({
      ...a,
      status: 'receipt-confirmed',
      updatedAt: t,
      receipt: { seenAt: t, matchedHash: true },
      note: `${a.note}; 回执核对通过`,
    })) !== null
  }

  /** A receipt whose hash disagrees stays "sent"; the mismatch is recorded. */
  observeMismatch(target: SlotIdentity, line: string): boolean {
    const parsed = parseReceipt(line)
    if (!parsed) return false
    const candidate = [...this.attempts]
      .reverse()
      .find(
        (a) =>
          sameSlot(a.target, target) &&
          a.status === 'sent' &&
          a.contextVersionId === parsed.contextVersionId &&
          a.packageHash !== parsed.contentHash,
      )
    if (!candidate) return false
    return this.update(candidate.requestId, (a, t) => ({
      ...a,
      updatedAt: t,
      receipt: { seenAt: t, matchedHash: false },
      note: `${a.note}; 回执哈希与已发送版本不一致，保持已发送`,
    })) !== null
  }
}
