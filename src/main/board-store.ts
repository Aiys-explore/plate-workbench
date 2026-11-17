import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteStore } from './notes'
import { uuidV4 } from '../shared/link-resolution'
import {
  BOARD_SCHEMA_VERSION, boardIdFor, boardIdPattern,
  type BoardCard, type BoardConnection, type BoardDocument, type BoardNoteRefStatus,
  type BoardOp, type BoardSaveInput, type BoardSaveResult, type BoardCardsResolution,
  type BoardOpenResult, type BoardView, type BoardViewport, type ResolvedCard,
} from '../shared/plate-board'

// 便签和引用卡片只存画板，不进笔记正文；布局按稳定文档 ID 保存。
const STICKY_TEXT_MAX = 2000
const CARD_MAX = 500
const CONNECTION_MAX = 1500
const OPS_MAX = 400
const CARD_W = { min: 140, max: 720 }
const CARD_H = { min: 100, max: 640 }
const ZOOM = { min: 0.25, max: 2.5 }

const isCardId = (value: unknown): value is string => typeof value === 'string' && uuidV4.test(value)
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

type LoadResult = BoardDocument | null | { error: 'board-corrupt' }

const defaultViewport = (): BoardViewport => ({ x: 40, y: 40, zoom: 1 })

const cardDefaults = (card: BoardCard): BoardCard => ({
  ...card,
  w: clamp(card.w, CARD_W.min, CARD_W.max),
  h: clamp(card.h, CARD_H.min, CARD_H.max)
})

// 读取时同时校验形状；主文件损坏时回退备份并恢复主文件。
function parseBoardFile(file: string, bakFile: string): { board: BoardDocument } | null | { error: 'board-corrupt' } {
  const attempts: { path: string; restore: boolean }[] = [
    { path: file, restore: false },
    { path: bakFile, restore: true }
  ]
  let missing = true
  for (const attempt of attempts) {
    if (!existsSync(attempt.path)) continue
    missing = false
    let raw: string
    try {
      raw = readFileSync(attempt.path, 'utf8')
    } catch {
      continue
    }
    try {
      const board = validateDocument(JSON.parse(raw))
      if (attempt.restore) {
        const tmp = `${file}.restore-tmp`
        writeFileSync(tmp, JSON.stringify(board))
        renameSync(tmp, file)
      }
      return { board }
    } catch {
      continue
    }
  }
  if (missing) return null
  return { error: 'board-corrupt' }
}

function validateDocument(value: unknown): BoardDocument {
  if (!value || typeof value !== 'object') throw new Error('shape')
  const doc = value as BoardDocument
  if (doc.schemaVersion !== BOARD_SCHEMA_VERSION) throw new Error('schema')
  if (typeof doc.boardId !== 'string' || !boardIdPattern.test(doc.boardId)) throw new Error('boardId')
  if (typeof doc.noteId !== 'string' || !uuidV4.test(doc.noteId)) throw new Error('noteId')
  if (doc.boardId !== boardIdFor(doc.noteId)) throw new Error('boardId-mismatch')
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) throw new Error('revision')
  if (!Array.isArray(doc.cards) || doc.cards.length > CARD_MAX) throw new Error('cards')
  if (!Array.isArray(doc.connections) || doc.connections.length > CONNECTION_MAX) throw new Error('connections')
  if (!isFinite(doc.viewport?.x) || !isFinite(doc.viewport?.y) || !isFinite(doc.viewport?.zoom)) throw new Error('viewport')
  if (!Number.isSafeInteger(doc.updatedAt)) throw new Error('updatedAt')
  const ids = new Set<string>()
  for (const card of doc.cards) {
    if (!isCardId(card?.id) || ids.has(card.id)) throw new Error('card-id')
    ids.add(card.id)
    if (!isFinite(card.x) || !isFinite(card.y) || !isFinite(card.w) || !isFinite(card.h)) throw new Error('card-geometry')
    if (!Number.isSafeInteger(card.version) || card.version < 1) throw new Error('card-version')
    if (card.kind === 'sticky') {
      if (typeof card.text !== 'string' || card.text.length > STICKY_TEXT_MAX) throw new Error('sticky-text')
    } else if (card.kind === 'note-ref') {
      if (typeof card.noteId !== 'string' || !uuidV4.test(card.noteId)) throw new Error('ref-note')
      if (typeof card.noteTitle !== 'string' || card.noteTitle.length > 240) throw new Error('ref-title')
      if (!Number.isSafeInteger(card.lineFrom) || !Number.isSafeInteger(card.lineTo) ||
          card.lineFrom < 1 || card.lineTo < card.lineFrom) throw new Error('ref-lines')
      if (typeof card.baseRevision !== 'string' || !card.baseRevision) throw new Error('ref-revision')
      if (typeof card.snapshotText !== 'string') throw new Error('ref-snapshot')
    } else throw new Error('card-kind')
  }
  const connectionIds = new Set<string>()
  for (const connection of doc.connections) {
    if (!isCardId(connection?.id) || connectionIds.has(connection.id)) throw new Error('connection-id')
    connectionIds.add(connection.id)
    if (!ids.has(connection.from) || !ids.has(connection.to) || connection.from === connection.to) {
      throw new Error('connection-endpoints')
    }
  }
  return doc
}

