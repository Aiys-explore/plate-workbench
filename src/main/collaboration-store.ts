import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import { localSqlitePath } from './local-sqlite-path'
import { taskIdPattern } from '../shared/task-anchor'
import type { BoardCardsResolution } from '../shared/plate-board'
import type {
  ActivityEntry, CollaborationOverview, CollaborationRequestView, ConfirmOutcome,
  DeliveryStatus, HandoffDraftInput, MaterialInput, MaterialView, PrepareOutcome,
  ReviewDraftInput, SendChannel, SlotIdentity,
} from '../shared/collaboration'
import { sha256Hash } from '../shared/mission/ids'

export const COLLAB_SCHEMA_VERSION = 1

export const collabSchema = `
CREATE TABLE IF NOT EXISTS collab_migration (version INTEGER PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS collab_task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS collab_slot (
  mission_id TEXT NOT NULL REFERENCES collab_task(id),
  slot_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL, provider_flavor TEXT NOT NULL, provider_name TEXT NOT NULL,
  display_name TEXT NOT NULL, display_version INTEGER NOT NULL,
  seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, slot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collab_request (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES collab_task(id),
  kind TEXT NOT NULL, status TEXT NOT NULL,
  from_slot TEXT, to_slot TEXT NOT NULL,
  message TEXT, done_text TEXT, todo_text TEXT, blocker_note TEXT,
  materials_json TEXT NOT NULL, artifact_json TEXT,
  receipt_secret TEXT, receipt_token_hash TEXT, dispatch_json TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER, resolved_at INTEGER,
  receipt_evidence TEXT,
  FOREIGN KEY (from_slot) REFERENCES collab_slot(slot_id),
  FOREIGN KEY (to_slot) REFERENCES collab_slot(slot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collab_activity (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES collab_task(id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL, event TEXT NOT NULL, summary TEXT NOT NULL,
  sender_slot TEXT, sender_role_display TEXT, sender_provider TEXT,
  recipient_slot TEXT, recipient_role_display TEXT, recipient_provider TEXT,
  at INTEGER NOT NULL
) STRICT;
`

type TaskRow = { id: string; title: string; created_at: number }
type SlotRow = { mission_id: string; slot_id: string; role: string; provider_flavor: string;
  provider_name: string; display_name: string; display_version: number; seq: number; created_at: number }
type RequestRow = { id: string; mission_id: string; kind: 'review' | 'handoff'; status: DeliveryStatus;
  from_slot: string | null; to_slot: string; message: string | null; done_text: string | null;
  todo_text: string | null; blocker_note: string | null; materials_json: string; artifact_json: string | null;
  receipt_secret: string | null; receipt_token_hash: string | null; dispatch_json: string | null;
  created_at: number; sent_at: number | null; resolved_at: number | null; receipt_evidence: string | null }
type ActivityRow = { id: string; mission_id: string; request_id: string; kind: 'review' | 'handoff';
  event: ActivityEntry['event']; summary: string; sender_slot: string | null; sender_role_display: string | null;
  sender_provider: string | null; recipient_slot: string | null; recipient_role_display: string | null;
  recipient_provider: string | null; at: number }

export interface ResolvedNote { id: string; revision: string; title: string; content: string }
export type { ResolvedCard } from '../shared/plate-board'

// 主进程内注入；渲染器无法触达。pipe 派发前才生成回执令牌并交给适配器。
export interface PipeDispatchRequest {
  requestId: string; missionId: string; toSlotId: string; kind: 'review' | 'handoff'
  token: string; payloadText: string
}
export interface PipeDispatchReceipt { evidenceRef: string }
export type PipeAdapter = (request: PipeDispatchRequest) => PipeDispatchReceipt

export interface CollaborationDeps {
  newId: () => string
  now: () => number
  readNote: (noteId: string) => ResolvedNote | null
  resolveBoardCards: ((input: { boardId: string; cards: { cardId: string; version: string }[] }) => BoardCardsResolution) | null
  copyText: (text: string) => void
}

