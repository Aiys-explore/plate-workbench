// R2 画板契约：同一文档身份下的画板布局、原子持久化与卡片解析。
// 布局按稳定笔记 ID 落盘（scopes/boards/<noteId>.json），不改笔记正文。
export const BOARD_SCHEMA_VERSION = 1

// 板 ID 由主进程按文档派生：b-<noteId>。跨笔记库的板 ID 落不进本库 boards 目录。
export const boardIdFor = (noteId: string) => `b-${noteId.toLowerCase()}`
export const boardIdPattern = /^b-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface BoardStickyCard {
  kind: 'sticky'
  id: string
  // 内容版本：正文编辑 +1；位置/尺寸不递增。审查解析用它做过期核对。
  version: number
  x: number
  y: number
  w: number
  h: number
  text: string
}

export interface BoardNoteRefCard {
  kind: 'note-ref'
  id: string
  version: number
  x: number
  y: number
  w: number
  h: number
  noteId: string
  // 引用建立/刷新时的快照（R4 语义：材料是固定版本，不随正文自动变化）。
  noteTitle: string
  lineFrom: number
  lineTo: number
  baseRevision: string
  snapshotText: string
}

export type BoardCard = BoardStickyCard | BoardNoteRefCard

export interface BoardConnection {
  id: string
  from: string
  to: string
}

export interface BoardViewport {
  x: number
  y: number
  zoom: number
}

export interface BoardDocument {
  schemaVersion: number
  boardId: string
  noteId: string
  // 布局修订：乐观并发锁，服务端单调递增。
  revision: number
  cards: BoardCard[]
  connections: BoardConnection[]
  viewport: BoardViewport
  updatedAt: number
}

export interface BoardNoteRefStatus {
  exists: boolean
  title: string
  // baseRevision 是否仍等于磁盘当前修订；false 时卡片显示「已过期」。
  current: boolean
}

export interface BoardView extends BoardDocument {
  noteRefStatus: Record<string, BoardNoteRefStatus>
}

export type BoardOp =
  | { op: 'sticky-add'; id: string; x: number; y: number; text?: string }
  | { op: 'sticky-text'; id: string; text: string }
  | { op: 'note-ref-add'; id: string; noteId: string; lineFrom: number; lineTo: number; x: number; y: number }
  | { op: 'note-ref-refresh'; id: string }
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'size'; id: string; w: number; h: number }
  | { op: 'connect'; id: string; from: string; to: string }
  | { op: 'disconnect'; id: string }
  | { op: 'delete-card'; id: string }
  | { op: 'delete-connection'; id: string }
  | { op: 'viewport'; x: number; y: number; zoom: number }

export interface BoardSaveInput {
  boardId: string
  noteId: string
  expectedRevision: number
  ops: BoardOp[]
}

export type BoardSaveResult = { board: BoardView } | { error: 'layout-conflict'; board: BoardView } | { error: string }
export type BoardOpenResult = { board: BoardView } | { error: string }

export interface ResolvedCard {
  cardId: string
  version: string
  title: string
  text: string
}

export type BoardCardsResolution =
  | { cards: ResolvedCard[] }
  | { error:
      | 'invalid-board' | 'board-missing' | 'board-corrupt' | 'note-missing'
      | 'board-card-missing' | 'board-card-stale' }

export interface BoardApi {
  open(noteId: string): Promise<BoardOpenResult>
  save(input: BoardSaveInput): Promise<BoardSaveResult>
  // 页面卸载（重载/关窗）时渲染器无法等待异步 IPC；同步通道保证待存操作落盘。
  saveSync(input: BoardSaveInput): BoardSaveResult
}

export const boardIPC = {
  open: 'board:open',
  save: 'board:save',
  saveSync: 'board:save-sync'
} as const