export class BoardStore {
  constructor(private readonly dir: string, private readonly notes: NoteStore) {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.dir)) throw new Error('画板目录不可用')
  }

  private paths(noteId: string) {
    const file = join(this.dir, `${noteId.toLowerCase()}.json`)
    return { file, bak: `${file}.bak` }
  }

  private load(noteId: string): LoadResult {
    const { file, bak } = this.paths(noteId)
    const parsed = parseBoardFile(file, bak)
    if (!parsed || 'error' in parsed) return parsed
    if (parsed.board.noteId !== noteId.toLowerCase()) return { error: 'board-corrupt' }
    return parsed.board
  }

  private write(board: BoardDocument) {
    const { file, bak } = this.paths(board.noteId)
    const tmp = `${file}.tmp`
    const data = JSON.stringify(board)
    writeFileSync(tmp, data, 'utf8')
    // 备份镜像最近一次完整写入：主文件被外部破坏时可恢复到最新有效布局。
    if (existsSync(file)) copyFileSync(file, bak)
    renameSync(tmp, file)
    writeFileSync(bak, data, 'utf8')
  }

  private noteRefStatus(board: BoardDocument): Record<string, BoardNoteRefStatus> {
    const status: Record<string, BoardNoteRefStatus> = {}
    const cache = new Map<string, BoardNoteRefStatus>()
    for (const card of board.cards) {
      if (card.kind !== 'note-ref') continue
      const cached = cache.get(card.noteId)
      if (cached) { status[card.id] = cached; continue }
      let entry: BoardNoteRefStatus
      try {
        const note = this.notes.read(card.noteId)
        entry = { exists: true, title: note.title, current: note.revision === card.baseRevision }
      } catch {
        entry = { exists: false, title: card.noteTitle, current: false }
      }
      cache.set(card.noteId, entry)
      status[card.id] = entry
    }
    return status
  }

  private withStatus(board: BoardDocument): BoardView {
    return { ...board, noteRefStatus: this.noteRefStatus(board) }
  }

  // 文档存在即有画板；首次打开生成空板并落盘。
  open(noteId: string): BoardOpenResult {
    if (typeof noteId !== 'string' || !uuidV4.test(noteId)) return { error: 'invalid-note' }
    try {
      this.notes.read(noteId)
    } catch {
      return { error: 'note-missing' }
    }
    const loaded = this.load(noteId)
    if (loaded && !('error' in loaded) && loaded !== null) return { board: this.withStatus(loaded) }
    if (loaded && 'error' in loaded) return loaded
    const board: BoardDocument = {
      schemaVersion: BOARD_SCHEMA_VERSION,
      boardId: boardIdFor(noteId),
      noteId: noteId.toLowerCase(),
      revision: 1,
      cards: [],
      connections: [],
      viewport: defaultViewport(),
      updatedAt: Date.now()
    }
    this.write(board)
    return { board: this.withStatus(board) }
  }

  save(input: BoardSaveInput): BoardSaveResult {
    if (!input || typeof input !== 'object') return { error: 'invalid-input' }
    if (typeof input.boardId !== 'string' || !boardIdPattern.test(input.boardId)) return { error: 'invalid-board' }
    if (typeof input.noteId !== 'string' || !uuidV4.test(input.noteId) ||
        input.boardId !== boardIdFor(input.noteId)) return { error: 'invalid-board' }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return { error: 'invalid-input' }
    if (!Array.isArray(input.ops) || input.ops.length === 0 || input.ops.length > OPS_MAX) return { error: 'invalid-input' }
    try {
      this.notes.read(input.noteId)
    } catch {
      return { error: 'note-missing' }
    }
    const loaded = this.load(input.noteId)
    if (loaded && 'error' in loaded) return loaded
    let board = loaded
    if (!board) {
      if (input.expectedRevision !== 1) return { error: 'board-missing' }
      board = {
        schemaVersion: BOARD_SCHEMA_VERSION, boardId: input.boardId, noteId: input.noteId.toLowerCase(),
        revision: 1, cards: [], connections: [], viewport: defaultViewport(), updatedAt: Date.now()
      }
    }
    if (board.revision !== input.expectedRevision) {
      return { error: 'layout-conflict', board: this.withStatus(board) }
    }
    try {
      for (const op of input.ops) applyOp(board, op, this.notes)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'invalid-op' }
    }
    board.revision += 1
    board.updatedAt = Date.now()
    this.write(board)
    return { board: this.withStatus(board) }
  }

  // 审查/交接材料解析：板 ID 定位本库画板，卡 ID + 卡内容版本 + 引用笔记实际修订逐一核对。
  resolveCards(input: { boardId: string; cards: { cardId: string; version: string }[] }): BoardCardsResolution {
    if (!input || typeof input.boardId !== 'string' || !boardIdPattern.test(input.boardId)) {
      return { error: 'invalid-board' }
    }
    if (!Array.isArray(input.cards) || input.cards.length === 0 ||
        !input.cards.every(card => isCardId(card?.cardId) && typeof card.version === 'string')) {
      return { error: 'invalid-board' }
    }
    const noteId = input.boardId.slice(2)
    const loaded = this.load(noteId)
    if (!loaded) return { error: 'board-missing' }
    if ('error' in loaded) return loaded
    const board = loaded
    const resolved: ResolvedCard[] = []
    for (const request of input.cards) {
      const card = board.cards.find(candidate => candidate.id === request.cardId)
      if (!card) return { error: 'board-card-missing' }
      if (String(card.version) !== request.version) return { error: 'board-card-stale' }
      if (card.kind === 'sticky') {
        resolved.push({ cardId: card.id, version: String(card.version), title: '便签', text: card.text })
        continue
      }
      let note
      try {
        note = this.notes.read(card.noteId)
      } catch {
        return { error: 'note-missing' }
      }
      if (note.revision !== card.baseRevision) return { error: 'board-card-stale' }
      const lines = note.content.split(/\r\n|\r|\n/)
      const text = lines.slice(card.lineFrom - 1, card.lineTo).join('\n')
      if (text !== card.snapshotText) return { error: 'board-card-stale' }
      resolved.push({ cardId: card.id, version: String(card.version), title: note.title, text })
    }
    return { cards: resolved }
  }
}

