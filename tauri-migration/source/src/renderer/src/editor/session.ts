import { normalize, project, type Box, type Leaf, type Node, type Projection, type Span } from './projection'
import { scanDelegation } from '../../../shared/delegation-markdown'
import { scanWiki } from '../../../shared/wiki-markdown'
import { bitmapPath, webAddress } from '../../../shared/media-address'

export type Selection = { anchor: number; head: number }
export type Bookmark = Readonly<Selection & { noteId: string; baseRevision: string; draftEpoch: number
  version: number; direction: 'forward' | 'backward'; scroll: { x: number; y: number }; expires: number; session: symbol }>
export type Edit = Span & { insert: string }
export type Mode = 'render' | 'source'
type State = { raw: string; selection: Selection }
type Entry = { before: State; after: State; key?: string; time: number }
type SaveTicket = Readonly<{ noteId: string; baseRevision: string; draftEpoch: number; raw: string; version: number; token: symbol }>
type Lock = { mark: Bookmark; ending: boolean }
export type Unit = { box: Box; parents: Box[] }
const unitRoles = new Set(['paragraph', 'heading', 'task', 'th', 'td', 'code'])
const tableCell = (b: Box) => b.role === 'th' || b.role === 'td'
const range = (s: Selection): Span => ({ from: Math.min(s.anchor, s.head), to: Math.max(s.anchor, s.head) })
const intersects = (a: Span, b: Span) => a.from < b.to && a.to > b.from
const inSpan = (s: Span, x: number) => x >= s.from && x <= s.to
export const visible = (n: Node): string => n.kind === 'text' ? n.text : n.hidden ? '' : n.label && n.kind === 'atom' ? n.label : n.children.map(visible).join('')
export function* boxes(n: Node): Generator<Box> {
  if (n.kind === 'text') return
  yield n
  for (const c of n.children) yield* boxes(c)
}
export function* leaves(n: Node, parents: Box[] = []): Generator<{ leaf: Leaf; parents: Box[] }> {
  if (n.kind === 'text') yield { leaf: n, parents }
  else for (const c of n.children) yield* leaves(c, [...parents, n])
}
function* units(n: Node, parents: Box[] = []): Generator<Unit> {
  if (n.kind === 'text') return
  if (unitRoles.has(n.role)) yield { box: n, parents }
  else for (const child of n.children) yield* units(child, [...parents, n])
}
function shape(n: Node): string {
  if (n.kind === 'text' || n.role === 'prefix') return ''
  if (n.kind !== 'box') return JSON.stringify([n.kind, n.role, n.label ?? ''])
  return JSON.stringify([n.role, n.attrs?.level ?? 0, n.children.map(shape).filter(Boolean)])
}
function displayIndex(n: Box, point: number) {
  let offset = 0
  function visit(node: Node): number | undefined {
    if (node.kind === 'text') {
      if (point <= node.from) return offset
      if (point <= node.to) {
        const p = node.points.indexOf(point)
        if (p < 0) throw new EditError('选区切开了转义或字符，请重新选择')
        return offset + p
      }
      offset += node.text.length
    } else if (!node.hidden) {
      if (node.kind !== 'box') {
        if (point <= node.from) return offset
        if (point < node.to) throw new EditError('选区进入不可拆分的内容')
        offset += visible(node).length
      } else {
        for (const child of node.children) {
          const p = visit(child)
          if (p !== undefined) return p
        }
      }
    }
    return undefined
  }
  return visit(n) ?? offset
}
export class EditError extends Error {}
const deny = (message: string): never => { throw new EditError(message) }
const validString = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\0/.test(s)
const proseEscape = (s: string, table: boolean) => s.replace(/[\\\x60*_{}\[\]<>!~&#|:@+\-.$%=^]/g, c =>
  table && c === '|' ? '\\|' : table && c === '\\' ? '&#92;' : '\\' + c)
export const encodeCell = (s: string) => s.replace(/[^\r\n]+|\r\n?|\n/g, p =>
  /[\r\n]/.test(p) ? '<br>' : proseEscape(p, true).replaceAll(' ', '&#32;').replaceAll('\t', '&#9;'))
const encodeInline = (s: string, table: boolean, newline: string) =>
  table ? encodeCell(s) : proseEscape(s, false).replace(/\r\n?|\n/g, '\\' + newline)
const modPoint = (point: number, edits: Edit[], assoc: -1 | 1) => {
  let delta = 0
  for (const e of edits) {
    if (point < e.from || (point === e.from && assoc < 0)) break
    if (point < e.to || (point === e.from && e.from === e.to)) return e.from + delta + (assoc < 0 ? 0 : e.insert.length)
    delta += e.insert.length - (e.to - e.from)
  }
  return point + delta
}
const diff = (before: string, after: string): Edit => {
  let from = 0, a = before.length, b = after.length
  while (from < a && from < b && before[from] === after[from]) from++
  while (a > from && b > from && before[a - 1] === after[b - 1]) { a--; b-- }
  const low = (s: string, i: number) => /[\uDC00-\uDFFF]/.test(s[i] ?? '')
  if (low(before, from) || low(after, from)) from--
  if (low(before, a) || low(after, b)) { a++; b++ }
  return { from, to: a, insert: after.slice(from, b) }
}
export function safeLink(input: string): string {
  try { return webAddress(input) } catch (error) { return deny((error as Error).message) }
}
const markdownURL = (value: string) => value.replace(/[() <>"]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
export function imagePath(input: string) {
  if (/^https?:/i.test(input)) return { kind: 'remote' as const, target: safeLink(input) }
  try { return { kind: 'local' as const, target: bitmapPath(input) } } catch (error) { return deny((error as Error).message) }
}
function quoteTitle(title?: string) {
  if (!title) return ''
  if (/[\r\n\0]/.test(title)) return deny('标题需为一行')
  return ' "' + title.replace(/[\\"]/g, '\\$&') + '"'
}
function bounds(n: Box, p: Span) {
  return n.content && inSpan(n.content, p.from) && inSpan(n.content, p.to)
}
function formatCoverage(unit: Box) {
  return [...leaves(unit)].flatMap(({ leaf, parents }) => Array.from({ length: leaf.text.length }, (_, index) => ({
    from: leaf.points[index], to: leaf.points[index + 1], text: leaf.text[index],
    roles: parents.filter(n => ['strong','em','s','link'].includes(n.role)).map(n => n.role).sort()
  })))
}

import { plateTitle, plateTitleLine } from '../../../shared/plate-title'

export class EditorSession {
  readonly identity = Symbol('EditorSession')
  private saved: string
  private state: State
  private past: Entry[] = []
  private future: Entry[] = []
  private ticket?: SaveTicket
  private composition?: Lock
  private paused = false
  private readonly clock: () => number
  private rawFailure = false
  private typingGroup = 0
  private pending: { style: 'strong' | 'em'; point: number }[] = []
  private pendingBlock?: { block: number | 'list' | 'ordered' | 'task' | 'quote'; point: number }
  private checkingTool = false
  private toolCache?: { key: string; reasons: Map<string,string> }
  private _baseRevision: string
  private _projection: Projection
  private _draftEpoch = 0
  private _version = 0
  private _mode: Mode = 'render'
  scroll = { x: 0, y: 0 }

  constructor(readonly noteId: string, revision: string, raw: string, clock = () => performance.now(), recovered = raw) {
    if (!validString(raw)) deny('笔记不是可编辑的 UTF-8 文本')
    this._baseRevision = revision
    this.saved = raw
    this.clock = clock
    if (!validString(recovered)) deny('草稿不是可编辑的 UTF-8 文本')
    this._projection = project(recovered)
    const first = [...leaves(this._projection.root)][0]?.leaf.from ?? recovered.length
    this.state = { raw: recovered, selection: { anchor: first, head: first } }
  }
  get raw() { return this.state.raw }
  changeTitle(value: string) {
    this.writable()
    if (value.length > 240 || /[\r\n\u0000]/.test(value)) return deny('标题必须是一行且最多 240 个字符')
    const title = plateTitle(this.raw)
    const start = this.raw.startsWith('\uFEFF') ? 1 : 0
    return this.one({ from: start, to: title?.end ?? start, insert: plateTitleLine(value, this.projection.newline) },
      this.selection, { guard: 'raw' })
  }
  appendTask() {
    const at = this.raw.length
    const eol = this.projection.newline
    const line = '- [ ] 新任务'
    const prefix = !at || this.raw.endsWith(eol + eol) ? '' : this.raw.endsWith(eol) ? eol : eol + eol
    return this.one({ from: at, to: at, insert: prefix + line + eol }, this.selection, { guard: 'raw',
      after: { anchor: at + prefix.length + 6, head: at + prefix.length + line.length } })
  }
  get selection() { return { ...this.state.selection } }
  get projection() { return this._projection }
  get baseRevision() { return this._baseRevision }
  get draftEpoch() { return this._draftEpoch }
  get version() { return this._version }
  get mode() { return this._mode }
  get dirty() { return this.raw !== this.saved }
  get composing() { return Boolean(this.composition) }
  get locked() { return this.composing || this.paused || Boolean(this.ticket) }
  get history() { return { undo: this.past.length, redo: this.future.length } }
  get mayRequireLeave() { return this.dirty || this.locked }
  get sourceError() { return this.rawFailure ? this.projection.errors.join('\n') : '' }
  get headingLevel() {
    return typeof this.pendingBlock?.block === 'number' ? this.pendingBlock.block : this.getUnit(this.selection.head)?.box.attrs?.level ?? 0
  }
  selectedText(mark: Bookmark) {
    const { from, to } = range(this.resolve(mark))
    const unit = this.getUnit(from)
    if (!unit || unit.box !== this.getUnit(to)?.box) return ''
    return visible(unit.box).slice(displayIndex(unit.box, from), displayIndex(unit.box, to))
  }
  toolReason(tool:string, mark:Bookmark, level=1) {
    try { this.writable(); this.resolve(mark) }
    catch (error) {
      if (error instanceof EditError) return error.message
      throw error
    }
    if (tool==='undo' || tool==='redo') return this.history[tool] ? '' : tool==='undo'?'没有可撤销的操作':'没有可重做的操作'
    if (tool==='more') return ''
    const key=JSON.stringify([mark.version,mark.anchor,mark.head])
    if (this.toolCache?.key!==key) this.toolCache={key,reasons:new Map()}
    const cache=this.toolCache.reasons, command=tool==='heading'?tool+level:tool
    if (cache.has(command)) return cache.get(command)!
    const pending=this.pending, block=this.pendingBlock
    this.checkingTool=true
    let reason=''
    try {
      const s=range(this.resolve(mark))
      const unit=this.getUnit(s.to)
      const enclosing=(role:string)=>[...boxes(this.projection.root)].find(n=>n.role===role && inSpan(n,s.from) && inSpan(n,s.to))
      if (tool==='strong' || tool==='em') this.format(tool,mark)
      else if (tool==='heading') this.heading(level,mark)
      else if (tool==='link') {
        const target=enclosing('link')
        if (!unit || unit.box!==this.getUnit(s.from)?.box || unit.box.role==='code') deny('链接仅支持单段文字')
        const span=target?.content ?? s
        this.guarded(span)
        if (/[\r\n]/.test(this.raw.slice(span.from,span.to))) deny('链接文字必须是单行')
      } else if (tool==='image') {
        this.image({target:enclosing('image'),address:'probe.png',alt:'图片'},mark)
      } else if (tool==='table') {
        if (unit && tableCell(unit.box)) deny('已有表格中不能再插入表格')
        this.boundary(mark)
      } else if (tool==='code') {
        if (!enclosing('code')) this.changeBlock('code',mark)
      } else if (tool==='list' || tool==='ordered' || tool==='task' || tool==='quote') this.changeBlock(tool,mark)
    } catch (error) {
      if (!(error instanceof EditError)) throw error
      reason=error.message
    } finally {
      this.checkingTool=false
      this.pending=pending
      this.pendingBlock=block
    }
    cache.set(command,reason)
    return reason
  }
  formatState(style: 'strong' | 'em'): boolean | 'mixed' {
    const { from, to } = range(this.selection)
    if (from === to) return this.pending.some(p => p.style === style && p.point === from) ||
      [...boxes(this.projection.root)].some(n => n.role === style && bounds(n, { from, to }))
    const states = [...leaves(this.projection.root)].filter(({ leaf }) => /\S/.test(leaf.text) && intersects(leaf, {from, to}))
      .map(({ parents }) => parents.some(n => n.role === style))
    return states.some(Boolean) && (states.every(Boolean) || 'mixed')
  }
  activeTable() {
    const unit = this.getUnit(this.selection.head)
    if (!unit || !tableCell(unit.box)) return undefined
    const table = unit.parents.find(node => node.role === 'table')
    const row = unit.parents.find(node => node.role === 'tr')
    if (!table || !row) return undefined
    return { table, row: table.children.indexOf(row), column: row.children.indexOf(unit.box), columns: row.children.length }
  }
  selectTableCell(table: Box, row: number, column: number) {
    this.ensureTarget(table,'table')
    const cell = (table.children[row] as Box | undefined)?.children[column] as Box | undefined
    if (!cell?.content) return deny('找不到该表格单元格')
    const point = cell.content.from
    this.select({anchor:point,head:point})
  }

  select(selection: Selection) {
    if (this.composing || this.paused) return
    for (const point of [selection.anchor, selection.head])
      if (!this.projection.rawPoints.includes(point) || /[\uDC00-\uDFFF]/.test(this.raw[point] ?? '')) deny('选区切开了字符或行尾')
    if (selection.anchor !== this.selection.anchor || selection.head !== this.selection.head) {
      this.pending = []
      this.pendingBlock = undefined
      this.typingGroup++
    }
    this.state = { ...this.state, selection: { ...selection } }
  }
  mark(ttl = 30_000): Bookmark {
    return { ...this.selection, noteId: this.noteId, baseRevision: this.baseRevision, draftEpoch: this.draftEpoch,
      version: this.version, direction: this.selection.anchor <= this.selection.head ? 'forward' : 'backward',
      scroll: { ...this.scroll }, expires: this.clock() + ttl, session: this.identity }
  }
  resolve(mark: Bookmark): Selection {
    if (mark.session !== this.identity || mark.noteId !== this.noteId || mark.baseRevision !== this.baseRevision ||
        mark.draftEpoch !== this.draftEpoch || mark.version !== this.version || mark.expires <= this.clock())
      return deny('选区已变化或超时，请重新选择')
    return { anchor: mark.anchor, head: mark.head }
  }
  cancel(mark: Bookmark) {
    this.writable()
    this.select(this.resolve(mark))
    this.scroll = { ...mark.scroll }
  }
  clearPending() { this.writable(); this.pending = []; this.pendingBlock = undefined }
  private writable() {
    if (this.composing) deny('请先完成中文输入')
    if (this.locked) deny('编辑会话已暂停或正在保存')
  }
  private line(point: number) { return this.projection.lines.filter(x => x <= point).length }
  private newline(point: number) {
    const end = this.projection.lines[this.line(point)]
    return end === undefined ? this.projection.newline : this.raw.slice(0, end).match(/(?:\r\n|\r|\n)$/)?.[0] ?? this.projection.newline
  }
  private getUnit(point: number) {
    return [...units(this.projection.root)].find(u => inSpan(u.box.content ?? u.box, point))
  }
  private ensureTarget(target: Box, role?: string) {
    if (![...boxes(this.projection.root)].includes(target) || (role && target.role !== role)) deny('该内容已变化，请重新选择')
  }
  private guarded(s: Span, allowFormatEdge?: 'strong' | 'em' | 'structure') {
    for (const { leaf } of leaves(this.projection.root)) {
      for (const p of [s.from, s.to]) if (leaf.from < p && p < leaf.to && !leaf.points.includes(p))
        deny('选区切开了转义或字符')
    }
    for (const n of boxes(this.projection.root)) {
      if (n.kind === 'protected' || n.kind === 'atom') {
        if (intersects(n, s) || (s.from === s.to && n.from < s.from && s.from < n.to))
          deny('该选区经过受保护或不可拆分的内容')
      }
      if (n.kind === 'box' && n.content && ['strong', 'em', 's', 'link', 'inline-code'].includes(n.role) &&
          intersects(n, s) && !bounds(n, s) && !(s.from <= n.from && s.to >= n.to) &&
          n.role !== allowFormatEdge && allowFormatEdge !== 'structure')
        deny('该选区切开了行内 Markdown 标记')
    }
  }
  private apply(edits: Edit[], selection: Selection, options: {
    after?: Selection; guard?: 'raw'; allow?: Box; validate?: (next: Projection, raw: string) => boolean; group?: string
  } = {}) {
    this.writable()
    const ordered = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
    let at = 0, raw = ''
    for (const e of ordered) {
      if (e.from < at || e.to < e.from || !this.projection.rawPoints.includes(e.from) ||
          !this.projection.rawPoints.includes(e.to) || !validString(e.insert)) deny('无效的原文事务')
      raw += this.raw.slice(at, e.from) + e.insert
      at = e.to
    }
    raw += this.raw.slice(at)
    if (!validString(raw)) deny('事务切开了 Unicode 字符')
    if (raw === this.raw) return false
    const next = project(raw)
    if (options.guard !== 'raw') {
      const seen = new Set<Box>()
      for (const p of this.projection.protected) {
        if (p === options.allow) continue
        if (ordered.some(e => intersects(e, p))) deny('事务触及受保护原文')
        const from = modPoint(p.from, ordered, 1)
        const to = from + p.to - p.from
        const retained = next.protected.find(n => n.from === from && n.to === to && n.role === p.role)
        if (!retained || raw.slice(from, to) !== this.raw.slice(p.from, p.to)) deny('事务改变了受保护内容的解析边界')
        seen.add(retained!)
      }
      if (!options.allow && next.protected.some(n => !seen.has(n))) deny('事务产生了无法映射的 Markdown')
      if (next.errors.length > this.projection.errors.length) deny(next.errors.join('\n'))
      for (const root of this.projection.root.children) {
        if (root.kind !== 'box' || root.from === root.to ||
            ordered.some(e => e.from <= root.to && e.to >= root.from)) continue
        const from = modPoint(root.from, ordered, 1), to = from + root.to - root.from
        const retained = next.root.children.find(n => n.kind === 'box' && n.from === from && n.to === to)
        if (!retained || shape(retained) !== shape(root) || visible(retained) !== visible(root))
          deny('事务改变了未触碰段落的解析边界')
      }
    }
    if (options.validate && !options.validate(next, raw)) deny('无法无损映射此操作，请用原文辅助')
    const map = (p: number) => modPoint(p, ordered, 1)
    const after = { raw, selection: options.after ?? { anchor: map(selection.anchor), head: map(selection.head) } }
    if ([after.selection.anchor, after.selection.head].some(p => !next.rawPoints.includes(p) || /[\uDC00-\uDFFF]/.test(raw[p] ?? '')))
      deny('事务后的选区切开了字符或行尾')
    if (this.checkingTool) return true
    const entry: Entry = { before: { raw: this.raw, selection }, after, time: this.clock(), key: options.group }
    const last = this.past.at(-1)
    if (options.group && last?.key === options.group && entry.time - last.time < 650 &&
        last.after.selection.head === selection.head && selection.anchor === selection.head && !this.future.length) {
      this.past[this.past.length - 1] = { ...entry, before: last.before }
    } else this.past.push(entry)
    this.future = []
    this.state = after
    this._projection = next
    this._version++
    this._draftEpoch++
    return true
  }
  private one(e: Edit, selection: Selection, options?: Parameters<EditorSession['apply']>[2]) {
    return this.apply([e], selection, options)
  }
  private structureKey(unit: Unit, selection: Selection) {
    const point = selection.head
    if (selection.anchor !== point) return deny('结构键需要单一光标')
    const item = unit.parents.filter(n => n.role === 'li').at(-1)
    const quote = unit.parents.filter(n => n.role === 'quote').at(-1)
    const nl = this.newline(point)
    if (item) {
      if (item.children.length !== 1 || !item.marker || /[\r\n]/.test(this.raw.slice(item.from, item.to)))
        return deny('多行或含子树的项不能用此键分割')
      const indent = this.raw.slice(this.projection.lines[this.line(item.from) - 1], item.from).replace(/^\uFEFF/, '')
      if (!/^ *$/.test(indent)) return deny('无法映射列表缩进')
      const marker = this.raw.slice(item.marker.from, item.marker.to)
      const nextMarker = /^\d/.test(marker) ? (Number(marker.slice(0, -1)) + 1) + marker.at(-1)! : marker
      const prefix = indent + nextMarker + ' ' + (unit.box.role === 'task' ? '[ ] ' : '')
      if (!visible(unit.box)) {
        const list = unit.parents.filter(n => n.role === 'ul' || n.role === 'ol').at(-1)!
        if (list.children.at(-1) !== item) return deny('只能退出列表末尾空项')
        const chain = unit.parents.filter(n => n.role === 'li')
        const parent = chain.at(-2)
        if (parent?.marker) {
          const parentStart = this.projection.lines[this.line(parent.from) - 1]
          const parentIndent = this.raw.slice(parentStart, parent.from).replace(/^\uFEFF/, '')
          if (!/^ *$/.test(parentIndent)) return deny('无法定位上一级列表的标记')
          const parentMarker = this.raw.slice(parent.marker.from, parent.marker.to)
          const siblingMarker = /^\d/.test(parentMarker) ? (Number(parentMarker.slice(0, -1)) + 1) + parentMarker.at(-1)! : parentMarker
          const from = item.from - indent.length
          const insert = parentIndent + siblingMarker + ' '
          const caret = from + insert.length
          return this.one({ from, to: item.to, insert }, selection, { after: { anchor: caret, head: caret }, validate: next =>
            [...units(next.root)].some(u => u.box.content?.from === caret && u.parents.filter(n => n.role === 'li').length === chain.length - 1) })
        }
        if (indent) return deny('无法定位根级列表缩进')
        const caret = item.from + nl.length * 2
        return this.one({ from: item.from, to: item.to, insert: nl.repeat(2) }, selection,
          { after: { anchor: caret, head: caret } })
      }
      const unitSpan = unit.box.content!
      const breakInside = [...boxes(unit.box)].some(n => n !== unit.box && n.from < point && point < n.to)
      if (breakInside || point === unitSpan.from) return deny('分项不能切开行内标记或项目开头')
      const insert = nl + prefix
      const caret = point + insert.length
      return this.one({ from: point, to: point, insert }, selection, {
        after: { anchor: caret, head: caret }, validate: next => [...units(next.root)].some(u =>
          u.box.content?.from === caret && u.parents.some(n => n.role === 'li'))
      })
    }
    if (quote) {
      const chain = unit.parents.filter(n => n.role === 'quote')
      if (!visible(unit.box)) {
        const from = this.projection.lines[this.line(point) - 1]
        const prefix = this.raw.slice(from, point).replace(/^\uFEFF/, '')
        if (!/^(?:[ \t]*>[ \t]*)+$/.test(prefix)) return deny('无法定位引用层级')
        const caret = this.raw.lastIndexOf('>', point - 1)
        const insert = chain.length === 1 && from > 0 && this.projection.lines.length === this.line(point) ? nl : ''
        const nextCaret = caret + insert.length
        return this.one({ from: caret, to: point, insert }, selection, { after: { anchor: nextCaret, head: nextCaret }, validate: next =>
          [...units(next.root)].some(u => u.box.content?.from === nextCaret && u.parents.filter(n => n.role === 'quote').length === chain.length - 1) })
      }
      if ([...boxes(unit.box)].some(n => n !== unit.box && n.from < point && point < n.to)) return deny('分行会切开行内标记')
      const insert = nl + '> '.repeat(chain.length)
      const caret = point + insert.length
      return this.one({ from: point, to: point, insert }, selection, {
        after: { anchor: caret, head: caret }, validate: next => [...boxes(next.root)].some(n => n.role === 'quote' && n.from === quote.from)
      })
    }
    return deny('此处没有安全的段落分隔')
  }
  private textAt(text: string, selection: Selection, kind = 'text', group = false) {
    const s = range(selection)
    this.guarded(s)
    const left = this.getUnit(s.from), right = this.getUnit(s.to)
    if (!left || !right) return deny('选区没有可编辑的原文映射')
    const normalized = text.replace(/\r\n?/g, '\n')
    const newline = this.newline(s.from)
    const code = left.box.role === 'code'
    const cell = tableCell(left.box)
    const before = visible(left.box).slice(0, displayIndex(left.box, s.from))
    const after = visible(right.box).slice(displayIndex(right.box, s.to))
    const rootUnit = (u: Unit) => u.parents.length === 1 && u.parents[0].role === 'document'
    const plain = (u: Unit) => u.box.children.every(n => n.kind === 'text')
    const split = kind === 'paragraph' && !cell && !code
    if (split && left.box === right.box && rootUnit(left) && !before && !after &&
        left.box.role === 'paragraph' && left.box.from === left.box.to &&
        typeof this.pendingBlock?.block === 'number' && this.pendingBlock.point === s.from) {
      this.pendingBlock = undefined
      return false
    }
    if (left.box === right.box && split && !rootUnit(left)) return this.structureKey(left, selection)
    if (left.box !== right.box || split) {
      const selected = this.projection.root.children.filter(b => intersects(b, s))
      if (!rootUnit(left) || !rootUnit(right) || (!split && (left.box.role !== 'paragraph' || right.box.role !== 'paragraph')) ||
          !selected.every(b => b.kind === 'box' && ['heading', 'paragraph'].includes(b.role)) ||
          (left.box !== right.box && selected.some(b => b.kind === 'box' && b.role !== 'paragraph')))
        deny('不能用一次文本编辑跨越这些结构')
      if (left.box !== right.box && (!plain(left) || !plain(right))) deny('跨段文本替换不能切开格式')
      let edit = { ...s, insert: split ? newline.repeat(2) : encodeInline(normalized, false, newline) }
      if (split) {
        const box = left.box
        const atEnd = left.box === right.box && !after
        if (atEnd && s.from === s.to && before && (s.to === box.content?.to ||
            [...boxes(box)].some(n => n !== box && n.content?.to === s.to && n.to === box.content?.to)))
          edit = { ...edit, from: box.to, to: box.to }
        if (box.role === 'heading' && box.to !== box.content?.to && edit.from !== box.to)
          return deny('含尾部标记的标题请用原文辅助拆段')
        if (left.box === right.box && box.role === 'heading' && !before && !visible(box)) {
          const lineStart = this.projection.lines[this.line(box.from) - 1]
          const prior = this.projection.normalized.slice(0, this.projection.rawPoints.indexOf(lineStart))
          const atStart = lineStart <= Number(this.raw.startsWith('\uFEFF'))
          const removeFrom = atStart ? Number(this.raw.startsWith('\uFEFF')) : lineStart
          const insert = atStart ? newline.repeat(2) :
            /\n[ \t]*\n$/.test(prior) ? '' : newline
          edit = { from: removeFrom, to: box.to, insert }
        } else if ([...boxes(box)].some(n => n !== box &&
          [edit.from, edit.to].some(p => n.from < p && p < n.to))) {
          return deny('分段会切开行内标记，请在格式边界分段或用原文辅助')
        }
      }
      const caret = edit.from + edit.insert.length
      return this.one(edit, selection, { after: { anchor: caret, head: caret }, validate: next => {
        const children = next.root.children
        if (split) {
          const a = children.find(n => n.kind === 'box' && n.role === left.box.role &&
            n.from === left.box.from && visible(n) === before)
          const b = children.find(n => n.kind === 'box' && n.role === 'paragraph' && n.from === caret && visible(n) === after)
          return Boolean((a || !before) && b)
        }
        return children.some(n => n.from === left.box.from && visible(n) === before + normalized + after)
      } })
    }
    const codeInline = [...boxes(left.box)].find(n => n.role === 'inline-code' && bounds(n, s))
    if (codeInline && /[\r\n\x60]/.test(normalized)) return deny('代码跨度不接受换行或围栏字符，请用局部原文')
    let insert = code || codeInline ? (cell ? normalized.replaceAll('|', '\\|') : normalized.replaceAll('\n', newline))
      : encodeInline(normalized, cell, newline)
    if (code) {
      const body = this.raw.slice(left.box.content!.from, s.from) + insert + this.raw.slice(s.to, left.box.content!.to)
      const open = /^(\x60{3,}|~{3,})/.exec(this.raw.slice(left.box.from))?.[0]
      if (open && body.split(/\r\n|\n|\r/).some(line => new RegExp('^ {0,3}' + open[0] + '{' + open.length + ',}[ \\t]*$').test(line))) {
        const max = Math.max(open.length, ...(body.match(open[0] === '\x60' ? /\x60+/g : /~+/g) ?? []).map(m => m.length + 1))
        const fence = open[0].repeat(max)
        const value = fence + (left.box.label ?? '') + newline + body + newline + fence
        const caret = left.box.from + fence.length + (left.box.label?.length ?? 0) + newline.length + s.from - left.box.content!.from + insert.length
        return this.one({ from: left.box.from, to: left.box.to, insert: value }, selection, { after: { anchor: caret, head: caret },
          validate: next => [...boxes(next.root)].some(n => n.role === 'code' && n.from === left.box.from && visible(n) === body.replace(/\r\n?/g, '\n')) })
      }
    }
    const active = !code && !cell && s.from === s.to ? this.pending.filter(p => p.point === s.from) : []
    let closing = 0
    if (active.length && insert && !/^\s|\s$/.test(normalized)) {
      const mark = '*'.repeat(active.reduce((n, p) => n + (p.style === 'strong' ? 2 : 1), 0))
      insert = mark + insert + mark
      closing = mark.length
    }
    let prefix = ''
    if (left.box.from === left.box.to && left.box.from === this.raw.length && this.raw.slice(this.raw.startsWith('\uFEFF') ? 1 : 0).trim() &&
        !/\n[ \t]*\n$/.test(this.projection.normalized))
      prefix = newline + newline
    const pendingBlock = this.pendingBlock?.point === s.from && s.from === s.to && /\S/.test(normalized)
      ? this.pendingBlock.block : undefined
    const blockPrefix = typeof pendingBlock === 'number' ? '#'.repeat(pendingBlock) + ' '
      : pendingBlock ? { list: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ' }[pendingBlock] : ''
    // A blank position immediately above another block may have just one
    // following EOL. Keep that block separate once this position has text.
    const rest = this.raw.slice(s.to)
    const suffix = insert && left.box.from === left.box.to && rest.startsWith(newline) &&
      /^[ \t]*\S/.test(rest.slice(newline.length)) ? newline : ''
    const caret = s.from + prefix.length + blockPrefix.length + insert.length - closing
    const expected = before + normalized + after
    const start = left.box.from
    const changed = this.one({ ...s, insert: prefix + blockPrefix + insert + suffix }, selection, { after: { anchor: caret, head: caret },
      group: group && !active.length ? 'input:' + this.typingGroup + ':' + start : undefined,
      validate: next => {
        const from = start + prefix.length
        const nextUnit = [...units(next.root)].find(u => {
          if (typeof pendingBlock === 'number') return u.box.from === from && u.box.role === 'heading' && u.box.attrs?.level === pendingBlock
          if (!pendingBlock) return u.box.from === from && u.box.role === left.box.role
          const role = { list: 'ul', ordered: 'ol', task: 'ul', quote: 'quote' }[pendingBlock]
          return u.parents.some(p => p.role === role && p.from === from) && (pendingBlock === 'task' ? u.box.role === 'task' : u.box.role === 'paragraph')
        })
        if (!expected && !nextUnit && rootUnit(left) && left.box.role === 'paragraph') return true
        return Boolean(nextUnit && visible(nextUnit.box) === expected && (active.length ?
          active.every(p => [...boxes(nextUnit.box)].some(n => n.role === p.style && bounds(n, { from: caret - insert.length + closing * 2, to: caret }))) :
          pendingBlock !== undefined || shape(nextUnit.box) === shape(left.box)))
      } })
    if (changed) { this.pending = []; this.pendingBlock = undefined }
    return changed
  }
  type(text: string, mark = this.mark(), kind: 'text' | 'paragraph' | 'hard' = 'text', group = true) {
    if (this.mode !== 'render') deny('当前为原文模式')
    return this.textAt(text, this.resolve(mark), kind, group && kind === 'text')
  }
  erase(backward: boolean, mark = this.mark()) {
    const s = this.resolve(mark)
    if (s.anchor !== s.head) return this.textAt('', s)
    const u = this.getUnit(s.head)
    if (!u) return deny('此处没有可删除的文字')
    if (backward && u.box.role === 'heading' && s.head === u.box.content?.from) return this.heading(0, mark)
    if (backward && !visible(u.box) && u.parents.some(n => n.role === 'li' || n.role === 'quote')) return this.structureKey(u, s)
    if (backward && s.head === u.box.content?.from) {
      const listDepth = u.parents.filter(n => n.role === 'li').length
      const quoteDepth = u.parents.filter(n => n.role === 'quote').length
      if (listDepth > 1) return this.indentList(true, mark)
      if (listDepth === 1) return this.convertList('paragraph', u, u, s)
      if (quoteDepth === 1 && u.parents.slice(1).every(n => n.children.length === 1)) return this.changeBlock('paragraph', mark)
    }
    const points = [...new Set([...leaves(u.box)].flatMap(l => l.leaf.points))].sort((a, b) => a - b)
    const value = visible(u.box), index = displayIndex(u.box, s.head)
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(x => x.index).concat(value.length)
    const target = backward ? graphemes.filter(x => x < index).at(-1) : graphemes.find(x => x > index)
    if (target === undefined) return deny('该块边界需用明确的结构操作')
    const point = points.find(p => displayIndex(u.box, p) === target && (backward ? p < s.head : p > s.head))
    if (point === undefined) return deny('此字符没有可靠的原文边界')
    return this.textAt('', { anchor: s.head, head: point })
  }
  format(style: 'strong' | 'em', mark = this.mark()) {
    this.writable()
    const selection = this.resolve(mark), s = range(selection)
    this.guarded(s, style)
    const first = this.getUnit(s.from), last = this.getUnit(s.to)
    if (!first || !last) return deny('选区没有可编辑的原文映射')
    const selected = [...units(this.projection.root)].filter(u => intersects(u.box, s) || u.box === first.box || u.box === last.box)
    if (selected.some(u => u.box.role === 'code') || (first.box !== last.box && selected.some(u => tableCell(u.box))))
      return deny('代码或跨格选区不能加此格式')
    if (s.from === s.to) {
      if ([...boxes(first.box)].some(n => n.role === 'inline-code' && n.from < s.from && n.to > s.from))
        return deny('代码跨度不能加此格式')
      const exists = this.pending.some(p => p.style === style && p.point === s.from)
      this.pending = this.pending.filter(p => p.point === s.from && p.style !== style)
      if (!exists) this.pending.push({ style, point: s.from })
      return false
    }
    const enclosing = first.box === last.box && [...boxes(first.box)].find(n => n.role === style && bounds(n, s) &&
      /[\r\n]/.test(this.raw.slice(n.from, n.to)))
    if (enclosing) return this.removeAcrossLines(first.box, enclosing, selection)
    if (selected.some(({ box }) => [...boxes(box)].some(n => n.role === style && intersects(n,s) &&
      /[\r\n]/.test(this.raw.slice(n.from,n.to))))) return this.formatAcrossLines(style, selected, selection)
    const changes: Edit[] = []
    const marks = style === 'strong' ? '**' : '*'
    const fragments: { p: Span; unit: Unit; wrapper?: Box; wrappers: Box[]; full: boolean }[] = []
    for (const unit of selected) {
      const content = unit.box.content!
      const lo = Math.max(s.from, content.from), hi = Math.min(s.to, content.to)
      if (lo >= hi) continue
      const unitBoxes = [...boxes(unit.box)]
      const startLine = this.line(lo), endLine = this.line(hi)
      for (let line = startLine; line <= endLine; line++) {
        const from = Math.max(lo,this.projection.lines[line-1])
        const to = Math.min(hi,this.projection.lines[line] ?? hi)
        const prefixEnd = unitBoxes.filter(n => n.role === 'prefix' && n.from >= from && n.to <= to).at(-1)?.to ?? from
        const lineText = this.raw.slice(prefixEnd,to)
        const start = prefixEnd + (lineText.length - lineText.trimStart().length)
        const end = prefixEnd + lineText.trimEnd().length
        const p = {from:start,to:end}
        if (p.from >= p.to) continue
        if (unitBoxes.some(n => n.role === 'inline-code' && intersects(n, p))) deny('代码跨度不能加此格式')
        const wrappers = unitBoxes.filter(n => n.role === style && intersects(n, p))
        const wrap = wrappers.length === 1 ? wrappers[0] : undefined
        const full = !!(wrap?.content && p.from <= wrap.content.from && p.to >= wrap.content.to && p.from >= wrap.from && p.to <= wrap.to)
        if (wrappers.some(n => !n.content || this.raw.slice(n.from,n.content.from) !== marks || this.raw.slice(n.content.to,n.to) !== marks) && !full)
          deny('混合定界符不能安全合并，请用局部原文')
        if (!full && /^\s|\s$|[\r\n]/.test(this.raw.slice(p.from, p.to))) deny('格式范围不能含边界空白或未映射换行')
        if (wrappers.some(n => /[\r\n]/.test(this.raw.slice(n.from,n.to)))) deny('不能切开跨行的格式定界符')
        fragments.push({ p, unit, wrapper: wrap, wrappers, full })
      }
    }
    if (!fragments.length) return false
    const remove = fragments.every(x => x.full || x.wrapper && bounds(x.wrapper,x.p))
    for (const { p, wrapper, wrappers, full } of fragments) {
      if (remove && wrapper?.content) {
        if (p.from <= wrapper.content.from) changes.push({ from: wrapper.from, to: wrapper.content.from, insert: '' })
        else changes.push({ from: p.from, to: p.from, insert: marks })
        if (p.to >= wrapper.content.to) changes.push({ from: wrapper.content.to, to: wrapper.to, insert: '' })
        else changes.push({ from: p.to, to: p.to, insert: marks })
      } else if (!full) {
        if (!wrappers.length) {
          changes.push({ from: p.from, to: p.from, insert: marks }, { from: p.to, to: p.to, insert: marks })
          continue
        }
        const first = wrappers[0], last = wrappers.at(-1)!
        if (first === last && bounds(first,p)) return deny('局部去除现有格式需用原文辅助')
        if (wrappers.some((w,i) => i && w.from < wrappers[i-1].to)) return deny('嵌套同类格式不能安全合并')
        if (p.from < first.from) changes.push({from:p.from,to:p.from,insert:marks},
          {from:first.from,to:first.content!.from,insert:''})
        if (p.to > last.to) changes.push({from:last.content!.to,to:last.to,insert:''},
          {from:p.to,to:p.to,insert:marks})
        for (let i=0; i<wrappers.length-1; i++) {
          const a = wrappers[i], b = wrappers[i+1]
          changes.push({from:a.content!.to,to:a.to,insert:''},{from:b.from,to:b.content!.from,insert:''})
        }
      }
    }
    const edited = changes.sort((a, b) => a.from - b.from)
    const a = modPoint(s.from, edited, 1), b = modPoint(s.to, edited, -1)
    const nextSelection = selection.anchor <= selection.head ? { anchor: a, head: b } : { anchor: b, head: a }
    return this.apply(edited, selection, { after: nextSelection, validate: next => fragments.every(({ unit, p, full }) => {
      const u = [...units(next.root)].find(c => c.box.from === modPoint(unit.box.from, edited, -1) && c.box.role === unit.box.role)
      return !!u && visible(u.box) === visible(unit.box) &&
        (!remove && full || [...boxes(u.box)].some(n => n.role === style && n.content &&
          n.content.from <= modPoint(p.from, edited, 1) && n.content.to >= modPoint(p.to, edited, -1)) === !remove)
    }) })
  }
  private formatAcrossLines(style: 'strong' | 'em', selected: Unit[], selection: Selection) {
    const s = range(selection)
    const chosen = (c: ReturnType<typeof formatCoverage>[number]) => s.from <= c.from && c.from < s.to
    const candidates = selected.map(({ box }) => ({ box, coverage: formatCoverage(box),
      wrappers: [...boxes(box)].filter(n => n.role === style && n.content && intersects(n,s)) }))
    if (candidates.some(({ box }) => [...boxes(box)].some(n => n.role === 'inline-code' && intersects(n,s))))
      return deny('代码跨度不能加此格式')
    const selectedText = candidates.flatMap(u => u.coverage).filter(c => chosen(c) && /\S/.test(c.text))
    if (!selectedText.length) return false
    const remove = selectedText.every(c => c.roles.includes(style))
    const desired = (c: typeof selectedText[number]) => chosen(c) ? !remove : c.roles.includes(style)
    const signature = (coverage: typeof selectedText, change: boolean) => JSON.stringify(coverage.map(c =>
      /\s/.test(c.text) ? null : change && chosen(c)
        ? [...c.roles.filter(role => role !== style), ...(!remove ? [style] : [])].sort() : c.roles))
    for (const alternate of [false, true]) {
      const edits = new Map<number, Edit>()
      const change = (from: number, to: number, insert: string) => {
        const same = edits.get(from)
        edits.set(from, { from, to: Math.max(to, same?.to ?? from), insert: (same?.insert ?? '') + insert })
      }
      const marker = (alternate ? '_' : '*').repeat(style === 'strong' ? 2 : 1)
      for (const { box, coverage, wrappers } of candidates) {
        const runs: Span[] = []
        const retained = [...boxes(box)].filter(n => n.content && n !== box && !wrappers.includes(n))
        for (const wrapper of wrappers) {
          change(wrapper.from, wrapper.content!.from, '')
          change(wrapper.content!.to, wrapper.to, '')
        }
        let last: Span | undefined
        for (const c of coverage) {
          if (/\s/.test(c.text)) continue
          const touched = chosen(c) || wrappers.some(w => inSpan(w.content!,c.from))
          const already = retained.some(w => w.role === style && w.content!.from <= c.from && c.to <= w.content!.to)
          if (!touched || !desired(c) || already) { last = undefined; continue }
          const candidate = last && { from: last.from, to: c.to }
          if (last && candidate && this.line(last.to) === this.line(c.from) && !retained.some(n =>
            intersects(n.content!,candidate) && !bounds(n,candidate) &&
            !(candidate.from <= n.content!.from && candidate.to >= n.content!.to))) last.to = c.to
          else { last = { from:c.from,to:c.to }; runs.push(last) }
        }
        for (const run of runs) {
          for (const n of retained) {
            if (n.content!.from === run.from && n.content!.to < run.to) run.from = n.from
            if (n.content!.to === run.to && n.content!.from > run.from) run.to = n.to
          }
          // A split can land at the first or last byte of a removed marker.
          const open = [...edits.values()].find(e => e.from < run.from && run.from < e.to)
          const close = [...edits.values()].find(e => e.from < run.to && run.to < e.to)
          change(open?.from ?? run.from, open?.to ?? run.from, marker)
          change(close?.from ?? run.to, close?.to ?? run.to, marker)
        }
      }
      const ordered = [...edits.values()].sort((a,b) => a.from-b.from)
      const a = modPoint(s.from,ordered,1), b = modPoint(s.to,ordered,-1)
      try {
        return this.apply(ordered, selection, {
          after: selection.anchor <= selection.head ? { anchor:a,head:b } : { anchor:b,head:a },
          validate: next => candidates.every(({ box,coverage }) => {
            const u = [...units(next.root)].find(({ box:n }) => n.from === modPoint(box.from,ordered,-1) && n.role === box.role)?.box
            return !!u && visible(u) === visible(box) && signature(formatCoverage(u),false) === signature(coverage,true)
          })
        })
      } catch (error) { if (!(error instanceof EditError)) throw error }
    }
    return deny('无法无损映射此跨行格式，请重新选择')
  }
  private removeAcrossLines(unit: Box, wrapper: Box, selection: Selection) {
    const s = range(selection), body = wrapper.content!
    if ([...boxes(wrapper)].some(n => n.role === 'inline-code' && intersects(n, s))) return deny('代码跨度不能加此格式')
    const open = this.raw.slice(wrapper.from, body.from), close = this.raw.slice(body.to, wrapper.to)
    const left = this.raw.slice(body.from, s.from), right = this.raw.slice(s.to, body.to)
    // Put a closing marker before retained trailing whitespace and an opening
    // marker after retained leading whitespace, leaving line breaks untouched.
    const leftEnd = body.from + left.trimEnd().length
    const rightStart = body.to - right.trimStart().length
    const useAsterisk = (point: number) => open === '_' && /[\p{L}\p{N}]/u.test(this.raw[point - 1] ?? '') &&
      /[\p{L}\p{N}]/u.test(this.raw[point] ?? '')
    const leftAsterisk = left.trim() && useAsterisk(leftEnd), rightAsterisk = right.trim() && useAsterisk(rightStart)
    const edits: Edit[] = [left.trim() ? { from: leftEnd, to: leftEnd, insert: leftAsterisk ? '*' : close }
      : { from: wrapper.from, to: body.from, insert: '' }, right.trim() ? { from: rightStart, to: rightStart, insert: open }
      : { from: body.to, to: wrapper.to, insert: '' }]
    if (leftAsterisk) edits.unshift({ from: wrapper.from, to: body.from, insert: '*' })
    if (rightAsterisk) {
      edits.at(-1)!.insert = '*'
      edits.push({ from: body.to, to: wrapper.to, insert: '*' })
    }
    const a = modPoint(s.from, edits, 1), b = modPoint(s.to, edits, -1)
    const coverage = (box: Box) => [...leaves(box)].flatMap(({ leaf, parents }) =>
      Array.from({ length: leaf.text.length }, (_, index) => ({
        value: parents.filter(p => ['strong', 'em', 's', 'link'].includes(p.role)).map(p => p.role).sort(),
        point: leaf.points[index], whitespace: /\s/.test(leaf.text[index])
      })))
    const expected = coverage(unit).map(({ value, point, whitespace }) => whitespace ? null
      : s.from <= point && point < s.to ? value.filter(role => role !== wrapper.role) : value)
    return this.apply(edits, selection, {
      after: selection.anchor <= selection.head ? { anchor: a, head: b } : { anchor: b, head: a },
      validate: next => {
        const result = [...units(next.root)].find(({ box }) => box.from === modPoint(unit.from, edits, -1) && box.role === unit.role)?.box
        return !!result && visible(result) === visible(unit) &&
          JSON.stringify(coverage(result).map(({ value, whitespace }) => whitespace ? null : value)) === JSON.stringify(expected)
      }
    })
  }
  heading(level: number, mark = this.mark()) {
    this.writable()
    if (!Number.isInteger(level) || level < 0 || level > 6) return deny('标题级别无效')
    const selection = this.resolve(mark), s = range(selection)
    this.guarded(s)
    const blocks = this.projection.root.children.filter(n => n.kind === 'box' && (intersects(n, s) || (s.from === s.to && inSpan(n, s.from))))
    if (!blocks.length || blocks.some(n => n.kind !== 'box' || !['paragraph', 'heading'].includes(n.role))) return deny('仅支持连续正文或标题')
    const empty = blocks.find(n => n.kind === 'box' && n.role === 'paragraph' && n.content?.from === s.from && n.content.to === s.to)
    if (s.from === s.to && empty) {
      this.pendingBlock = level ? { block: level, point: s.from } : undefined
      return false
    }
    const changes: Edit[] = []
    for (const node of blocks as Box[]) {
      const p = node.content!
      if (this.raw.slice(p.from, p.to).match(/[\r\n]/) || (p.from === p.to && level))
        return deny('多行或空标题需先在原文中处理')
      if ((node.attrs?.level ?? 0) === level) continue
      changes.push({ from: node.from, to: p.from, insert: level ? '#'.repeat(level) + ' ' : '' })
      if (node.to !== p.to) changes.push({ from: p.to, to: node.to, insert: '' })
    }
    // A complete single-block selection converted to a heading leaves the
    // caret at the end of the new title, ready for Enter to start its body.
    const title = blocks.length === 1 && level && changes.length && s.from < s.to &&
      blocks[0].kind === 'box' && displayIndex(blocks[0], s.from) === 0 &&
      displayIndex(blocks[0], s.to) === visible(blocks[0]).length
    const caret = title ? modPoint(s.to, changes, 1) : undefined
    return this.apply(changes, selection, { after: caret === undefined ? undefined : { anchor: caret, head: caret },
      validate: next => (blocks as Box[]).every(n =>
      next.root.children.some(b => b.kind === 'box' && b.from === modPoint(n.from, changes, -1) && b.attrs?.level === level && visible(b) === visible(n))) })
  }
  toggleTask(target: Box) {
    this.ensureTarget(target, 'task')
    if (!target.marker) return deny('找不到任务框标记')
    const { from, to } = target.marker
    return this.one({ from, to, insert: this.raw[from + 1] === ' ' ? '[x]' : '[ ]' }, this.selection)
  }
  link(data: { url?: string; text?: string; title?: string; remove?: boolean; target?: Box }, mark = this.mark()) {
    const selection = this.resolve(mark), s = range(selection)
    const unit = this.getUnit(s.from)
    if (!unit || unit.box !== this.getUnit(s.to)?.box || unit.box.role === 'code') return deny('链接仅支持单段文字')
    const target = data.target ?? [...boxes(unit.box)].find(n => n.role === 'link' && inSpan(n, s.from) && inSpan(n, s.to))
    if (target) this.ensureTarget(target, 'link')
    const p = target?.content ?? s
    this.guarded(p)
    const original = this.raw.slice(p.from, p.to)
    const oldLabel = target ? visible(target) : visible(unit.box).slice(displayIndex(unit.box, p.from), displayIndex(unit.box, p.to))
    const keepLabel = data.text === undefined || data.text === oldLabel
    const label = keepLabel ? original : encodeInline(data.text!, tableCell(unit.box), this.newline(p.from))
    if (/[\r\n]/.test(original) || /[\r\n]/.test(data.text ?? '') || !label.trim()) return deny('链接文字必须是单行非空文字')
    if (data.remove && !target) return deny('请选择已有链接')
    const insert = data.remove ? label : '[' + label + '](' + markdownURL(safeLink(data.url ?? '')) + quoteTitle(data.title ?? target?.attrs?.title) + ')'
    const start = target?.from ?? s.from
    return this.one({ from: start, to: target?.to ?? s.to, insert }, selection, { validate: next => {
      const nextUnit = [...units(next.root)].find(u => u.box.from === unit.box.from && u.box.role === unit.box.role)
      const expected = visible(unit.box).slice(0, displayIndex(unit.box, p.from)) +
        (keepLabel ? oldLabel : data.text!) + visible(unit.box).slice(displayIndex(unit.box, p.to))
      if (!nextUnit || visible(nextUnit.box) !== expected) return false
      const links = [...boxes(nextUnit.box)].filter(n => n.role === 'link')
      return data.remove ? !links.some(n => n.from === start) : links.some(n => n.from === start && n.to === start + insert.length)
    } })
  }
  private boundary(mark: Bookmark) {
    const s = range(this.resolve(mark))
    this.guarded(s)
    const n = this.projection.root.children.find(n => inSpan(n, s.to))
    if (!n || n.kind !== 'box' || !['paragraph','heading'].includes(n.role)) return deny('请从正文或标题选择插入位置')
    return n.to
  }
  image(data: { alt?: string; address?: string; title?: string; target?: Box; remove?: boolean; confirmed?: boolean }, mark = this.mark()) {
    const selection = this.resolve(mark)
    if (data.target) this.ensureTarget(data.target, 'image')
    if (data.remove && (!data.target || !data.confirmed)) return deny('删除图片引用需要明确确认')
    const p = range(selection)
    const u = this.getUnit(p.to)
    const split = !data.target && p.from === p.to && u?.box.role === 'paragraph' &&
      u.parents.length === 1 && p.to > u.box.from && p.to < u.box.to
    if (split && [...boxes(u!.box)].some(n => n !== u!.box && n.from < p.to && p.to < n.to))
      return deny('图片插入会切开行内标记')
    const at = data.target?.from ?? (split ? p.to : this.boundary(mark))
    const image = data.remove ? '' : '![' + encodeInline(data.alt ?? '', false, '\n') + '](' +
      markdownURL(imagePath(data.address ?? '').target) + quoteTitle(data.title) + ')'
    if (/[\r\n]/.test(data.alt ?? '')) return deny('替代文字需为一行')
    const prefix = data.target || at === 0 || at === 1 && this.raw[0] === '\uFEFF' ? '' : this.newline(at).repeat(2)
    const suffix = split ? this.newline(at).repeat(2) : ''
    return this.one({ from: at, to: data.target?.to ?? at, insert: prefix + image + suffix }, selection, { validate: next => {
      if (data.remove) return true
      const created = [...boxes(next.root)].some(n => n.role === 'image' && n.from === at + prefix.length)
      if (!created || !split) return created
      const text = visible(u!.box), middle = displayIndex(u!.box, at)
      const before = next.root.children.find(n => n.from === u!.box.from)
      const after = next.root.children.find(n => n.from === at + prefix.length + image.length + suffix.length)
      return !!before && !!after && visible(before) === text.slice(0, middle) && visible(after) === text.slice(middle)
    } })
  }
  table(cols: number, rows: number, mark = this.mark()) {
    if (![cols, rows].every(Number.isInteger) || cols < 1 || cols > 8 || rows < 1 || rows > 20) return deny('表格上限为 8 列 × 20 行')
    const at = this.boundary(mark), newline = this.newline(at)
    const cells = Array<string>(cols).fill('')
    const rowsText = [cells, cells.map(() => '---'), ...Array.from({ length: rows - 1 }, () => cells)]
    const value = rowsText.map(r => '| ' + r.join(' | ') + ' |').join(newline)
    const start = at + newline.length * 2
    return this.one({ from: at, to: at, insert: newline + newline + value }, this.resolve(mark), {
      after: { anchor: start + 3, head: start + 3 },
      validate: next => [...boxes(next.root)].some(n => n.role === 'table' && n.from === start && n.children.length === rows)
    })
  }
  tableEdit(table: Box, action: { type: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol' | 'header' | 'align' | 'remove'
    index: number; align?: '' | 'left' | 'center' | 'right'; confirmed?: boolean }) {
    this.ensureTarget(table, 'table')
    if (this.projection.protected.some(n => intersects(n, table))) return deny('表格含受保护内容')
    const rows = (table.children as Box[]).map(r => (r.children as Box[]).map(c => this.raw.slice(c.content!.from, c.content!.to)))
    const aligns = (table.children[0] as Box).children.map(n => (n as Box).attrs?.align ?? '')
    const { type, index, confirmed } = action
    if (['deleteRow', 'deleteCol', 'remove'].includes(type) && !confirmed) return deny('删除需要明确确认')
    if (type === 'remove') {
      const adjacent = [...units(this.projection.root)]
      const caret = adjacent.find(u=>u.box.from>=table.to)?.box.content?.from ??
        adjacent.filter(u=>u.box.to<=table.from).at(-1)?.box.content?.to ?? table.from
      const next = caret > table.from ? caret-(table.to-table.from) : caret
      return this.one({ ...table, insert: '' }, this.selection, { after:{anchor:next,head:next} })
    }
    if (!Number.isInteger(index) || index < 0) return deny('表格位置无效')
    const cols = aligns.length
    if (type === 'insertRow') {
      if (index < 1 || index > rows.length || rows.length >= 20 || cols > 8) return deny('不能在此增加表格行')
      rows.splice(index, 0, Array<string>(cols).fill(''))
    } else if (type === 'deleteRow') {
      if (index >= rows.length || rows.length < 2) return deny('不能删除最后一行')
      rows.splice(index, 1)
    } else if (type === 'header') {
      if (index < 1 || index >= rows.length) return deny('请选择正文行')
      ;[rows[0], rows[index]] = [rows[index], rows[0]]
    } else if (type === 'insertCol') {
      if (index > cols || cols >= 8 || rows.length > 20) return deny('不能在此增加表格列')
      aligns.splice(index, 0, ''); rows.forEach(r => r.splice(index, 0, ''))
    } else if (type === 'deleteCol') {
      if (index >= cols || cols < 2) return deny('不能删除最后一列')
      aligns.splice(index, 1); rows.forEach(r => r.splice(index, 1))
    } else {
      if (index >= cols || !['', 'left', 'center', 'right'].includes(action.align ?? '')) return deny('对齐位置无效')
      aligns[index] = action.align ?? ''
    }
    const delimiter = aligns.map(a => (a === 'left' || a === 'center' ? ':' : '') + '---' + (a === 'right' || a === 'center' ? ':' : ''))
    const grid = [rows[0], delimiter, ...rows.slice(1)]
    const newline = this.newline(table.from)
    const lines = grid.map(r => '| ' + r.join(' | ') + ' |')
    const insert = lines.join(newline)
    const active = this.activeTable()
    let row = active?.row ?? 0, column = active?.column ?? 0
    if (type === 'insertRow' && index <= row) row++
    if (type === 'deleteRow' && index < row) row--
    if (type === 'header') row = row === index ? 0 : row === 0 ? index : row
    if (type === 'insertCol' && index <= column) column++
    if (type === 'deleteCol' && index < column) column--
    row = Math.min(row, rows.length-1)
    column = Math.min(column, aligns.length-1)
    const line = row === 0 ? 0 : row+1
    const caret = table.from + lines.slice(0,line).reduce((n,v)=>n+v.length+newline.length,0) + 2 +
      rows[row].slice(0,column).reduce((n,v)=>n+v.length+3,0) + (rows[row][column] ? 0 : 1)
    return this.one({ from: table.from, to: table.to, insert }, this.selection, {
      after: { anchor: caret, head: caret },
      validate: (next, raw) => {
        const t = [...boxes(next.root)].find(n => n.role === 'table' && n.from === table.from)
        return !!t && JSON.stringify((t.children as Box[]).map(r => (r.children as Box[]).map(c =>
          raw.slice(c.content!.from, c.content!.to)))) === JSON.stringify(rows)
      }
    })
  }
  tableEdgeText(table: Box, side: 'before' | 'after', text: string) {
    this.ensureTarget(table, 'table')
    if (!text) return false
    const at = side === 'before' ? table.from : table.to
    const nl = this.newline(at)
    const literal = encodeInline(text, false, nl)
    const before = side === 'after' ? nl.repeat(2) : ''
    const after = side === 'before' ? nl.repeat(2) : ''
    const caret = at + before.length + literal.length
    return this.one({ from: at, to: at, insert: before + literal + after }, this.selection, {
      after: { anchor: caret, head: caret },
      validate: next => next.root.children.some(n => n.kind === 'box' && n.role === 'paragraph' &&
        n.from === at + before.length && visible(n) === text.replace(/\r\n?/g, '\n')) &&
        next.root.children.some(n => n.kind === 'box' && n.role === 'table' && visible(n) === visible(table) &&
          n.from === table.from + (side === 'before' ? literal.length + after.length : 0))
    })
  }
  private codeSelection(selection: Selection, s: Span) {
    const a = this.getUnit(s.from), b = this.getUnit(s.to)
    if (!a || !b || a.parents.length !== 1 || b.parents.length !== 1 ||
        a.box.role !== 'paragraph' || b.box.role !== 'paragraph') return deny('代码转换需要普通正文选区')
    const selected = this.projection.root.children.filter(n => intersects(n,s))
    if (selected.some(n => n.kind !== 'box' || n.role !== 'paragraph')) return deny('代码转换不能跨越该结构')
    // Refuse to break a marker; boundaries outside formatted runs stay raw.
    for (const { box } of [a,b]) if ([...boxes(box)].some(n => n !== box &&
      ((n.from < s.from && s.from < n.to) || (n.from < s.to && s.to < n.to)))) return deny('代码转换会切开行内标记')
    const nl = this.newline(s.from)
    const left = visible(a.box).slice(0, displayIndex(a.box,s.from))
    const right = visible(b.box).slice(displayIndex(b.box,s.to))
    const body = selected.map((n, i) => visible(n).slice(i === 0 ? left.length : 0,
      i === selected.length-1 ? visible(n).length-right.length : undefined)).map(value => value.replaceAll('\n',nl)).join(nl.repeat(2))
    const prefix = left ? nl.repeat(2) : '', suffix = right ? nl.repeat(2) : ''
    const fence = '\x60'.repeat(Math.max(3,...(body.match(/\x60+/g) ?? []).map(m => m.length+1)))
    const insert = prefix + fence + nl + body + nl + fence + suffix
    const start = s.from + prefix.length
    const caret = start + fence.length + nl.length
    return this.one({ ...s, insert }, selection, { after: { anchor: caret, head: caret }, validate: next =>
      next.root.children.some(n => n.kind === 'box' && n.role === 'code' && n.from === start &&
        visible(n) === body.replace(/\r\n?/g, '\n')) &&
      (!left || next.root.children.some(n => n.kind === 'box' && n.role === 'paragraph' && n.from === a.box.from && visible(n) === left)) &&
      (!right || next.root.children.some(n => n.kind === 'box' && n.role === 'paragraph' && n.from === s.from+insert.length && visible(n) === right)) })
  }
  changeBlock(kind: 'list' | 'ordered' | 'task' | 'quote' | 'code' | 'paragraph', mark = this.mark()) {
    this.writable()
    const selection = this.resolve(mark), s = range(selection)
    this.guarded(s,kind==='code'?undefined:'structure')
    const unit = s.from === s.to ? this.getUnit(s.from) : undefined
    if (kind !== 'code' && unit?.parents.length === 1 && unit.box.role === 'paragraph' && unit.box.from === unit.box.to) {
      this.pendingBlock = kind === 'paragraph' ? undefined : { block: kind, point: s.from }
      return false
    }
    if (kind === 'code' && s.from < s.to) return this.codeSelection(selection, s)
    if (kind === 'code') {
      const u = this.getUnit(s.from)
      if (!u || u.parents.length !== 1 || !['paragraph','heading'].includes(u.box.role))
        return deny('请从普通正文或标题插入代码块')
      const at = u.box.to, nl = this.newline(at), fence = '\x60'.repeat(3)
      const prefix = u.box.from === u.box.to && (at === 0 || this.raw === '\uFEFF' || /\n[ \t]*\n$/.test(this.projection.normalized)) ? '' : nl.repeat(2)
      const insert = prefix + fence + nl + nl + fence
      const caret = at + prefix.length + fence.length + nl.length
      return this.one({ from:at,to:at,insert }, selection, { after:{anchor:caret,head:caret}, validate: next =>
        next.root.children.some(n => n.kind === 'box' && n.role === 'code' && n.from === at+prefix.length && !visible(n)) })
    }
    const firstItem = this.getUnit(s.from), lastItem = this.getUnit(s.to)
    if (kind !== 'quote' && firstItem && lastItem && firstItem.parents.some(n => n.role === 'li'))
      return this.convertList(kind,firstItem,lastItem,selection)
    const selected = this.projection.root.children.filter(n => intersects(n, s) || s.from === s.to && inSpan(n, s.from))
    if (!selected.length || selected.some(n => n.kind !== 'box')) return deny('没有可转换的块')
    const edits: Edit[] = []
    const newline = this.newline(s.from)
    const content: string[] = []
    if (kind === 'paragraph') {
      for (const n of selected as Box[]) {
        if (n.role === 'quote' && n.children.length === 1 && n.children[0].kind === 'box' && n.children[0].role === 'paragraph') {
          const value = this.raw.slice(n.from, n.to).replace(/^> ?/gm, '')
          content.push(visible(n.children[0]))
          edits.push({ ...n, insert: value })
        } else if (['ul', 'ol'].includes(n.role)) {
          const items = (n.children as Box[]).map(li => li.children.length === 1 && li.children[0].kind === 'box' ? li.children[0] : null)
          if (items.some(p => !p || !['paragraph', 'task'].includes(p.role) || /[\r\n]/.test(this.raw.slice(p.content!.from, p.content!.to))))
            return deny('复杂列表不能直接降级')
          content.push(...items.map(p => visible(p!)))
          edits.push({ ...n, insert: items.map(p => this.raw.slice(p!.content!.from, p!.content!.to)).join(newline.repeat(2)) })
        } else return deny('请选择可降级的引用或列表')
      }
    } else {
      for (const [i, n] of (selected as Box[]).entries()) {
        if (n.role !== 'paragraph' || /[\r\n]/.test(this.raw.slice(n.from, n.to))) return deny('请选择单行普通正文块')
        const original = this.raw.slice(n.from, n.to)
        content.push(visible(n))
        const mark = { list: '- ', ordered: i + 1 + '. ', task: '- [ ] ', quote: '> ' }[kind]
        edits.push({ ...n, insert: mark + original })
      }
    }
    const role = { list: 'paragraph', ordered: 'paragraph', task: 'task', quote: 'paragraph', code: 'code', paragraph: 'paragraph' }[kind]
    return this.apply(edits, selection, { validate: next => {
      const start = edits[0].from, last = edits.at(-1)!
      const end = modPoint(last.to, edits, 1)
      const found = [...units(next.root)].filter(u => u.box.from >= start && u.box.to <= end && u.box.role === role)
      return JSON.stringify(found.map(u => visible(u.box))) === JSON.stringify(content) &&
        (kind !== 'list' && kind !== 'ordered' && kind !== 'quote' || found.every(u =>
          u.parents.some(p => p.role === { list: 'ul', ordered: 'ol', quote: 'quote' }[kind])))
    } })
  }
  private convertList(kind: 'list' | 'ordered' | 'task' | 'paragraph', first: Unit, last: Unit, selection: Selection) {
    const item = first.parents.at(-1), tail = last.parents.at(-1)
    const list = first.parents.at(-2)
    if (!list || !item || !tail || list !== last.parents.at(-2) || !['ul','ol'].includes(list.role) ||
      item.role!=='li' || tail.role!=='li' || item.children[0]!==first.box || tail.children[0]!==last.box ||
      first.parents.some(node=>node.role==='quote')) return deny('请选择同级兼容列表项')
    const items = list.children as Box[]
    const a = items.indexOf(item), b = items.indexOf(tail)
    const selected = items.slice(a,b+1)
    const bodies = selected.map(item => item.children[0] as Box)
    if (a < 0 || b < a || selected.some((entry,i) => !entry.marker || !bodies[i]?.content ||
      !['paragraph','task'].includes(bodies[i].role))) return deny('列表项没有可转换的正文')
    const uniform = kind === 'task' ? bodies.every(n => n.role === 'task') && list.role === 'ul'
      : list.role === (kind === 'ordered' ? 'ol' : 'ul') && bodies.every(n => n.role === 'paragraph')
    const target = kind === 'paragraph' || uniform ? 'paragraph' : kind
    if (target==='paragraph' && selected.some(entry=>entry.children.length!==1))
      return deny('列表项包含子树，不能无损退回段落；请先移动子项')
    const nested=target==='paragraph' && first.parents.length>3
    const split = target === 'paragraph' || (target === 'ordered') !== (list.role === 'ol')
    const edits: Edit[] = []
    for (const [i,entry] of selected.entries()) {
      const body = bodies[i], content = body.content!, token = entry.marker!
      const line = this.line(entry.from)-1
      const lineStart = this.projection.lines[line]
      const indent = this.raw.slice(lineStart,entry.from)
      const separation = /^ {1,4}(?=\S)/.exec(this.raw.slice(token.to))?.[0].length
      if (!separation || !/^(?:\uFEFF)? *$/.test(indent)) return deny('不规则列表标记需用原文辅助')
      const next = target === 'paragraph' ? '' : target === 'list' ? '- ' : target === 'ordered' ? (i+1)+'. '
        : body.role === 'task' && body.marker ? '- ' + this.raw.slice(body.marker.from,body.marker.to) + ' ' : '- [ ] '
      // Separate different list kinds from the surrounding items without moving the parent's indentation.
      if (split && (i === 0 ? a > 0 || nested : target === 'paragraph'))
        edits.push({from:lineStart,to:lineStart,insert:this.newline(entry.from)})
      edits.push({from:entry.from,to:content.from,insert:next})
      const oldColumn = token.to-entry.from+separation
      const newColumn = target==='paragraph' ? 0 : target==='ordered' ? String(i+1).length+2 : 2
      const delta = newColumn-oldColumn
      if (!delta) continue
      for (const start of this.projection.lines.slice(line+1,this.line(entry.to))) {
        const text=this.raw.slice(start).split(/\r\n|\r|\n/,1)[0]
        if (!/\S/.test(text)) continue
        if (!text.startsWith(' '.repeat(entry.from-lineStart+oldColumn))) return deny('该子树含惰性续行或不规则缩进')
        edits.push({from:start,to:start+Math.max(0,-delta),insert:' '.repeat(Math.max(0,delta))})
      }
    }
    if (b < items.length-1 && split) {
      const edge=selected.at(-1)!.to
      edits.push({from:edge,to:edge,insert:this.newline(edge)})
    }
    const fingerprint = (n:Box) => JSON.stringify([visible(n),shape(n),[...boxes(n)].filter(b=>b.role==='task')
      .map(task=>task.marker && this.raw.slice(task.marker.from,task.marker.to).toLowerCase())])
    const plan = edits.sort((a,b)=>a.from-b.from||a.to-b.to)
    return this.apply(plan,selection,{validate: (next,raw) => {
      const parsed = [...units(next.root)]
      const owners=(u:Unit)=>u.parents.filter(n=>n.role==='li')
      const selectedSet=new Set(bodies)
      if (nested && [...units(this.projection.root)].some(before=>{
        if (selectedSet.has(before.box) || !before.box.content) return false
        const after=parsed.find(u=>u.box.role===before.box.role && u.box.content?.from===modPoint(before.box.content!.from,plan,1))
        return !after || visible(after.box)!==visible(before.box) || shape(after.box)!==shape(before.box) ||
          JSON.stringify(owners(after).map(n=>n.marker?.from))!==JSON.stringify(owners(before).map(n=>modPoint(n.marker!.from,plan,1)))
      })) return false
      const checked=(node:Box)=>JSON.stringify([visible(node),shape(node),[...boxes(node)].filter(b=>b.role==='task')
        .map(task=>task.marker && raw.slice(task.marker.from,task.marker.to).toLowerCase())])
      return bodies.every((body,i) => {
        const from = modPoint(body.content!.from,plan,1)
        const found = parsed.find(({box})=>box.content?.from === from)
        const children=(found?.parents.at(-1)?.children.slice(1) ?? []) as Box[]
        const original=selected[i].children.slice(1) as Box[]
        return !!found && found.box.role === (target === 'task' ? 'task' : 'paragraph') &&
          (target === 'paragraph' ? nested ?
            JSON.stringify(owners(found).map(n=>n.marker?.from))===JSON.stringify(owners(first).slice(0,-1).map(n=>modPoint(n.marker!.from,plan,1)))
            : found.parents.length === 1 :
            found.parents.length===first.parents.length && found.parents.at(-2)?.role === (target === 'ordered' ? 'ol' : 'ul') &&
            JSON.stringify(children.map(checked))===JSON.stringify(original.map(fingerprint))) &&
          visible(found.box) === visible(body) && JSON.stringify(found.box.children.map(shape)) === JSON.stringify(body.children.map(shape))
      })
    }})
  }
  indentList(reverse: boolean, mark = this.mark()) {
    const selection = this.resolve(mark), s = range(selection)
    this.guarded(s,'structure')
    const a = this.getUnit(s.from), b = this.getUnit(s.to)
    const lastList = (u: Unit | undefined) => u?.parents.filter(n => n.role === 'ul' || n.role === 'ol').at(-1)
    const lastItem = (u: Unit | undefined) => u?.parents.filter(n => n.role === 'li').at(-1)
    const list = lastList(a), first = lastItem(a), last = lastItem(b)
    if (!list || !first || !last || list !== lastList(b)) return deny('只能移动相邻同级列表项')
    const siblings = list.children as Box[]
    const i = siblings.indexOf(first), j = siblings.indexOf(last)
    const parent = a!.parents.filter(n => n.role === 'li').at(-2)
    const owner = reverse ? parent : siblings[i - 1]
    if (!owner?.marker || !first.marker || i < 0 || j < i)
      return deny('列表边界没有可保持顺序的父项')
    const contentColumn = (n: Box) => {
      const end = n.marker!.to
      const line = this.projection.lines[this.line(end) - 1]
      if (!/^ *$/.test(this.raw.slice(line,n.from))) return deny('混合制表或引用的缩进需用原文')
      const spaces = /^ {1,4}(?=\S)/.exec(this.raw.slice(end))?.[0].length
      if (!spaces) return deny('无法确定父项的 Markdown 内容列')
      return end - line + spaces
    }
    if (reverse && owner.children.at(-1)!==list) return deny('该列表后还有同父正文，不能无损提升')
    const firstLine = this.line(first.from) - 1
    const delta = reverse ? first.from - this.projection.lines[firstLine] - (owner.from - this.projection.lines[this.line(owner.from)-1])
      : contentColumn(owner) - (first.from - this.projection.lines[firstLine])
    if (delta <= 0) return deny('列表内容列无有效偏移')
    const endLine = this.line(last.to) - 1
    const edits: Edit[] = []
    for (const start of this.projection.lines.slice(firstLine,endLine+1)) {
      if (!/\S/.test(this.raw.slice(start).split(/\r\n|\r|\n/,1)[0])) continue
      if (reverse && this.raw.slice(start,start+delta) !== ' '.repeat(delta)) return deny('该子树含不规则缩进')
      edits.push({ from:start, to:reverse ? start+delta : start, insert:reverse ? '' : ' '.repeat(delta) })
    }
    const following = reverse ? siblings.slice(j+1) : []
    if (following.length) {
      const extra=contentColumn(last)-(last.from-this.projection.lines[this.line(last.from)-1])-delta
      const from=this.line(following[0].from)-1, to=this.line(following.at(-1)!.to)-1
      for (const start of this.projection.lines.slice(from,to+1)) {
        if (!/\S/.test(this.raw.slice(start).split(/\r\n|\r|\n/,1)[0])) continue
        if (extra<0 && this.raw.slice(start,start-extra)!==' '.repeat(-extra)) return deny('后续子树含不规则缩进')
        if (extra) edits.push({from:start,to:start+Math.max(0,-extra),insert:' '.repeat(Math.max(0,extra))})
      }
    }
    const expected = siblings.slice(i,j+1)
    const signature = (n:Node) => JSON.stringify([visible(n),shape(n)])
    const start = modPoint(first.from, edits, 1)
    return this.apply(edits, selection, { validate: next => {
      const items = [...boxes(next.root)].filter(n => n.role === 'li')
      const firstNew = items.find(n => n.from === start)
      if (!firstNew) return false
      const parentList = [...boxes(next.root)].find(n => (n.role === 'ul' || n.role === 'ol') && n.children.includes(firstNew))
      if (!parentList || (reverse ? parentList.from > owner.from : parentList.from <= owner.from)) return false
      const startIndex = parentList.children.indexOf(firstNew)
      const shifted=parentList.children.slice(startIndex,startIndex+expected.length) as Box[]
      if (shifted.length!==expected.length) return false
      const followingStart=following.length ? modPoint(following[0].from,edits,1) : undefined
      return shifted.every((item,k)=>{
        const old=expected[k]
        if (!following.length || k!==shifted.length-1) return signature(item)===signature(old)
        const nested=item.children.filter((child):child is Box=>child.kind==='box' && ['ol','ul'].includes(child.role))
        const rest = nested.flatMap(list=>list.children).filter(n=>n.from>=followingStart!)
        const prefix = item.children.map(n=>n.kind==='box' && ['ol','ul'].includes(n.role)
          ? {...n,children:n.children.filter(c=>c.from<followingStart!)} : n)
          .filter(n=>!(n.kind==='box' && ['ol','ul'].includes(n.role) && !n.children.length))
        return signature({...item,children:prefix})===signature(old) &&
          JSON.stringify(rest.map(signature))===JSON.stringify(following.map(signature))
      })
    } })
  }
  language(target: Box, language: string) {
    this.ensureTarget(target, 'code')
    if (!/^[\w+#.-]{0,32}$/.test(language) || /^agent$/i.test(language)) return deny('代码语言无效或为保留名称')
    const mark = /^(\x60{3,}|~{3,})/.exec(this.raw.slice(target.from))![0]
    const end = this.projection.lines[this.line(target.from)] ?? target.to
    const to = end - (this.raw.slice(target.from, end).match(/(?:\r\n|\r|\n)$/)?.[0].length ?? 0)
    return this.one({ from: target.from + mark.length, to, insert: language }, this.selection,
      { validate: next => [...boxes(next.root)].some(n => n.role === 'code' && n.from === target.from && n.label === language && visible(n) === visible(target)) })
  }
  rawBlock(target: Box, value: string, mark = this.mark()) {
    this.ensureTarget(target)
    if (target.kind !== 'protected') return deny('只能从保护清单进入局部原文编辑')
    // A textarea uses LF. Keep original line endings outside its changed span.
    const previous = this.raw.slice(target.from, target.to)
    const original = normalize(previous)
    const d = diff(original.normalized, value.replace(/\r\n?/g, '\n'))
    const from = target.from + original.rawPoints[d.from], to = target.from + original.rawPoints[d.to]
    const insert = d.insert.replaceAll('\n', this.newline(from))
    return this.one({ from, to, insert }, this.resolve(mark), {
      allow: target, validate: next => !next.errors.length && next.protected.some(n =>
        n.from === target.from && n.to === target.to + insert.length - (to - from) && n.role === target.role) &&
        next.protected.length === this.projection.protected.length
    })
  }
  switchMode(mode: Mode) {
    this.writable()
    if (mode === 'render' && this.projection.errors.length) {
      this.rawFailure = true
      return deny(this.sourceError)
    }
    this._mode = mode
    this.rawFailure = false
    this.typingGroup++
    this.pending = []
    this.pendingBlock = undefined
  }
  sourceEdit(value: string, selection: Selection) {
    if (this.mode !== 'source') return deny('当前未进入原文模式')
    const old = this.projection
    const e = diff(old.normalized, value)
    const from = old.rawPoints[e.from], to = old.rawPoints[e.to]
    const insert = e.insert.replaceAll('\n', this.newline(from))
    const candidate = project(this.raw.slice(0, from) + insert + this.raw.slice(to))
    const a = candidate.rawPoints[selection.anchor], b = candidate.rawPoints[selection.head]
    if (a === undefined || b === undefined) return deny('无效的原文选区')
    return this.one({ from, to, insert }, this.selection, { guard: 'raw', after: { anchor: a, head: b } })
  }
  beginComposition() {
    this.writable()
    this.composition = { mark: this.mark(Infinity), ending: false }
  }
  endComposition() { if (this.composition) this.composition.ending = true }
  commitComposition(text: string) {
    const lock = this.composition
    if (!lock?.ending) return false
    this.composition = undefined
    return text.length ? this.type(text, lock.mark, 'text', false) : false
  }
  abortComposition() { this.composition = undefined }
  undo() { return this.travel(false) }
  redo() { return this.travel(true) }
  private travel(redo: boolean) {
    this.writable()
    const entry = (redo ? this.future : this.past).pop()
    if (!entry) return false
    ;(redo ? this.past : this.future).push(entry)
    this.state = redo ? entry.after : entry.before
    this._projection = project(this.raw)
    this._version++
    this._draftEpoch++
    this.typingGroup++
    this.pending = []
    this.pendingBlock = undefined
    return true
  }
  beginSave(): SaveTicket | undefined {
    this.writable()
    if (!this.dirty) return undefined
    this.ticket = Object.freeze({ noteId: this.noteId, baseRevision: this.baseRevision, draftEpoch: this.draftEpoch,
      raw: this.raw, version: this.version, token: Symbol('save') })
    return this.ticket
  }
  finishSave(ticket: SaveTicket, result: { ok: true; revision: string } | { ok: false }) {
    if (ticket !== this.ticket) return false
    this.ticket = undefined
    if (result.ok) { this.saved = ticket.raw; this._baseRevision = result.revision; this.typingGroup++ }
    return true
  }

  adoptTaskAnchor(expectedRevision: string, note: { id: string; revision: string; content: string }, at: number, insert: string, mark: Bookmark) {
    this.writable()
    if (this.dirty || this.noteId !== note.id || this.baseRevision !== expectedRevision ||
        note.content !== this.raw.slice(0, at) + insert + this.raw.slice(at)) deny('编辑内容已变更，请读取磁盘版本')
    const edits = [{ from: at, to: at, insert }]
    const projectEntry = (state: State): State => ({
      raw: state.raw.slice(0, at) + insert + state.raw.slice(at),
      selection: { anchor: modPoint(state.selection.anchor, edits, -1), head: modPoint(state.selection.head, edits, -1) }
    })
    // History entries can predate the task content or place it elsewhere. Do not
    // guess their anchor position or allow a regular undo to delete the saved ID.
    this.past = []
    this.future = []
    this.state = projectEntry({ ...this.state, selection: { anchor: mark.anchor, head: mark.head } })
    this.saved = note.content
    this._baseRevision = note.revision
    this._projection = project(note.content)
    this._version++
    this._draftEpoch++
    this.typingGroup++
    this.pending = []
    this.pendingBlock = undefined
  }
  adoptResult(expectedRevision: string, version: number, note: { id: string; revision: string; content: string },
    from: number, to: number, insert: string) {
    this.writable()
    if (this.dirty || this.version !== version || this.noteId !== note.id || this.baseRevision !== expectedRevision ||
        from < 0 || to < from || to > this.raw.length ||
        note.content !== this.raw.slice(0, from) + insert + this.raw.slice(to)) deny('编辑内容已变化，请读取磁盘版本')
    const edits = [{ from, to, insert }]
    const { anchor, head } = this.selection
    this.state = { raw: note.content, selection: { anchor: modPoint(anchor, edits,-1), head: modPoint(head,edits,-1) } }
    this.saved = note.content
    this._baseRevision = note.revision
    this._projection = project(note.content)
    this._version++
    this._draftEpoch++
    this.typingGroup++
    // Older undo entries do not own this interval.
    this.past = []
    this.future = []
    this.pending = []
    this.pendingBlock = undefined
  }

  route(target: { noteId: string; action: 'graph' | 'open' | 'readDisk' | 'close' }) {
    if (this.composing || this.ticket) return 'locked'
    if (target.noteId === this.noteId && target.action === 'graph') return 'suspend-same-session'
    if (target.noteId === this.noteId && target.action === 'open') return 'resume-same-session'
    return this.dirty ? 'require-leave' : 'load-new-session'
  }
  suspend(noteId: string) {
    this.writable()
    if (noteId !== this.noteId) return deny('跨笔记切换必须先通过离开关卡')
    this.paused = true
    return { noteId, token: this.identity, mode: this.mode, selection: this.selection, scroll: { ...this.scroll } }
  }
  resume(handle: { noteId: string; token: symbol }) {
    if (handle.noteId !== this.noteId || handle.token !== this.identity || !this.paused) return deny('编辑会话已变化')
    this.paused = false
  }
  delegationLine() {
    if (this.locked || this.mode !== 'render') return undefined
    const point = this.selection.head
    const unit = this.getUnit(point)
    if (!unit) return undefined
    const task = scanDelegation(this.raw).taskAt(this.line(point))
    return task?.marker && !task.issue ? { unit: unit.box, line: task.line } : undefined
  }
  delegation(entry: 'palette' | 'confirm', mark = this.mark()) {
    this.writable()
    const { head } = this.resolve(mark)
    if (this.mode === 'render' && !this.getUnit(head)) return deny('该位置无法映射到有效源行')
    const task = scanDelegation(this.raw).taskAt(this.line(head))
    if (entry === 'confirm' && (!task?.marker || task.issue)) return deny('当前源行没有合法指令')
    return { entry, task, focus: mark, source: { noteId: this.noteId, baseRevision: this.baseRevision, draft: this.dirty } }
  }
  wikiAt(point: number) { return [...boxes(this.projection.root)].find(n => n.role === 'wiki' && inSpan(n, point))?.wiki }
  wikiReferences() { return [...scanWiki(this.raw).references] }
}