const digest = (value: string) => sha256Hash('sha256:' + createHash('sha256').update(value, 'utf8').digest('hex'))
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const withinDir = (dir: string, path: string) => {
  if (!isAbsolute(path)) return false
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function migrateCollab(db: Database.Database, ddl = collabSchema) {
  if (db.inTransaction) throw new Error('Collaboration migration requires a top-level transaction')
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS collab_migration (version INTEGER PRIMARY KEY) STRICT')
    const { version } = db.prepare('SELECT coalesce(max(version), 0) AS version FROM collab_migration').get() as { version: number }
    if (version > COLLAB_SCHEMA_VERSION) throw new Error('Unsupported collaboration schema')
    if (version === 0) {
      db.exec(ddl)
      db.prepare('INSERT INTO collab_migration VALUES (?)').run(COLLAB_SCHEMA_VERSION)
    }
  }).immediate()
}

export function openCollabDb(file: string) {
  const db = new Database(localSqlitePath(file), { timeout: 5000 })
  try {
    db.pragma('foreign_keys = ON')
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new Error('Collaboration needs SQLite WAL')
    db.pragma('synchronous = FULL')
    migrateCollab(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

const requestText = (row: RequestRow, materials: MaterialView[], artifactName: string | null) => {
  const head = row.kind === 'review'
    ? `【发给审查】任务 ${row.mission_id} · 消息：${row.message ?? ''}`
    : `【转交】任务 ${row.mission_id}\n已完成：${row.done_text ?? ''}\n待继续：${row.todo_text ?? ''}` +
      (row.blocker_note ? `\n阻塞说明：${row.blocker_note}` : '')
  const body = materials.map((m) => {
    const label = m.kind === 'note-selection'
      ? `文档 ${m.noteTitle ?? m.noteId} 第 ${m.lineFrom}–${m.lineTo} 行` + (m.blockId ? `（块 ${m.blockId}）` : '（选区快照）')
      : `画板卡片 ${m.cardIds?.length ?? 0} 张（板 ${m.boardId ?? '?'}）`
    return `── ${label}（${m.sourceMode} · ${m.snapshotHash}）\n${m.snapshotText}`
  }).join('\n\n')
  const artifact = artifactName ? `\n\n── 产物：${artifactName}` : ''
  return `${head}\n\n${body}${artifact}`
}

export function makeCollaborationCore(db: Database.Database, deps: CollaborationDeps, artifactRoot: string) {
  const get = <T>(sql: string, ...params: unknown[]) => db.prepare<unknown[], T>(sql).get(...params)
  const all = <T>(sql: string, ...params: unknown[]) => db.prepare<unknown[], T>(sql).all(...params)
  const write = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params)
  const tx = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const immediate = db.transaction(fn).immediate
    return (...args: A): R => {
      if (db.inTransaction) throw new Error('Collaboration writes require a top-level transaction')
      return immediate(...args)
    }
  }
  const taskFor = (id: string) => get<TaskRow>('SELECT * FROM collab_task WHERE id=?', id)
  const slotFor = (missionId: string, slotId: string) =>
    get<SlotRow>('SELECT * FROM collab_slot WHERE mission_id=? AND slot_id=?', missionId, slotId)
  const requestFor = (id: string) => get<RequestRow>('SELECT * FROM collab_request WHERE id=?', id)
  const materialsOf = (row: RequestRow): MaterialView[] => JSON.parse(row.materials_json) as MaterialView[]

  // R4-CV-01：页签、接收人列表、活动入口共用这一身份映射；短编号只用于展示区分。
  const slotIdentity = (row: SlotRow): SlotIdentity => ({
    missionId: row.mission_id, slotId: row.slot_id, role: row.role,
    providerFlavor: row.provider_flavor, providerName: row.provider_name,
    displayName: row.display_name, displayVersion: row.display_version,
    shortIndex: null, connectivity: 'unconnected'
  })

  let pipeAdapter: PipeAdapter | null = null

  const identitySnapshot = (missionId: string, slotId: string) => {
    const row = slotFor(missionId, slotId)
    return row ? { slotId, roleDisplay: row.display_name, providerName: row.provider_name } : null
  }

  const activity = (entry: Omit<ActivityEntry, 'id'>) => {
    if (!db.inTransaction) throw new Error('Collaboration activity writes require an open transaction')
    write(`INSERT INTO collab_activity(id,mission_id,request_id,kind,event,summary,
      sender_slot,sender_role_display,sender_provider,recipient_slot,recipient_role_display,recipient_provider,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    deps.newId(), entry.missionId, entry.requestId, entry.kind, entry.event, entry.summary,
    entry.senderSlotId, entry.senderRoleDisplay, entry.senderProvider,
    entry.recipientSlotId, entry.recipientRoleDisplay, entry.recipientProvider, entry.at)
  }

  const resolveMaterial = (input: MaterialInput): MaterialView | { error: string } => {
    if (input.kind === 'note-selection') {
      if (!taskIdPattern.test(input.noteId) || !isText(input.baseRevision) ||
          !Number.isSafeInteger(input.lineFrom) || !Number.isSafeInteger(input.lineTo) ||
          input.lineFrom < 1 || input.lineTo < input.lineFrom) return { error: 'invalid-material' }
      const note = deps.readNote(input.noteId)
      if (!note) return { error: 'note-missing' }
      if (note.revision !== input.baseRevision) return { error: 'source-changed' }
      const lines = note.content.split(/\r\n|\r|\n/)
      if (input.lineTo > lines.length) return { error: 'selection-out-of-range' }
      const text = lines.slice(input.lineFrom - 1, input.lineTo).join('\n')
      if (!text.trim()) return { error: 'empty-selection' }
      // 稳定块 ID 只承认已保存的委派锚点；其余来源明确使用选区快照。
      const anchorLine = lines.slice(input.lineFrom - 1, input.lineTo)
        .map(line => /<!--\s*workbench-task:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.exec(line)?.[1] ?? null)
        .find(id => id !== null) ?? null
      return {
        kind: 'note-selection', noteId: note.id, noteTitle: note.title,
        blockId: anchorLine, lineFrom: input.lineFrom, lineTo: input.lineTo,
        snapshotText: text, snapshotHash: digest(text),
        sourceMode: anchorLine ? 'block-id' : 'selection-snapshot'
      }
    }
    if (input.kind === 'board-cards') {
      if (!isText(input.boardId) || !Array.isArray(input.cards) || input.cards.length === 0 ||
          !input.cards.every(card => card && isText(card.cardId) && isText(card.version))) {
        return { error: 'invalid-material' }
      }
      if (!deps.resolveBoardCards) return { error: 'board-source-unavailable' }
      const resolved = deps.resolveBoardCards({ boardId: input.boardId, cards: input.cards })
      if ('error' in resolved) {
        return { error: ['invalid-board', 'board-missing', 'board-corrupt', 'note-missing',
          'board-card-missing', 'board-card-stale'].includes(resolved.error) ? resolved.error : 'invalid-material' }
      }
      const cards = resolved.cards
      const text = cards.map(card => `【${card.title}】(v${card.version})\n${card.text}`).join('\n\n')
      return {
        kind: 'board-cards', boardId: input.boardId, cardIds: cards.map(card => card.cardId),
        snapshotText: text, snapshotHash: digest(text), sourceMode: 'board-card'
      }
    }
    return { error: 'invalid-material' }
  }

  return {
    registerPipeAdapter(adapter: PipeAdapter | null) { pipeAdapter = adapter },

    overview(): CollaborationOverview {
      const tasks = all<TaskRow>('SELECT * FROM collab_task ORDER BY created_at, id').map(task => {
        const rows = all<SlotRow>('SELECT * FROM collab_slot WHERE mission_id=? ORDER BY seq, created_at', task.id)
        const seen = new Map<string, number>()
        const slots = rows.map(row => {
          const identity = slotIdentity(row)
          const key = `${identity.displayName}\u0000${identity.providerName}`
          const count = (seen.get(key) ?? 0) + 1
          seen.set(key, count)
          return { ...identity, shortIndex: count === 1 ? null : count }
        })
        return { missionId: task.id, title: task.title, createdAt: task.created_at, slots }
      })
      const requests = all<RequestRow>('SELECT * FROM collab_request ORDER BY created_at, id').map(row => {
        const materials = materialsOf(row)
        const artifact = row.artifact_json ? JSON.parse(row.artifact_json) as { name: string; path: string; contentHash: string } : null
        return {
          requestId: row.id, missionId: row.mission_id, kind: row.kind, status: row.status,
          fromSlotId: row.from_slot, toSlotId: row.to_slot, message: row.message,
          doneText: row.done_text, todoText: row.todo_text, blockerNote: row.blocker_note,
          materials, artifact: artifact && {
            name: artifact.name, path: artifact.path, contentHash: sha256Hash(artifact.contentHash),
            availableNow: existsSync(artifact.path)
          },
          createdAt: row.created_at, sentAt: row.sent_at, resolvedAt: row.resolved_at,
          receiptEvidence: row.receipt_evidence,
          sourceAvailableNow: materials.every(m => m.kind !== 'note-selection' || !!deps.readNote(m.noteId ?? ''))
        }
      })
      const activities = all<ActivityRow>('SELECT * FROM collab_activity ORDER BY at, id').map(row => ({
        id: row.id, missionId: row.mission_id, requestId: row.request_id, kind: row.kind, event: row.event,
        summary: row.summary, senderSlotId: row.sender_slot, senderRoleDisplay: row.sender_role_display,
        senderProvider: row.sender_provider, recipientSlotId: row.recipient_slot,
        recipientRoleDisplay: row.recipient_role_display, recipientProvider: row.recipient_provider, at: row.at
      }))
      return { schemaVersion: COLLAB_SCHEMA_VERSION, tasks, requests, activities }
    },

    createTask: tx((title: string): { missionId: string } | { error: string } => {
      if (!isText(title) || title.length > 240) return { error: 'invalid-title' }
      const missionId = deps.newId()
      write('INSERT INTO collab_task(id,title,created_at) VALUES (?,?,?)', missionId, title.trim(), deps.now())
      return { missionId }
    }),

    addSlot: tx((missionId: string, input: { role: string; providerFlavor: string; providerName: string }):
      { slotId: string } | { error: string } => {
      if (!taskFor(missionId)) return { error: 'unknown-mission' }
      if (![input.role, input.providerFlavor, input.providerName].every(isText)) return { error: 'invalid-slot' }
      const slotId = deps.newId()
      const seq = (get<{ n: number }>('SELECT count(*) AS n FROM collab_slot WHERE mission_id=?', missionId))!.n
      write(`INSERT INTO collab_slot(mission_id,slot_id,role,provider_flavor,provider_name,display_name,display_version,seq,created_at)
        VALUES (?,?,?,?,?,?,1,?,?)`, missionId, slotId, input.role.trim(), input.providerFlavor.trim(),
      input.providerName.trim(), input.role.trim(), seq, deps.now())
      return { slotId }
    }),

    // 角色编辑影响之后的显示；活动历史快照不重写（R4-CV-01）。
    renameRole: tx((missionId: string, slotId: string, displayName: string, expectedDisplayVersion: number):
      { displayVersion: number } | { error: string } => {
      const slot = slotFor(missionId, slotId)
      if (!slot) return { error: 'unknown-slot' }
      if (!isText(displayName) || displayName.length > 80) return { error: 'invalid-display-name' }
      if (slot.display_version !== expectedDisplayVersion) return { error: 'display-version-conflict' }
      write('UPDATE collab_slot SET display_name=?, display_version=display_version+1 WHERE mission_id=? AND slot_id=?',
        displayName.trim(), missionId, slotId)
      return { displayVersion: slot.display_version + 1 }
    }),

    prepareReview: tx((input: ReviewDraftInput): PrepareOutcome => {
      if (!taskFor(input.missionId)) return { error: 'unknown-mission' }
      if (!slotFor(input.missionId, input.toSlotId)) return { error: 'unknown-slot' }
      if (!Array.isArray(input.materials) || input.materials.length === 0) return { error: 'no-materials' }
      const materials: MaterialView[] = []
      for (const item of input.materials) {
        const resolved = resolveMaterial(item)
        if ('error' in resolved) return resolved
        materials.push(resolved)
      }
      const requestId = deps.newId()
      write(`INSERT INTO collab_request(id,mission_id,kind,status,from_slot,to_slot,message,materials_json,created_at)
        VALUES (?,?,?,?,NULL,?,?,?,?)`,
      requestId, input.missionId, 'review', 'draft', input.toSlotId,
      typeof input.message === 'string' ? input.message : '', JSON.stringify(materials), deps.now())
      return { requestId }
    }),

    prepareHandoff: tx((input: HandoffDraftInput): PrepareOutcome => {
      if (!taskFor(input.missionId)) return { error: 'unknown-mission' }
      if (!slotFor(input.missionId, input.fromSlotId)) return { error: 'unknown-slot' }
      if (!slotFor(input.missionId, input.toSlotId)) return { error: 'unknown-slot' }
      if (input.fromSlotId === input.toSlotId) return { error: 'same-slot' }
      if (!Array.isArray(input.materials) || input.materials.length === 0) return { error: 'no-materials' }
      const materials: MaterialView[] = []
      for (const item of input.materials) {
        const resolved = resolveMaterial(item)
        if ('error' in resolved) return resolved
        materials.push(resolved)
      }
      let artifactJson: string | null = null
      if (input.artifactPath !== null) {
        const dir = join(artifactRoot, input.missionId)
        if (!isText(input.artifactPath) || !withinDir(dir, input.artifactPath)) return { error: 'artifact-outside-scope' }
        if (!existsSync(input.artifactPath)) return { error: 'artifact-missing' }
        const content = readFileSync(input.artifactPath)
        const contentHash = sha256Hash('sha256:' + createHash('sha256').update(content).digest('hex'))
        artifactJson = JSON.stringify({ name: input.artifactPath.split(/[\\/]/).pop() ?? input.artifactPath,
          path: input.artifactPath, contentHash })
      }
      const requestId = deps.newId()
      write(`INSERT INTO collab_request(id,mission_id,kind,status,from_slot,to_slot,done_text,todo_text,blocker_note,
        materials_json,artifact_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      requestId, input.missionId, 'handoff', 'draft', input.fromSlotId, input.toSlotId,
      typeof input.doneText === 'string' ? input.doneText : '', typeof input.todoText === 'string' ? input.todoText : '',
      typeof input.blockerNote === 'string' && input.blockerNote.length > 0 ? input.blockerNote : null,
      JSON.stringify(materials), artifactJson, deps.now())
      return { requestId }
    }),

    // 渲染器不可达；回执令牌只有派发管道持有（R4-CV-02）。
    recordReceipt: tx((requestId: string, token: string, evidenceRef: string): ConfirmOutcome => {
      const row = requestFor(requestId)
      if (!row) return { error: 'unknown-request' }
      if (!isText(token) || !isText(evidenceRef)) return { error: 'invalid-receipt' }
      if (row.status !== 'sent') return { error: 'not-awaiting-receipt' }
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
      if (row.receipt_token_hash !== tokenHash) return { error: 'token-mismatch' }
      const recipient = identitySnapshot(row.mission_id, row.to_slot)
      const sender = row.from_slot ? identitySnapshot(row.mission_id, row.from_slot) : null
      write('UPDATE collab_request SET status=?, resolved_at=?, receipt_evidence=? WHERE id=?',
        'received', deps.now(), evidenceRef, requestId)
      activity({
        missionId: row.mission_id, requestId, kind: row.kind, event: 'received',
        summary: row.kind === 'handoff' ? '接手回执已确认' : '接收回执已确认',
        senderSlotId: sender?.slotId ?? null, senderRoleDisplay: sender?.roleDisplay ?? null,
        senderProvider: sender?.providerName ?? null,
        recipientSlotId: recipient?.slotId ?? null, recipientRoleDisplay: recipient?.roleDisplay ?? null,
        recipientProvider: recipient?.providerName ?? null, at: deps.now()
      })
      return { requestId, status: 'received' }
    }),

    // 仅主进程显式决策；重启后不会自动补记或补发（R4-CV-02/03）。
    markUncertain: tx((requestId: string, reason: string): ConfirmOutcome => {
      const row = requestFor(requestId)
      if (!row) return { error: 'unknown-request' }
      if (row.status !== 'sent') return { error: 'not-awaiting-receipt' }
      if (!isText(reason)) return { error: 'invalid-reason' }
      write('UPDATE collab_request SET status=?, resolved_at=? WHERE id=?', 'uncertain', deps.now(), requestId)
      activity({
        missionId: row.mission_id, requestId, kind: row.kind, event: 'uncertain',
        summary: '发送不明：' + reason, senderSlotId: null, senderRoleDisplay: null, senderProvider: null,
        recipientSlotId: row.to_slot, recipientRoleDisplay: identitySnapshot(row.mission_id, row.to_slot)?.roleDisplay ?? null,
        recipientProvider: identitySnapshot(row.mission_id, row.to_slot)?.providerName ?? null, at: deps.now()
      })
      return { requestId, status: 'uncertain' }
    }),

    confirmRequest: tx((requestId: string, channel: SendChannel): ConfirmOutcome => {
      const row = requestFor(requestId)
      if (!row) return { error: 'unknown-request' }
      if (row.status !== 'draft') return { error: 'not-draft' }
      if (channel !== 'pipe' && channel !== 'copy') return { error: 'invalid-channel' }
      const materials = materialsOf(row)
      const artifact = row.artifact_json ? JSON.parse(row.artifact_json) as { name: string } : null
      const payload = requestText(row, materials, artifact?.name ?? null)
      const recipient = identitySnapshot(row.mission_id, row.to_slot)
      const sender = row.from_slot ? identitySnapshot(row.mission_id, row.from_slot) : null
      if (channel === 'copy') {
        deps.copyText(payload)
        write('UPDATE collab_request SET status=? WHERE id=?', 'copied', requestId)
        activity({
          missionId: row.mission_id, requestId, kind: row.kind, event: 'copied',
          summary: '已复制交接文本，等待人工粘贴',
          senderSlotId: sender?.slotId ?? null, senderRoleDisplay: sender?.roleDisplay ?? null,
          senderProvider: sender?.providerName ?? null,
          recipientSlotId: recipient?.slotId ?? null, recipientRoleDisplay: recipient?.roleDisplay ?? null,
          recipientProvider: recipient?.providerName ?? null, at: deps.now()
        })
        return { requestId, status: 'copied' }
      }
      if (!pipeAdapter) return { error: 'no-verified-pipe' }
      const secret = deps.newId() + deps.newId()
      const token = createHash('sha256').update(secret + ':' + requestId, 'utf8').digest('hex')
      write('UPDATE collab_request SET receipt_secret=?, receipt_token_hash=? WHERE id=?',
        secret, createHash('sha256').update(token, 'utf8').digest('hex'), requestId)
      let evidence: PipeDispatchReceipt
      try {
        evidence = pipeAdapter({ requestId, missionId: row.mission_id, toSlotId: row.to_slot,
          kind: row.kind, token, payloadText: payload })
      } catch (error) {
        write('UPDATE collab_request SET status=?, resolved_at=? WHERE id=?', 'failed', deps.now(), requestId)
        activity({
          missionId: row.mission_id, requestId, kind: row.kind, event: 'failed',
          summary: '投递失败：' + String((error as Error)?.message ?? error),
          senderSlotId: sender?.slotId ?? null, senderRoleDisplay: sender?.roleDisplay ?? null,
          senderProvider: sender?.providerName ?? null,
          recipientSlotId: recipient?.slotId ?? null, recipientRoleDisplay: recipient?.roleDisplay ?? null,
          recipientProvider: recipient?.providerName ?? null, at: deps.now()
        })
        return { requestId, status: 'failed' }
      }
      if (!isText(evidence?.evidenceRef)) {
        write('UPDATE collab_request SET status=?, resolved_at=? WHERE id=?', 'uncertain', deps.now(), requestId)
        activity({
          missionId: row.mission_id, requestId, kind: row.kind, event: 'uncertain',
          summary: '发送不明：管道未返回有效回执证据',
          senderSlotId: sender?.slotId ?? null, senderRoleDisplay: sender?.roleDisplay ?? null,
          senderProvider: sender?.providerName ?? null,
          recipientSlotId: recipient?.slotId ?? null, recipientRoleDisplay: recipient?.roleDisplay ?? null,
          recipientProvider: recipient?.providerName ?? null, at: deps.now()
        })
        return { requestId, status: 'uncertain' }
      }
      write('UPDATE collab_request SET status=?, sent_at=?, dispatch_json=? WHERE id=?',
        'sent', deps.now(), JSON.stringify({ evidenceRef: evidence.evidenceRef, at: deps.now() }), requestId)
      activity({
        missionId: row.mission_id, requestId, kind: row.kind, event: 'sent',
        summary: row.kind === 'handoff' ? '交接已发出，等待接手回执' : '已发出，等待接收回执',
        senderSlotId: sender?.slotId ?? null, senderRoleDisplay: sender?.roleDisplay ?? null,
        senderProvider: sender?.providerName ?? null,
        recipientSlotId: recipient?.slotId ?? null, recipientRoleDisplay: recipient?.roleDisplay ?? null,
        recipientProvider: recipient?.providerName ?? null, at: deps.now()
      })
      return { requestId, status: 'sent' }
    }),

    cancelRequest: tx((requestId: string): ConfirmOutcome => {
      const row = requestFor(requestId)
      if (!row) return { error: 'unknown-request' }
      if (row.status !== 'draft' && row.status !== 'copied') return { error: 'not-cancellable' }
      write('UPDATE collab_request SET status=?, resolved_at=? WHERE id=?', 'cancelled', deps.now(), requestId)
      activity({
        missionId: row.mission_id, requestId, kind: row.kind, event: 'cancelled',
        summary: row.status === 'copied' ? '已取消（复制内容无法撤回，请勿粘贴）' : '发送前已取消',
        senderSlotId: null, senderRoleDisplay: null, senderProvider: null,
        recipientSlotId: row.to_slot, recipientRoleDisplay: identitySnapshot(row.mission_id, row.to_slot)?.roleDisplay ?? null,
        recipientProvider: identitySnapshot(row.mission_id, row.to_slot)?.providerName ?? null, at: deps.now()
      })
      return { requestId, status: 'cancelled' }
    }),

    requestPayload(requestId: string): { text: string } | { error: string } {
      const row = requestFor(requestId)
      if (!row) return { error: 'unknown-request' }
      const materials = materialsOf(row)
      const artifact = row.artifact_json ? JSON.parse(row.artifact_json) as { name: string } : null
      return { text: requestText(row, materials, artifact?.name ?? null) }
    },

    artifactDir(missionId: string) {
      const dir = join(artifactRoot, missionId)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }
}

export type CollaborationCore = ReturnType<typeof makeCollaborationCore>