// 服务端单一事实来源：渲染器只提交操作，快照字段一律由主进程按当前磁盘版本重取。
function applyOp(board: BoardDocument, op: BoardOp, notes: NoteStore) {
  const findCard = (id: string) => board.cards.find(card => card.id === id)
  switch (op.op) {
    case 'sticky-add': {
      if (!isCardId(op.id) || !isFinite(op.x) || !isFinite(op.y)) throw new Error('invalid-op')
      if (findCard(op.id)) throw new Error('card-exists')
      if (board.cards.length >= CARD_MAX) throw new Error('card-limit')
      const text = typeof op.text === 'string' ? op.text : ''
      if (text.length > STICKY_TEXT_MAX) throw new Error('sticky-text-too-long')
      board.cards.push(cardDefaults({
        kind: 'sticky', id: op.id, version: 1,
        x: op.x, y: op.y, w: 220, h: 140, text
      }))
      return
    }
    case 'sticky-text': {
      const card = findCard(op.id)
      if (!card || card.kind !== 'sticky') throw new Error('card-missing')
      if (typeof op.text !== 'string' || op.text.length > STICKY_TEXT_MAX) throw new Error('sticky-text-too-long')
      if (card.text !== op.text) { card.text = op.text; card.version += 1 }
      return
    }
    case 'note-ref-add': {
      if (!isCardId(op.id) || !isFinite(op.x) || !isFinite(op.y)) throw new Error('invalid-op')
      if (typeof op.noteId !== 'string' || !uuidV4.test(op.noteId)) throw new Error('invalid-op')
      if (!Number.isSafeInteger(op.lineFrom) || !Number.isSafeInteger(op.lineTo) ||
          op.lineFrom < 1 || op.lineTo < op.lineFrom) throw new Error('invalid-op')
      if (findCard(op.id)) throw new Error('card-exists')
      if (board.cards.length >= CARD_MAX) throw new Error('card-limit')
      let note
      try {
        note = notes.read(op.noteId)
      } catch {
        throw new Error('note-missing')
      }
      const lines = note.content.split(/\r\n|\r|\n/)
      if (op.lineTo > lines.length) throw new Error('selection-out-of-range')
      const snapshotText = lines.slice(op.lineFrom - 1, op.lineTo).join('\n')
      if (!snapshotText.trim()) throw new Error('empty-selection')
      board.cards.push(cardDefaults({
        kind: 'note-ref', id: op.id, version: 1,
        x: op.x, y: op.y, w: 260, h: 180,
        noteId: note.id, noteTitle: note.title,
        lineFrom: op.lineFrom, lineTo: op.lineTo,
        baseRevision: note.revision, snapshotText
      }))
      return
    }
    case 'note-ref-refresh': {
      const card = findCard(op.id)
      if (!card || card.kind !== 'note-ref') throw new Error('card-missing')
      let note
      try {
        note = notes.read(card.noteId)
      } catch {
        throw new Error('note-missing')
      }
      const lines = note.content.split(/\r\n|\r|\n/)
      if (card.lineTo > lines.length) throw new Error('selection-out-of-range')
      card.noteTitle = note.title
      card.baseRevision = note.revision
      card.snapshotText = lines.slice(card.lineFrom - 1, card.lineTo).join('\n')
      card.version += 1
      return
    }
    case 'move': {
      const card = findCard(op.id)
      if (!card || !isFinite(op.x) || !isFinite(op.y)) throw new Error('invalid-op')
      card.x = clamp(op.x, -20000, 20000)
      card.y = clamp(op.y, -20000, 20000)
      return
    }
    case 'size': {
      const card = findCard(op.id)
      if (!card || !isFinite(op.w) || !isFinite(op.h)) throw new Error('invalid-op')
      card.w = clamp(op.w, CARD_W.min, CARD_W.max)
      card.h = clamp(op.h, CARD_H.min, CARD_H.max)
      return
    }
    case 'connect': {
      if (!isCardId(op.id) || !isCardId(op.from) || !isCardId(op.to)) throw new Error('invalid-op')
      if (!findCard(op.from) || !findCard(op.to) || op.from === op.to) throw new Error('connection-endpoints')
      if (board.connections.some(c => (c.from === op.from && c.to === op.to) || (c.from === op.to && c.to === op.from))) {
        throw new Error('connection-exists')
      }
      if (board.connections.length >= CONNECTION_MAX) throw new Error('connection-limit')
      board.connections.push({ id: op.id, from: op.from, to: op.to })
      return
    }
    case 'disconnect': {
      const index = board.connections.findIndex(connection => connection.id === op.id)
      if (index < 0) throw new Error('connection-missing')
      board.connections.splice(index, 1)
      return
    }
    case 'delete-card': {
      const index = board.cards.findIndex(card => card.id === op.id)
      if (index < 0) throw new Error('card-missing')
      board.cards.splice(index, 1)
      board.connections = board.connections.filter(connection => connection.from !== op.id && connection.to !== op.id)
      return
    }
    case 'delete-connection': {
      return applyOp(board, { op: 'disconnect', id: op.id }, notes)
    }
    case 'viewport': {
      if (!isFinite(op.x) || !isFinite(op.y) || !isFinite(op.zoom)) throw new Error('invalid-op')
      board.viewport = {
        x: clamp(op.x, -100000, 100000),
        y: clamp(op.y, -100000, 100000),
        zoom: clamp(op.zoom, ZOOM.min, ZOOM.max)
      }
      return
    }
    default:
      throw new Error('invalid-op')
  }
}

