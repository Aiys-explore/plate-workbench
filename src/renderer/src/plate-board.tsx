import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardConnection, BoardDocument, BoardNoteRefStatus, BoardOp, BoardView,
} from '../../shared/plate-board'

export interface BoardSelectionSnapshot {
  baseRevision: string
  lineFrom: number
  lineTo: number
  text: string
  noteTitle: string
}

interface NoteRefSnapshot {
  noteId: string
  noteTitle: string
  lineFrom: number
  lineTo: number
  baseRevision: string
  snapshotText: string
}

interface UndoEntry {
  redo: BoardOp[]
  undo: BoardOp[]
  key: string
  at: number
}

const uuid = () => crypto.randomUUID()
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const ZOOM = { min: 0.25, max: 2.5, step: 1.2 }

// 本地镜像与服务端同一套操作语义；引用快照由主进程按磁盘版本重取，
// 本地仅用创建时捕获的快照做乐观渲染。
function applyLocal(doc: BoardDocument, op: BoardOp, snapshots: Map<string, NoteRefSnapshot>) {
  const card = 'id' in op ? doc.cards.find(candidate => candidate.id === op.id) : undefined
  switch (op.op) {
    case 'sticky-add':
      doc.cards.push({ kind: 'sticky', id: op.id, version: 1, x: op.x, y: op.y, w: 220, h: 140, text: op.text ?? '' })
      return
    case 'sticky-text':
      if (card?.kind === 'sticky' && card.text !== op.text) { card.text = op.text; card.version += 1 }
      return
    case 'note-ref-add': {
      const snapshot = snapshots.get(op.id)
      if (!snapshot) return
      doc.cards.push({
        kind: 'note-ref', id: op.id, version: 1, x: op.x, y: op.y, w: 260, h: 180,
        noteId: snapshot.noteId, noteTitle: snapshot.noteTitle, lineFrom: snapshot.lineFrom,
        lineTo: snapshot.lineTo, baseRevision: snapshot.baseRevision, snapshotText: snapshot.snapshotText
      })
      return
    }
    case 'note-ref-refresh': return
    case 'move': if (card) { card.x = op.x; card.y = op.y } return
    case 'size': if (card) { card.w = op.w; card.h = op.h } return
    case 'connect': doc.connections.push({ id: op.id, from: op.from, to: op.to }); return
    case 'disconnect':
    case 'delete-connection':
      doc.connections = doc.connections.filter(connection => connection.id !== op.id)
      return
    case 'delete-card':
      doc.cards = doc.cards.filter(entry => entry.id !== op.id)
      doc.connections = doc.connections.filter(connection => connection.from !== op.id && connection.to !== op.id)
      return
    case 'viewport': doc.viewport = { x: op.x, y: op.y, zoom: op.zoom }; return
  }
}

function inverseFor(doc: BoardDocument, op: BoardOp, snapshots: Map<string, NoteRefSnapshot>): BoardOp[] | null {
  const card = 'id' in op ? doc.cards.find(candidate => candidate.id === op.id) : undefined
  switch (op.op) {
    case 'sticky-add': return [{ op: 'delete-card', id: op.id }]
    case 'sticky-text': return card?.kind === 'sticky' ? [{ op: 'sticky-text', id: op.id, text: card.text }] : null
    case 'note-ref-add': return [{ op: 'delete-card', id: op.id }]
    case 'note-ref-refresh': return null
    case 'move': return card ? [{ op: 'move', id: op.id, x: card.x, y: card.y }] : null
    case 'size': return card ? [{ op: 'size', id: op.id, w: card.w, h: card.h }] : null
    case 'connect': return [{ op: 'disconnect', id: op.id }]
    case 'disconnect': {
      const connection = doc.connections.find(entry => entry.id === op.id)
      return connection ? [{ op: 'connect', id: connection.id, from: connection.from, to: connection.to }] : null
    }
    case 'delete-connection': {
      const connection = doc.connections.find(entry => entry.id === op.id)
      return connection ? [{ op: 'connect', id: connection.id, from: connection.from, to: connection.to }] : null
    }
    case 'delete-card': {
      if (!card) return null
      return card.kind === 'sticky'
        ? [{ op: 'sticky-add', id: card.id, x: card.x, y: card.y, text: card.text }]
        : [{ op: 'note-ref-add', id: card.id, noteId: card.noteId, lineFrom: card.lineFrom,
            lineTo: card.lineTo, x: card.x, y: card.y }]
    }
    case 'viewport': return null
  }
}

const saveErrorText = (error: string) => ({
  'note-missing': '来源笔记已删除，画板修改无法保存。',
  'invalid-op': '画板操作未通过服务端校验，已停止保存。',
  'invalid-board': '画板标识无效。',
  'board-missing': '画板文件缺失，请重新打开文档。',
  'board-corrupt': '画板文件损坏且备份不可用，修改未写入。'
}[error] ?? '画板保存失败，请稍后重试。')

export function PlateBoard({ note, getSelection, onOpenNote, disabled }: {
  note: { id: string; title: string }
  getSelection: () => BoardSelectionSnapshot | null
  onOpenNote: (noteId: string) => void
  disabled?: string | null
}) {
  const api = window.workbench.board
  const [doc, setDoc] = useState<BoardDocument | null>(null)
  const [noteRefStatus, setNoteRefStatus] = useState<Record<string, BoardNoteRefStatus>>({})
  const [status, setStatus] = useState('正在载入画板…')
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedConnections, setSelectedConnections] = useState<Set<string>>(new Set())
  const [connecting, setConnecting] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const docRef = useRef<BoardDocument | null>(null)
  const revisionRef = useRef(0)
  const pendingRef = useRef<BoardOp[]>([])
  const undoRef = useRef<UndoEntry[]>([])
  const redoRef = useRef<UndoEntry[]>([])
  const snapshotsRef = useRef(new Map<string, NoteRefSnapshot>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  const interactionRef = useRef<null | {
    kind: 'pan' | 'drag' | 'resize' | 'marquee'
    pointerId: number
    startX: number
    startY: number
    origin?: { x: number; y: number }
    cards?: Map<string, { x: number; y: number }>
    cardId?: string
  } | null>(null)
  viewRef.current = view
  const disabledRef = useRef(false)
  disabledRef.current = !!disabled

  const adopt = (board: BoardView) => {
    const next: BoardDocument = {
      schemaVersion: board.schemaVersion, boardId: board.boardId, noteId: board.noteId,
      revision: board.revision, cards: clone(board.cards), connections: clone(board.connections),
      viewport: clone(board.viewport), updatedAt: board.updatedAt
    }
    docRef.current = next
    revisionRef.current = board.revision
    setDoc(next)
    setNoteRefStatus(board.noteRefStatus)
    if (!interactionRef.current) setView(clone(board.viewport))
  }

  useEffect(() => {
    let cancelled = false
    docRef.current = null
    revisionRef.current = 0
    pendingRef.current = []
    undoRef.current = []
    redoRef.current = []
    snapshotsRef.current = new Map()
    setSelected(new Set())
    setSelectedConnections(new Set())
    setConnecting(null)
    setEditing(null)
    setStatus('正在载入画板…')
    void api.open(note.id).then(result => {
      if (cancelled) return
      if ('error' in result) {
        setStatus(({ 'note-missing': '笔记不存在，画板不可用。', 'invalid-note': '笔记标识无效。' } as Record<string, string>)[result.error] ??
          '画板载入失败，请重试。')
        return
      }
      adopt(result.board)
      setStatus('')
    }).catch(() => { if (!cancelled) setStatus('画板载入失败，请重试。') })
    return () => {
      cancelled = true
      clearTimeout(saveTimer.current)
      if (pendingRef.current.length > 0) void flush()
    }
  }, [note.id])

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  // 重载或关窗不会等待异步保存；待存操作必须同步落盘，否则 350ms 防抖窗口内的修改会丢。
  useEffect(() => {
    const flushOnHide = () => {
      clearTimeout(saveTimer.current)
      const current = docRef.current
      const ops = pendingRef.current
      if (!current || ops.length === 0) return
      pendingRef.current = []
      const result = api.saveSync({ boardId: current.boardId, noteId: current.noteId,
        expectedRevision: revisionRef.current, ops })
      if (!('error' in result)) return
      if ('board' in result) return
      pendingRef.current = [...ops, ...pendingRef.current]
    }
    window.addEventListener('pagehide', flushOnHide)
    return () => window.removeEventListener('pagehide', flushOnHide)
  }, [])

  const scheduleSave = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flush(), 350)
  }

  const flush = async () => {
    const current = docRef.current
    if (!current) return
    const ops = pendingRef.current
    if (ops.length === 0) return
    pendingRef.current = []
    setSaving(true)
    try {
      const result = await api.save({ boardId: current.boardId, noteId: current.noteId,
        expectedRevision: revisionRef.current, ops })
      if (docRef.current !== current) return
      if ('error' in result) {
        if ('board' in result) {
          pendingRef.current = []
          undoRef.current = []
          redoRef.current = []
          adopt(result.board)
          setStatus('画板已在其他窗口修改：已载入最新布局，本窗口未写入的改动与撤销历史已清空。')
        } else {
          if (result.error === 'invalid-op') {
            setStatus('画板操作未通过服务端校验：相关改动已放弃，后续保存继续。')
            return
          }
          pendingRef.current = [...ops, ...pendingRef.current]
          setStatus(saveErrorText(result.error))
        }
        return
      }
      revisionRef.current = result.board.revision
      if (pendingRef.current.length === 0) {
        adopt(result.board)
        setStatus('')
      } else {
        setNoteRefStatus(result.board.noteRefStatus)
        setStatus('')
      }
    } catch {
      pendingRef.current = [...ops, ...pendingRef.current]
      setStatus('画板保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  const pushUndo = (entry: UndoEntry) => {
    const top = undoRef.current.at(-1)
    if (top && top.key === entry.key && entry.at - top.at < 900 &&
        top.redo.length === entry.redo.length) {
      top.at = entry.at
      top.redo = entry.redo
      return
    }
    undoRef.current.push(entry)
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
  }

  const mutate = (ops: BoardOp[], options?: {
    key?: string; snapshots?: Map<string, NoteRefSnapshot>; inverse?: BoardOp[]
  }) => {
    const current = docRef.current
    if (!current) return
    const snapshots = options?.snapshots
    if (snapshots) for (const [id, snapshot] of snapshots) snapshotsRef.current.set(id, snapshot)
    const undoOps: BoardOp[] = []
    let undoable = false
    if (options?.inverse) {
      undoable = true
      undoOps.push(...options.inverse)
      for (const op of ops) applyLocal(current, op, snapshotsRef.current)
    } else {
      for (const op of ops) {
        const inverse = inverseFor(current, op, snapshotsRef.current)
        if (inverse) { undoable = true; undoOps.unshift(...inverse) }
        applyLocal(current, op, snapshotsRef.current)
      }
    }
    if (undoable && options?.key !== undefined) {
      pushUndo({ redo: ops, undo: undoOps, key: options.key, at: Date.now() })
    }
    pendingRef.current.push(...ops)
    setDoc(clone(current))
    scheduleSave()
  }

  const undo = () => {
    const entry = undoRef.current.pop()
    const current = docRef.current
    if (!entry || !current) return
    for (const op of entry.undo) applyLocal(current, op, snapshotsRef.current)
    pendingRef.current.push(...entry.undo)
    redoRef.current.push(entry)
    setDoc(clone(current))
    scheduleSave()
  }

  const redo = () => {
    const entry = redoRef.current.pop()
    const current = docRef.current
    if (!entry || !current) return
    for (const op of entry.redo) applyLocal(current, op, snapshotsRef.current)
    pendingRef.current.push(...entry.redo)
    undoRef.current.push(entry)
    setDoc(clone(current))
    scheduleSave()
  }

  const boardPoint = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const current = viewRef.current
    return {
      x: ((clientX - (rect?.left ?? 0)) - current.x) / current.zoom,
      y: ((clientY - (rect?.top ?? 0)) - current.y) / current.zoom
    }
  }

  const saveViewport = (next: { x: number; y: number; zoom: number }) => {
    setView(next)
    mutate([{ op: 'viewport', x: next.x, y: next.y, zoom: next.zoom }])
  }

  const zoomAround = (factor: number, clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const current = viewRef.current
    const zoom = clamp(current.zoom * factor, ZOOM.min, ZOOM.max)
    const px = clientX - rect.left
    const py = clientY - rect.top
    saveViewport({
      x: px - (px - current.x) * (zoom / current.zoom),
      y: py - (py - current.y) * (zoom / current.zoom),
      zoom
    })
  }

  const fit = () => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const current = docRef.current
    if (!rect) return
    if (!current || current.cards.length === 0) { saveViewport({ x: 40, y: 40, zoom: 1 }); return }
    const minX = Math.min(...current.cards.map(card => card.x))
    const minY = Math.min(...current.cards.map(card => card.y))
    const maxX = Math.max(...current.cards.map(card => card.x + card.w))
    const maxY = Math.max(...current.cards.map(card => card.y + card.h))
    const zoom = clamp(Math.min((rect.width - 96) / (maxX - minX), (rect.height - 96) / (maxY - minY), 1), ZOOM.min, ZOOM.max)
    saveViewport({
      x: rect.width / 2 - (minX + maxX) / 2 * zoom,
      y: rect.height / 2 - (minY + maxY) / 2 * zoom,
      zoom
    })
  }

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const wheel = (event: WheelEvent) => {
      if (disabledRef.current) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) zoomAround(event.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step, event.clientX, event.clientY)
      else {
        const current = viewRef.current
        saveViewport({ x: current.x - event.deltaX, y: current.y - event.deltaY, zoom: current.zoom })
      }
    }
    surface.addEventListener('wheel', wheel, { passive: false })
    return () => surface.removeEventListener('wheel', wheel)
  }, [doc, disabled])

  const addSticky = () => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const center = boardPoint((rect?.left ?? 0) + (rect?.width ?? 800) / 2, (rect?.top ?? 0) + (rect?.height ?? 600) / 2)
    const id = uuid()
    const offset = (docRef.current?.cards.length ?? 0) % 6
    mutate([{ op: 'sticky-add', id, x: Math.round(center.x - 110) + offset * 36, y: Math.round(center.y - 70) + offset * 28 }],
      { key: `add:${id}` })
    setSelected(new Set([id]))
    setSelectedConnections(new Set())
    setEditing(id)
    setStatus('')
  }

  const addNoteRef = () => {
    const snapshot = getSelection()
    if (!snapshot) { setStatus('引用前请先保存笔记，并在正文中选中要引用的内容。'); return }
    const rect = viewportRef.current?.getBoundingClientRect()
    const center = boardPoint((rect?.left ?? 0) + (rect?.width ?? 800) / 2, (rect?.top ?? 0) + (rect?.height ?? 600) / 2)
    const id = uuid()
    const offset = (docRef.current?.cards.length ?? 0) % 6
    const snapshots = new Map<string, NoteRefSnapshot>([[id, {
      noteId: note.id, noteTitle: snapshot.noteTitle, lineFrom: snapshot.lineFrom,
      lineTo: snapshot.lineTo, baseRevision: snapshot.baseRevision, snapshotText: snapshot.text
    }]])
    mutate([{ op: 'note-ref-add', id, noteId: note.id, lineFrom: snapshot.lineFrom,
      lineTo: snapshot.lineTo, x: Math.round(center.x - 130) + offset * 36, y: Math.round(center.y - 90) + offset * 28 }], {
      key: `add:${id}`, snapshots
    })
    setSelected(new Set([id]))
    setSelectedConnections(new Set())
    setStatus('')
  }

  const cardState = (card: BoardDocument['cards'][number]) => {
    if (card.kind !== 'note-ref') return 'ok'
    const state = noteRefStatus[card.id]
    if (!state) return 'ok'
    if (!state.exists) return 'gone'
    return state.current ? 'ok' : 'stale'
  }

  const sendSelection = () => {
    const current = docRef.current
    if (!current) return
    const cards = current.cards.filter(card => selected.has(card.id))
    if (cards.length === 0) { setStatus('先选择要发送的卡片。'); return }
    const text = cards.map(card => card.kind === 'sticky' ? card.text : card.noteTitle + '\n' + card.snapshotText).filter(Boolean).join('\n\n')
    if (!text.trim()) { setStatus('所选卡片没有可以发送的文字。'); return }
    window.dispatchEvent(new CustomEvent('plate-note-destination', { detail: {
      noteId: note.id, revision: String(current.revision), title: `画板 · ${note.title}`, text: text.trim()
    } }))
  }

  const deleteSelection = () => {
    const current = docRef.current
    if (!current) return
    const ops: BoardOp[] = []
    const snapshots = new Map<string, NoteRefSnapshot>()
    for (const connectionId of selectedConnections) {
      if (current.connections.some(entry => entry.id === connectionId)) {
        ops.push({ op: 'delete-connection', id: connectionId })
      }
    }
    for (const cardId of selected) {
      const card = current.cards.find(entry => entry.id === cardId)
      if (!card) continue
      if (card.kind === 'note-ref') snapshots.set(card.id, {
        noteId: card.noteId, noteTitle: card.noteTitle, lineFrom: card.lineFrom,
        lineTo: card.lineTo, baseRevision: card.baseRevision, snapshotText: card.snapshotText
      })
      ops.push({ op: 'delete-card', id: cardId })
    }
    if (!ops.length) return
    mutate(ops, { key: `delete:${Date.now()}`, snapshots })
    setSelected(new Set())
    setSelectedConnections(new Set())
  }

  const onCardPointerDown = (cardId: string, event: React.PointerEvent) => {
    if (disabledRef.current || event.button !== 0) return
    if (editing === cardId) return
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input')) return
    event.stopPropagation()
    const current = docRef.current
    if (!current) return
    if (connecting !== null) {
      if (connecting === '') { setConnecting(cardId); return }
      if (connecting === cardId) return
      const id = uuid()
      mutate([{ op: 'connect', id, from: connecting, to: cardId }], { key: `connect:${id}` })
      setConnecting(null)
      setStatus('')
      return
    }
    if (event.shiftKey) {
      const nextSelected = new Set(selected)
      if (nextSelected.has(cardId)) nextSelected.delete(cardId)
      else nextSelected.add(cardId)
      setSelected(nextSelected)
      setSelectedConnections(new Set())
      return
    }
    setSelected(selected.has(cardId) ? selected : new Set([cardId]))
    setSelectedConnections(new Set())
    const cards = new Map<string, { x: number; y: number }>()
    for (const id of (selected.has(cardId) ? selected : [cardId])) {
      const card = current.cards.find(entry => entry.id === id)
      if (card) cards.set(id, { x: card.x, y: card.y })
    }
    interactionRef.current = { kind: 'drag', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, cards }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onViewportPointerDown = (event: React.PointerEvent) => {
    if (disabledRef.current || event.button !== 0 || !docRef.current) return
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('plate-board-canvas') &&
        !(event.target as HTMLElement).classList.contains('plate-board-plane')) return
    const point = boardPoint(event.clientX, event.clientY)
    if (event.shiftKey) {
      interactionRef.current = { kind: 'marquee', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY }
      setMarquee({ x1: point.x, y1: point.y, x2: point.x, y2: point.y })
      return
    }
    interactionRef.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      origin: { x: viewRef.current.x, y: viewRef.current.y } }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelected(new Set())
    setSelectedConnections(new Set())
    setConnecting(null)
  }

  const onSurfacePointerMove = (event: React.PointerEvent) => {
    const interaction = interactionRef.current
    const current = docRef.current
    if (!interaction || interaction.pointerId !== event.pointerId || !current) return
    if (interaction.kind === 'pan' && interaction.origin) {
      setView({
        x: interaction.origin.x + (event.clientX - interaction.startX),
        y: interaction.origin.y + (event.clientY - interaction.startY),
        zoom: viewRef.current.zoom
      })
      return
    }
    if (interaction.kind === 'drag' && interaction.cards) {
      const dx = (event.clientX - interaction.startX) / viewRef.current.zoom
      const dy = (event.clientY - interaction.startY) / viewRef.current.zoom
      for (const [id, origin] of interaction.cards) {
        const card = current.cards.find(entry => entry.id === id)
        if (card) { card.x = origin.x + dx; card.y = origin.y + dy }
      }
      setDoc(clone(current))
      return
    }
    if (interaction.kind === 'marquee') {
      const point = boardPoint(event.clientX, event.clientY)
      setMarquee(previous => previous ? { ...previous, x2: point.x, y2: point.y } : previous)
    }
  }

  const onSurfacePointerUp = (event: React.PointerEvent) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    interactionRef.current = null
    if (interaction.kind === 'pan' && interaction.origin) {
      saveViewport({
        x: interaction.origin.x + (event.clientX - interaction.startX),
        y: interaction.origin.y + (event.clientY - interaction.startY),
        zoom: viewRef.current.zoom
      })
      return
    }
    if (interaction.kind === 'drag' && interaction.cards) {
      const ops: BoardOp[] = []
      const inverse: BoardOp[] = []
      for (const [id, origin] of interaction.cards) {
        const card = docRef.current?.cards.find(entry => entry.id === id)
        if (card && (Math.round(card.x) !== Math.round(origin.x) || Math.round(card.y) !== Math.round(origin.y))) {
          ops.push({ op: 'move', id, x: Math.round(card.x), y: Math.round(card.y) })
          inverse.unshift({ op: 'move', id, x: origin.x, y: origin.y })
        }
      }
      if (ops.length) mutate(ops, { key: `drag:${Date.now()}`, inverse })
      return
    }
    if (interaction.kind === 'marquee') {
      const current = docRef.current
      if (current && marquee) {
        const x1 = Math.min(marquee.x1, marquee.x2), x2 = Math.max(marquee.x1, marquee.x2)
        const y1 = Math.min(marquee.y1, marquee.y2), y2 = Math.max(marquee.y1, marquee.y2)
        const hits = current.cards.filter(card => card.x < x2 && card.x + card.w > x1 && card.y < y2 && card.y + card.h > y1)
        setSelected(new Set(hits.map(card => card.id)))
        setSelectedConnections(new Set())
      }
      setMarquee(null)
    }
  }

  const onResizePointerDown = (cardId: string, event: React.PointerEvent) => {
    if (disabledRef.current || event.button !== 0) return
    event.stopPropagation()
    const card = docRef.current?.cards.find(entry => entry.id === cardId)
    if (!card) return
    interactionRef.current = { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      cardId, origin: { x: card.w, y: card.h } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onResizePointerMove = (event: React.PointerEvent) => {
    const interaction = interactionRef.current
    const current = docRef.current
    if (!interaction || interaction.kind !== 'resize' || interaction.pointerId !== event.pointerId || !current) return
    const card = current.cards.find(entry => entry.id === interaction.cardId)
    if (!card) return
    card.w = (interaction.origin?.x ?? card.w) + (event.clientX - interaction.startX) / viewRef.current.zoom
    card.h = (interaction.origin?.y ?? card.h) + (event.clientY - interaction.startY) / viewRef.current.zoom
    setDoc(clone(current))
  }

  const onResizePointerUp = (event: React.PointerEvent) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.kind !== 'resize' || interaction.pointerId !== event.pointerId) return
    interactionRef.current = null
    const card = docRef.current?.cards.find(entry => entry.id === interaction.cardId)
    if (!card || !interaction.origin) return
    if (Math.round(card.w) !== Math.round(interaction.origin.x) || Math.round(card.h) !== Math.round(interaction.origin.y)) {
      mutate([{ op: 'size', id: card.id, w: Math.round(card.w), h: Math.round(card.h) }], { key: `size:${card.id}`,
        inverse: [{ op: 'size', id: card.id, w: interaction.origin.x, h: interaction.origin.y }] })
    }
  }

  const commitStickyText = (cardId: string, text: string) => {
    setEditing(null)
    const card = docRef.current?.cards.find(entry => entry.id === cardId)
    if (!card || card.kind !== 'sticky' || card.text === text) return
    mutate([{ op: 'sticky-text', id: cardId, text }], { key: `text:${cardId}` })
  }

  const refreshRef = (cardId: string) => {
    mutate([{ op: 'note-ref-refresh', id: cardId }])
    setStatus('引用快照将按笔记当前保存版本刷新。')
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabledRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    const inTextArea = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
    if (event.key === 'Escape') {
      if (connecting !== null) { setConnecting(null); return }
      if (marquee) { setMarquee(null); return }
      setSelected(new Set())
      setSelectedConnections(new Set())
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (!inTextArea && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (!inTextArea && key === 'y') {
        event.preventDefault()
        redo()
      } else if (key === 'a' && !inTextArea) {
        event.preventDefault()
        setSelected(new Set((docRef.current?.cards ?? []).map(card => card.id)))
        setSelectedConnections(new Set())
      }
      return
    }
    if (inTextArea) return
    const cards = docRef.current?.cards ?? []
    if (event.key === 'Tab') {
      event.preventDefault()
      if (!cards.length) return
      const ids = cards.map(card => card.id)
      const current = [...selected].find(id => ids.includes(id))
      const index = current === undefined ? (event.shiftKey ? ids.length - 1 : 0)
        : (ids.indexOf(current) + (event.shiftKey ? -1 : 1) + ids.length) % ids.length
      setSelected(new Set([ids[index]!]))
      setSelectedConnections(new Set())
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      deleteSelection()
      return
    }
    if (event.key === 'Enter') {
      if (selected.size === 1) {
        const card = cards.find(entry => selected.has(entry.id))
        if (card?.kind === 'note-ref' && cardState(card) !== 'gone') { event.preventDefault(); onOpenNote(card.noteId) }
      }
      return
    }
    if (event.key.startsWith('Arrow') && selected.size > 0) {
      event.preventDefault()
      const step = event.shiftKey ? 1 : 16
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      const ops: BoardOp[] = []
      for (const id of selected) {
        const card = cards.find(entry => entry.id === id)
        if (card) ops.push({ op: 'move', id, x: card.x + dx, y: card.y + dy })
      }
      if (ops.length) mutate(ops, { key: `nudge:${[...selected].sort().join(',')}` })
    }
  }

  const connectionPath = useMemo(() => {
    if (!doc) return [] as { connection: BoardConnection; x1: number; y1: number; x2: number; y2: number }[]
    return doc.connections.flatMap(connection => {
      const from = doc.cards.find(card => card.id === connection.from)
      const to = doc.cards.find(card => card.id === connection.to)
      if (!from || !to) return []
      return [{
        connection,
        x1: from.x + from.w / 2, y1: from.y + from.h / 2,
        x2: to.x + to.w / 2, y2: to.y + to.h / 2
      }]
    })
  }, [doc])

  if (!doc) {
    return <section className="plate-board" aria-label={`画板 · ${note.title}`}>
      <p className="plate-board-message" role="status">{status || '画板载入中…'}</p>
    </section>
  }

  return <section className="plate-board" aria-label={`画板 · ${note.title}`}
    data-disabled={disabled ? 'true' : undefined}>
    <div className="plate-board-toolbar" role="toolbar" aria-label="画板工具">
      <button type="button" onClick={addSticky} disabled={!!disabled}>添加便签</button>
      <button type="button" onClick={addNoteRef} disabled={!!disabled}>引用选区</button>
      <button type="button" aria-pressed={connecting !== null} onClick={() => setConnecting(old => old === null ? '' : null)}
        disabled={!!disabled}>{connecting !== null ? '取消连线' : '连线'}</button>
      <span className="plate-board-toolbar-divider" aria-hidden="true" />
      <button type="button" onClick={undo} disabled={!!disabled || !undoRef.current.length}>撤销</button>
      <button type="button" onClick={redo} disabled={!!disabled || !redoRef.current.length}>重做</button>
      <span className="plate-board-toolbar-divider" aria-hidden="true" />
      <button type="button" onClick={() => zoomAround(1 / ZOOM.step, (viewportRef.current?.getBoundingClientRect().left ?? 0) + (viewportRef.current?.getBoundingClientRect().width ?? 800) / 2, (viewportRef.current?.getBoundingClientRect().top ?? 0) + (viewportRef.current?.getBoundingClientRect().height ?? 600) / 2)} disabled={!!disabled}>缩小</button>
      <button type="button" onClick={() => zoomAround(ZOOM.step, (viewportRef.current?.getBoundingClientRect().left ?? 0) + (viewportRef.current?.getBoundingClientRect().width ?? 800) / 2, (viewportRef.current?.getBoundingClientRect().top ?? 0) + (viewportRef.current?.getBoundingClientRect().height ?? 600) / 2)} disabled={!!disabled}>放大</button>
      <button type="button" onClick={() => saveViewport({ x: view.x, y: view.y, zoom: 1 })} disabled={!!disabled}>100%</button>
      <button type="button" onClick={fit} disabled={!!disabled}>适应</button>
      <span className="plate-board-toolbar-divider" aria-hidden="true" />
      <button type="button" onClick={sendSelection} disabled={!!disabled || selected.size === 0}>发给…</button>
      <span className="plate-board-status" role="status" data-saving={saving || undefined}>
        {status || (saving ? '保存中…' : selected.size ? `已选 ${selected.size} 张卡片` : '已保存')}
      </span>
    </div>
    <div ref={surfaceRef} className="plate-board-surface" data-connecting={connecting !== null ? 'true' : undefined}
      onKeyDown={onKeyDown} tabIndex={0} role="application"
      aria-label={`画板画布 · ${note.title}。Tab 循环选择卡片，方向键微调，Delete 删除，Ctrl+Z 撤销。`}
      onPointerDown={onViewportPointerDown} onPointerMove={event => {
        onSurfacePointerMove(event)
        onResizePointerMove(event)
      }} onPointerUp={event => {
        onSurfacePointerUp(event)
        onResizePointerUp(event)
      }}>
      <div ref={viewportRef} className="plate-board-canvas">
        <div className="plate-board-plane" style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
        }}>
          <svg className="plate-board-links">
            {connectionPath.map(({ connection, x1, y1, x2, y2 }) => <line key={connection.id}
              x1={x1} y1={y1} x2={x2} y2={y2} className="plate-board-link"
              data-selected={selectedConnections.has(connection.id) || undefined}
              onPointerDown={event => {
                if (disabledRef.current || event.button !== 0) return
                event.stopPropagation()
                setSelectedConnections(new Set(event.shiftKey && selectedConnections.has(connection.id)
                  ? [...selectedConnections].filter(id => id !== connection.id)
                  : [connection.id]))
                if (!event.shiftKey) setSelected(new Set())
              }}/>)}
          </svg>
          {doc.cards.map(card => {
            const state = cardState(card)
            const isSelected = selected.has(card.id)
            return <div key={card.id} className={`plate-board-card plate-board-card-${card.kind}`}
              data-state={state === 'ok' ? undefined : state} data-selected={isSelected || undefined}
              data-connecting-from={connecting === card.id || undefined}
              style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
              onPointerDown={event => onCardPointerDown(card.id, event)}
              onDoubleClick={event => {
                if (card.kind === 'sticky' && !disabledRef.current) { setEditing(card.id); event.stopPropagation() }
              }}>
              {card.kind === 'sticky' ? <>
                <div className="plate-board-card-head"><span>便签</span>
                  <span className="plate-board-card-version">v{card.version}</span></div>
                {editing === card.id
                  ? <textarea className="plate-board-sticky-input" autoFocus defaultValue={card.text}
                    aria-label="便签内容" onBlur={event => commitStickyText(card.id, event.currentTarget.value)}
                    onKeyDown={event => {
                      if (event.key === 'Escape') { event.currentTarget.value = card.text; setEditing(null) }
                      event.stopPropagation()
                    }}/>
                  : <p className="plate-board-sticky-text">{card.text || '双击编辑便签'}</p>}
              </> : <>
                <div className="plate-board-card-head"><span title={card.noteTitle}>{card.noteTitle}</span>
                  <span className="plate-board-card-version">第 {card.lineFrom}–{card.lineTo} 行</span></div>
                {state === 'gone'
                  ? <p className="plate-board-ref-placeholder">来源笔记已删除</p>
                  : <p className="plate-board-sticky-text">{card.snapshotText}</p>}
                <div className="plate-board-ref-actions">
                  {state === 'stale' && <button type="button" disabled={!!disabled}
                    onClick={event => { event.stopPropagation(); refreshRef(card.id) }}>刷新快照</button>}
                  {state !== 'gone' && <button type="button" disabled={!!disabled}
                    onClick={event => { event.stopPropagation(); onOpenNote(card.noteId) }}>打开来源</button>}
                </div>
              </>}
              <div className="plate-board-resize" aria-hidden="true"
                onPointerDown={event => onResizePointerDown(card.id, event)} />
            </div>
          })}
          {marquee && <div className="plate-board-marquee" aria-hidden="true" style={{
            left: Math.min(marquee.x1, marquee.x2), top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1), height: Math.abs(marquee.y2 - marquee.y1)
          }} />}
        </div>
      </div>
      {disabled && <div className="plate-board-disabled" role="status">{disabled}</div>}
    </div>
    <p className="plate-board-hint">拖动空白平移；Shift+拖动框选；Ctrl+滚轮缩放；双击便签编辑；Delete 删除所选。</p>
  </section>
}
