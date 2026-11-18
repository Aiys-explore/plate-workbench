import { type Box, type Leaf, type Node as Projected, type Span } from './projection'
import { EditError, EditorSession, boxes, safeLink, visible, type Selection as SourceSelection } from './session'
import { clearPlateDrag, startPlateDrag } from '../home-handoff'

type RefreshFocus = (root: HTMLElement) => HTMLElement | undefined
type Endpoint = { node: Node; offset: number }
type Hooks = {
  changed?: (session: EditorSession) => void
  rejected?: (reason: string) => void
  delegate?: (payload: ReturnType<EditorSession['delegation']>) => void
  wiki?: (target: NonNullable<Box['wiki']>, anchor: HTMLElement) => void
  inspect?: (node: Box, anchor: HTMLElement) => void
  save?: (session: EditorSession) => void
  link?: (target?: Box) => void
  selection?: () => void
  afterRender?: () => void
}
const tags: Record<string, string> = {
  document: 'div', paragraph: 'p', task: 'div', quote: 'blockquote', ul: 'ul', ol: 'ol', li: 'li',
  strong: 'strong', em: 'em', s: 's', link: 'a', 'inline-code': 'code', code: 'pre', table: 'table', tr: 'tr', th: 'th', td: 'td'
}
export class EditorSurface {
  private root?: HTMLElement
  private tableEdge?: { table: Box; side: 'before' | 'after'; element: HTMLElement }
  private source?: HTMLTextAreaElement
  private leaves: { node: Text; leaf: Leaf }[] = []
  private spans = new WeakMap<Node, Span>()
  private targets = new WeakMap<Node, Box>()
  private ime: 'idle' | 'native' | 'ending' = 'idle'
  private imeText = ''
  private imeEdge?: NonNullable<EditorSurface['tableEdge']>
  private imeTimer?: number
  private abort = new AbortController()
  private mounted = false
  private readonlyOverride = false
  private resultLock = false
  get canPatch() { return this.ime === 'idle' && !this.session.composing && !this.session.locked && !this.readonlyOverride && !this.resultLock }
  setResultLock(value: boolean) { this.resultLock = value; this.syncReadOnly() }
  private scroller?: HTMLElement
  private sourceTimer?: number
  private lineAction?: HTMLButtonElement
  private lineMark?: ReturnType<EditorSession['mark']>
  private caret?: HTMLSpanElement
  private localScrolls=new WeakMap<ReturnType<EditorSession['mark']>,{source?:number;table?:number}>()
  private cellScroller() {
    const selection=this.host.ownerDocument.getSelection()
    return selection?.focusNode?.parentElement?.closest<HTMLElement>('[data-editor-table-scroll]')
  }
  constructor(readonly host: HTMLElement, readonly session: EditorSession, readonly hooks: Hooks = {}) {
    const signal = this.abort.signal
    host.ownerDocument.addEventListener('selectionchange', () => {
      if (this.root && this.ime === 'idle') this.run(() => {
        const previous = this.session.selection
        const next = this.readSelection()
        this.paintSelection()
        this.updateDelegation()
        if (next && (previous.anchor !== next.anchor || previous.head !== next.head)) this.hooks.selection?.()
      }, false)
    }, { signal })
    this.refresh()
  }
  destroy() {
    this.abort.abort()
    window.clearTimeout(this.imeTimer)
    window.clearTimeout(this.sourceTimer)
    if (this.session.composing) this.session.abortComposition()
    this.host.replaceChildren()
    CSS.highlights.delete('note-selection')
    this.mounted = false
  }
  private run(fn: () => unknown, render = true, refreshFocus?: RefreshFocus) {
    const mode = this.session.mode, version = this.session.version, locked = this.session.locked
    try {
      fn()
      if (render) this.hooks.rejected?.('')
      if (render && (this.session.mode !== mode || this.session.version !== version || this.session.locked !== locked)) {
        this.refresh(true, refreshFocus)
        this.hooks.changed?.(this.session)
      } else if (render) {
        this.restoreSelection()
        this.updateDelegation()
      }
      return true
    } catch (e) {
      if (!(e instanceof EditError)) throw e
      this.hooks.rejected?.(e.message)
      if (render) this.restoreSelection()
      return false
    }
  }
  command(fn: () => unknown) { return this.run(fn) }
  materialAt(element: HTMLElement) {
    const node = this.targets.get(element)
    return node?.kind === 'box' ? visible(node).trim() : ''
  }
  outsideEdit(fn: () => boolean) {
    try {
      if (fn()) { this.refresh(false); this.hooks.changed?.(this.session) }
      return true
    } catch (error) {
      if (!(error instanceof EditError)) throw error
      this.hooks.rejected?.(error.message)
      return false
    }
  }
  tablePosition() {
    const scroller=this.scroller ?? this.host
    const table=this.cellScroller()
    const cell=table && this.host.ownerDocument.getSelection()?.focusNode?.parentElement?.closest('td,th')
    return {x:table?.scrollLeft ?? 0,y:scroller.scrollTop,relative:cell?.getBoundingClientRect().top}
  }
  tableCommand(fn: () => unknown, {x,y,relative}:ReturnType<EditorSurface['tablePosition']>) {
    const ok=this.run(fn)
    if (ok) {
      this.focus()
      const version=this.session.version
      this.restoreTablePosition(x,y,relative)
      requestAnimationFrame(()=>{
        if (this.host.isConnected && this.session.version===version && this.active()===this.host.ownerDocument.activeElement)
          this.restoreTablePosition(x,y,relative)
      })
    }
    return ok
  }
  private restoreTablePosition(x:number,y:number,relative?:number) {
    const scroller=this.scroller ?? this.host
    const next=this.cellScroller()
    const nextCell=next && this.host.ownerDocument.getSelection()?.focusNode?.parentElement?.closest('td,th')
    if (next && nextCell && relative!==undefined) {
      next.scrollLeft=x
      scroller.scrollTop+=nextCell.getBoundingClientRect().top-relative
    } else if(!next && relative!==undefined) {
      const selection=this.host.ownerDocument.getSelection()
      const focus=selection?.focusNode?.parentElement?.closest('[data-editor-role]')
      if(focus && this.host.contains(focus)) scroller.scrollTop+=focus.getBoundingClientRect().top-relative
      else scroller.scrollTop=y
    } else scroller.scrollTop=y
  }
  setScroller(scroller: HTMLElement) { this.scroller = scroller }
  restoreScroll() { (this.scroller ?? this.host).scrollTo(this.session.scroll.x, this.session.scroll.y) }
  private graphBookmark?: ReturnType<EditorSession['mark']>
  private graphTable?: HTMLElement
  suspendForGraph() {
    this.graphBookmark=this.captureBookmark(Infinity)
    this.graphTable=this.cellScroller() ?? undefined
  }
  restoreAfterGraph() {
    const mark=this.graphBookmark, table=this.graphTable
    if (!mark) return
    const local=this.localScrolls.get(mark)
    const restoreScroll=()=>{
      this.restoreScroll()
      if (table && local?.table!==undefined) table.scrollLeft=local.table
      if (this.source && local?.source!==undefined) this.source.scrollTop=local.source
    }
    restoreScroll()
    if (this.source) this.restoreSelection()
    const active=this.active()
    if (!active) return
    // Applying a DOM selection to contenteditable can steal focus from the graph entry.
    active.addEventListener('focus', ()=>{
      if (this.graphBookmark!==mark) return
      this.graphBookmark=undefined; this.graphTable=undefined
      if (this.session.version!==mark.version) return
      this.restoreSelection()
      restoreScroll()
    },{once:true,signal:this.abort.signal})
  }
  setReadOnly(value: boolean) {
    this.readonlyOverride = value
    this.syncReadOnly()
    this.updateDelegation()
    this.paintSelection()
  }
  private syncReadOnly() {
    const locked = this.readonlyOverride || this.resultLock || this.session.locked
    if (this.source) this.source.readOnly = locked
    if (this.root) {
      this.root.contentEditable = String(!locked)
      this.root.setAttribute('aria-readonly', String(locked))
    }
  }
  captureBookmark(ttl?: number) {
    if (this.root) this.readSelection()
    else if (this.source === document.activeElement) this.capture()
    const scroller = this.scroller ?? this.host
    this.session.scroll = { x: scroller.scrollLeft, y: scroller.scrollTop }
    const mark=this.session.mark(ttl)
    this.localScrolls.set(mark,{source:this.source?.scrollTop,table:this.cellScroller()?.scrollLeft})
    return mark
  }
  restoreBookmark(mark: ReturnType<EditorSession['mark']>) {
    return this.run(() => {
      try { this.session.cancel(mark) } catch (error) {
        this.focus()
        throw error
      }
      this.active()?.focus({ preventScroll: true })
      const restored = this.restoreSelection()
      ;(this.scroller ?? this.host).scrollTo(mark.scroll.x, mark.scroll.y)
      const local=this.localScrolls.get(mark), table=this.cellScroller()
      if (table && local?.table!==undefined) table.scrollLeft=local.table
      if (this.source && local?.source!==undefined) this.source.scrollTop=local.source
      if (!restored) throw new EditError('原选区无法显示，已回到最近可编辑文字')
    }, false)
  }
  findMatches(query: string) {
    const needle = query.toLocaleLowerCase()
    const equal = (text: string) => text.toLocaleLowerCase() === needle
    const offsets = (text: string) => {
      const matches: number[] = []
      for (let i = 0; i <= text.length - query.length; i++) {
        if (!equal(text.slice(i,i+query.length))) continue
        matches.push(i)
        i += query.length - 1
      }
      return matches
    }
    if (!query) return []
    if (this.source) return offsets(this.source.value).map(from => () => {
      const source=this.source
      if (!source) return
      source.setSelectionRange(from, from + query.length)
      // The search field retains focus; a mirror gives the textarea's wrapped visual line.
      const mirror=document.createElement('div'), marker=document.createElement('span')
      const css=getComputedStyle(source)
      Object.assign(mirror.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',
        width:source.clientWidth+'px',boxSizing:'border-box',padding:css.padding,
        font:css.font,letterSpacing:css.letterSpacing,tabSize:css.tabSize,whiteSpace:'pre-wrap',overflowWrap:'break-word'})
      mirror.append(document.createTextNode(source.value.slice(0,from)),marker)
      marker.textContent=source.value.slice(from) || '\u200b'
      document.body.append(mirror)
      const r=marker.getClientRects()[0], top=mirror.getBoundingClientRect().top
      if (r) source.scrollTop=Math.max(0,r.top-top-source.clientHeight/3)
      mirror.remove()
    })
    const groups = new Map<HTMLElement, Text[]>()
    for (const { node } of this.leaves) {
      const group = node.parentElement?.closest<HTMLElement>(
        '[data-editor-role=paragraph],[data-editor-role=heading],[data-editor-role=task],[data-editor-role=td],[data-editor-role=th],[data-editor-role=code]')
      if (!group) continue
      const nodes = groups.get(group) ?? []
      nodes.push(node)
      groups.set(group,nodes)
    }
    return [...groups].flatMap(([group, nodes]) => {
      const points = nodes.flatMap(node => Array.from({ length: node.length }, (_, offset) => ({ node,offset })))
      const text = nodes.map(n => n.data).join('').replaceAll('\n',' ')
      return offsets(text).map(from => () => {
        const first = points[from], last = points[from + query.length - 1]
        const range = document.createRange()
        range.setStart(first.node,first.offset)
        range.setEnd(last.node,last.offset + 1)
        CSS.highlights.delete('note-find')
        if (!group.matches('[data-editor-role=code]')) CSS.highlights.set('note-find', new Highlight(range))
        const container = this.scroller ?? this.host
        const rect = range.getBoundingClientRect(), viewport = container.getBoundingClientRect()
        if (rect.top < viewport.top || rect.bottom > viewport.bottom) container.scrollTop += rect.top - viewport.top
      })
    })
  }
  private paintSelection() {
    this.caret?.remove()
    CSS.highlights.delete('note-selection')
    const selection = this.host.ownerDocument.getSelection()
    const root = this.root
    if (!root || !selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    if (!selection.isCollapsed) {
      const highlight = new Highlight(range.cloneRange())
      highlight.priority = 1
      CSS.highlights.set('note-selection', highlight)
    } else if (!this.readonlyOverride && !this.session.locked && this.ime === 'idle' && document.activeElement === root) {
      let box = range.getBoundingClientRect()
      if (!box.height) {
        const node = selection.focusNode
        const leaf = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
        if (leaf instanceof HTMLElement && leaf.dataset.editorText !== undefined && !leaf.textContent)
          box = leaf.getBoundingClientRect()
      }
      if (!box.height) return
      const origin = this.host.getBoundingClientRect()
      const caret = this.host.ownerDocument.createElement('span')
      caret.dataset.editorCaret = ''
      caret.setAttribute('aria-hidden','true')
      Object.assign(caret.style,{ left:box.left-origin.left+'px',top:box.top-origin.top+'px',height:box.height+'px' })
      this.host.append(caret)
      this.caret = caret
    }
  }
  private position(node: Node, offset: number): number | undefined {
    if (!this.root?.contains(node)) return undefined
    if (node.nodeType === Node.TEXT_NODE) {
      const m = this.leaves.find(l => l.node === node)
      // Duplicate source offsets encode multi-unit indivisible characters/entities.
      if (!m || offset < 0 || offset > m.leaf.text.length) return undefined
      if (offset > 0 && offset < m.leaf.text.length &&
          (m.leaf.points[offset - 1] === m.leaf.points[offset] || /[\uDC00-\uDFFF]/.test(m.leaf.text[offset]))) return undefined
      return m.leaf.points[offset]
    }
    const direct = this.targets.get(node)
    if (direct?.kind === 'atom' || direct?.kind === 'protected') return undefined
    const first = node.childNodes[offset]
    const last = node.childNodes[offset - 1]
    const find = (child: Node | undefined, edge: 'from' | 'to'): number | undefined => {
      if (!child) return undefined
      const leaf = this.leaves.find(l => l.node === child)
      if (leaf) return leaf.leaf[edge]
      if (child instanceof HTMLElement && child.dataset.editorRole === 'prefix') return undefined
      return find(edge === 'from' ? child.firstChild ?? undefined : child.lastChild ?? undefined, edge) ?? this.spans.get(child)?.[edge]
    }
    return find(first, 'from') ?? find(last, 'to') ?? this.spans.get(node)?.from
  }
  mapDOM(): SourceSelection | undefined {
    const selection = this.host.ownerDocument.getSelection()
    if (!selection?.anchorNode || !selection.focusNode || !this.root?.contains(selection.anchorNode) ||
        !this.root.contains(selection.focusNode)) return undefined
    const anchor = this.position(selection.anchorNode, selection.anchorOffset)
    const head = this.position(selection.focusNode, selection.focusOffset)
    if (anchor === undefined || head === undefined) return undefined
    return { anchor, head }
  }
  readSelection(required = false) {
    const s = this.mapDOM()
    if (s) this.session.select(s)
    else if (required) throw new EditError('当前 DOM 选区未映射或切开了保护原子')
    return s
  }
  private endpoint(source: number, nearest: boolean): Endpoint | undefined {
    let best: { at: Endpoint; distance: number } | undefined
    for (const { node, leaf } of this.leaves) {
      for (const [offset, p] of leaf.points.entries()) {
        if (offset && offset < leaf.text.length &&
            (leaf.points[offset - 1] === p || /[\uDC00-\uDFFF]/.test(leaf.text[offset]))) continue
        if (p === source) return { node, offset }
        const distance = Math.abs(p - source)
        if (nearest && (!best || distance < best.distance)) best = { at: { node, offset }, distance }
      }
    }
    return best?.at
  }
  restoreSelection() {
    const { anchor, head } = this.session.selection
    if (this.source) {
      const pts = this.session.projection.rawPoints
      const a = pts.indexOf(anchor), b = pts.indexOf(head)
      if (a >= 0 && b >= 0) this.source.setSelectionRange(Math.min(a, b), Math.max(a, b), a > b ? 'backward' : 'forward')
      return a >= 0 && b >= 0
    }
    const a = this.endpoint(anchor, true), b = this.endpoint(head, true)
    if (!a || !b) return false
    this.host.ownerDocument.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
    this.paintSelection()
    return this.position(a.node, a.offset) === anchor && this.position(b.node, b.offset) === head
  }
  private active() { return this.root ?? this.source }
  focus() { this.active()?.focus({ preventScroll: true }); this.restoreSelection() }
  refreshSavedAnchor() { this.refresh(); this.hooks.changed?.(this.session) }
  refresh(focus = false, refreshFocus?: RefreshFocus) {
    if (this.ime !== 'idle') return
    const active = this.active()
    const hadFocus = active === this.host.ownerDocument.activeElement
    this.leaves = []
    this.spans = new WeakMap()
    this.targets = new WeakMap()
    this.lineAction = undefined
    this.lineMark = undefined
    this.tableEdge = undefined
    if (this.session.mode === 'source') {
      if (!this.source) this.installSource()
      this.root = undefined
      const source = this.source!
      if (source.value !== this.session.projection.normalized) source.value = this.session.projection.normalized
    } else {
      if (!this.root) this.installRender()
      this.source = undefined
      const root = this.root!
      this.spans.set(root, this.session.projection.root)
      root.replaceChildren(...this.session.projection.root.children.filter(n => n.kind === 'text' || !n.hidden).map(n => this.render(n)))
    }
    this.syncReadOnly()
    if (focus || hadFocus || !this.mounted) {
      const task = this.root && refreshFocus?.(this.root)
      task?.focus({ preventScroll: true })
      if (!task || this.host.ownerDocument.activeElement !== task) {
        this.active()?.focus({ preventScroll: true })
        this.restoreSelection()
      }
    }
    this.mounted = true
    this.updateDelegation()
    this.hooks.afterRender?.()
  }
  private render(n: Projected): Node {
    const doc = this.host.ownerDocument
    if (n.kind === 'text') {
      const span = doc.createElement('span')
      span.dataset.editorText = ''
      const node = doc.createTextNode(n.text)
      this.leaves.push({ node, leaf: n })
      this.spans.set(node, n)
      this.spans.set(span, n)
      span.append(node)
      if (!n.text) span.append(doc.createElement('br'))
      return span
    }
    const element = doc.createElement(n.role === 'heading' ? 'h' + n.attrs?.level :
      n.role === 'rule' ? 'hr' : tags[n.role] ?? (n.kind === 'protected' ? 'span' : 'span'))
    element.dataset.editorRole = n.role
    element.dataset.p10From = String(n.from)
    element.dataset.p10To = String(n.to)
    if (n.role === 'heading') element.dataset.level = String(n.attrs?.level)
    if (n.kind === 'protected') element.dataset.editorProtected = ''
    this.spans.set(element, n)
    this.targets.set(element, n)
    if (n.hidden) element.hidden = true
    if (n.kind !== 'box') {
      element.contentEditable = 'false'
      if (n.role === 'wiki' || n.role === 'image' || !n.hidden && n.kind === 'protected') {
        element.tabIndex = 0
        element.setAttribute('role', 'button')
      }
      if (n.role === 'image') {
        element.textContent = n.label ? '图片：' + n.label : '装饰图'
        element.dataset.state = /^https?:/i.test(n.attrs?.url ?? '') ? 'remote' : 'local'
        element.title = '图片占位'
      } else if (n.role === 'wiki') element.textContent = n.label ?? ''
      else if (!n.hidden && n.kind === 'protected') element.textContent = '保护原文 · ' + n.role
      return element
    }
    if (n.role === 'ol' && n.attrs?.start) (element as HTMLOListElement).start = n.attrs.start
    if (n.role === 'link') {
      element.tabIndex = 0
      element.setAttribute('role', 'link')
      element.title = n.attrs?.url ?? ''
      // No href; only an explicit action outside the editable DOM may open it.
    }
    if (n.role === 'code' && n.label) element.dataset.language = n.label
    if (n.attrs?.align) element.style.textAlign = n.attrs.align
    if (n.role === 'task' && n.marker) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.contentEditable = 'false'
      button.dataset.editorTask = ''
      this.targets.set(button, n)
      button.setAttribute('role', 'checkbox')
      const checked = this.session.raw[n.marker.from + 1] !== ' '
      button.setAttribute('aria-checked', String(checked))
      button.setAttribute('aria-label', '切换任务勾选')
      element.append(button)
      const grip = doc.createElement('button')
      grip.type = 'button'
      grip.contentEditable = 'false'
      grip.draggable = true
      grip.dataset.taskGrip = ''
      grip.title = '拖动任务到左侧 Agent'
      grip.setAttribute('aria-label', '拖动任务到 Agent')
      grip.tabIndex = -1
      grip.textContent = '⠿'
      grip.addEventListener('dragstart', event => {
        const text = this.session.raw.slice(n.from, n.to).replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '').trim()
        if (!event.dataTransfer || !text || this.readonlyOverride) { event.preventDefault(); return }
        const owner = this.host.closest('[data-editor-surface]')
        const title = owner?.querySelector<HTMLInputElement>('[data-editor-meta-title]')?.value || '未命名笔记'
        startPlateDrag(event.dataTransfer, { material: { noteId: this.session.noteId, revision: this.session.baseRevision, title, text } })
      })
      grip.addEventListener('dragend', clearPlateDrag)
      element.append(grip)
    }
    const children = n.children.filter(c => c.kind === 'text' || !c.hidden).map(c => this.render(c))
    if (n.role === 'table') {
      const head = doc.createElement('thead'), body = doc.createElement('tbody')
      head.append(children[0]); body.append(...children.slice(1)); element.append(head, body)
      const wrapper = doc.createElement('div')
      wrapper.dataset.editorTableScroll = ''
      wrapper.append(element)
      this.spans.set(wrapper, n)
      return wrapper
    } else element.append(...children)
    return element
  }
  private updateDelegation() {
    if (!this.root || !this.hooks.delegate) return
    const line = this.readonlyOverride ? undefined : this.session.delegationLine()
    if (!line || this.ime !== 'idle') {
      this.lineAction?.remove()
      this.lineAction = undefined
      this.lineMark = undefined
      return
    }
    const unit = [...this.root.querySelectorAll<HTMLElement>('[data-editor-role]')].find(e => this.targets.get(e) === line.unit)
    if (!unit) return
    if (this.lineAction?.parentElement === unit && this.lineAction.dataset.editorDelegation === String(line.line)) return
    this.lineAction?.remove()
    const button = this.root.ownerDocument.createElement('button')
    button.type = 'button'
    button.dataset.editorDelegation = String(line.line)
    button.textContent = '委派'
    button.contentEditable = 'false'
    button.addEventListener('pointerdown', e => { e.preventDefault(); this.lineMark = this.session.mark() })
    button.addEventListener('click', () => {
      if (this.session.locked) return
      this.run(() => this.hooks.delegate?.(this.session.delegation('confirm', this.lineMark ?? this.session.mark())), false)
      this.lineMark = undefined
    })
    this.lineAction = button
    unit.append(button)
  }
  private key(e: KeyboardEvent) {
    if (this.readonlyOverride || this.resultLock) return
    if (this.ime !== 'idle' || e.isComposing || e.keyCode === 229 || e.key === 'Process') return
    const target = e.target instanceof HTMLElement ? e.target : undefined
    if (target?.dataset.editorDelegation !== undefined || target?.closest('[data-p10-slot]')) return
    if (target && target !== this.root && target !== this.source && e.key === 'Enter') {
      const n = this.targets.get(target)
      if (n && (target.hasAttribute('role') || n.kind === 'atom')) {
        e.preventDefault()
        this.activate(n, target, e.ctrlKey || e.metaKey)
        return
      }
    }
    const mod = e.ctrlKey || e.metaKey
    if (mod) {
      const key = e.key.toLowerCase()
      if (!['z', 'y', 'b', 'i', 'k', 's', 'p'].includes(key) || key === 'p' && !e.shiftKey) return
      if (this.source && !['z', 'y', 's', 'p'].includes(key)) return
      e.preventDefault()
      if (key === 's') { this.run(() => { if (!this.session.locked) this.hooks.save?.(this.session) }, false); return }
      if (key === 'p') {
        if(e.repeat)return
        this.run(() => {
          this.capture()
          this.hooks.delegate?.(this.session.delegation('palette'))
        }, false)
        return
      }
      this.run(() => {
        if (key === 'z' || key === 'y') return key === 'y' || e.shiftKey ? this.session.redo() : this.session.undo()
        this.readSelection(true)
        if (key === 'k') {
          const s = this.session.selection
          const node = [...boxes(this.session.projection.root)].find(n => n.role === 'link' && s.head >= n.from && s.head <= n.to)
          this.hooks.link?.(node)
          return
        }
        return this.session.format(key === 'b' ? 'strong' : 'em')
      }, key !== 'k')
      return
    }
    if (this.root && e.key === 'Escape') this.run(() => this.session.clearPending(), false)
    if (this.root && ['Enter','Tab','Escape'].includes(e.key)) this.tableKeys(e)
    if (this.root && e.key === 'Tab' && !e.defaultPrevented) {
      const point = this.mapDOM()?.head
      const nodes = point === undefined ? [] : [...boxes(this.session.projection.root)].filter(n => n.from <= point && n.to >= point)
      const code = nodes.some(n => n.role === 'code')
      const list = nodes.some(n => n.role === 'li')
      if (code && !e.shiftKey || list) {
        const applied = this.run(() => { this.readSelection(true); return code ? this.session.type('\t') : this.session.indentList(e.shiftKey) })
        if (applied || code) e.preventDefault()
      }
    }
  }
  private atTableEdge() {
    const node = this.host.ownerDocument.getSelection()?.focusNode
    return node && this.tableEdge?.element.contains(node) ? this.tableEdge : undefined
  }
  private showTableEdge(table: Box, side: 'before' | 'after') {
    this.tableEdge?.element.remove()
    const source = [...this.root!.querySelectorAll('table')].find(n => this.targets.get(n) === table)
    if (!source) throw new EditError('表格已变化')
    const element = this.host.ownerDocument.createElement('p')
    element.dataset.editorRole = 'table-edge'
    element.append(this.host.ownerDocument.createElement('br'))
    source[side](element)
    this.tableEdge = { table, side, element }
    this.host.ownerDocument.getSelection()?.collapse(element,0)
  }
  private tableKeys(e: KeyboardEvent) {
    const s = this.mapDOM()
    if (!s) return
    const role = (n: Box) => n.role === 'th' || n.role === 'td'
    const box = [...boxes(this.session.projection.root)].find(b => b.role === 'table' && s.head >= b.from && s.head <= b.to)
    const cells = box ? [...boxes(box)].filter(role) : []
    const index = cells.findIndex(b => s.head >= b.content!.from && s.head <= b.content!.to)
    if (!box || index < 0 || e.key === 'Enter' && e.shiftKey) return
    const cols = (box.children[0] as Box).children.length
    const next = e.key === 'Escape' ? cells.length : e.key === 'Enter' ? index + cols : index + (e.shiftKey ? -1 : 1)
    const target = cells[next]?.content?.from ??
      (next < 0 ? this.leaves.filter(l => l.leaf.to <= box.from).at(-1)?.leaf.to :
        this.leaves.find(l => l.leaf.from >= box.to)?.leaf.from)
    e.preventDefault()
    this.run(() => {
      if (target === undefined) { this.showTableEdge(box, next < 0 ? 'before' : 'after'); return }
      this.session.select({ anchor: target, head: target })
      this.restoreSelection()
    }, false)
  }
  private capture() {
    if (this.root) return this.readSelection(true)
    if (this.source) {
      const { selectionStart: a, selectionEnd: b, selectionDirection: d } = this.source
      const points = this.session.projection.rawPoints
      this.session.select({ anchor: points[d === 'backward' ? b : a], head: points[d === 'backward' ? a : b] })
    }
  }
  private activate(n: Box, anchor: HTMLElement, mod: boolean) {
    if (this.session.locked || this.readonlyOverride || this.resultLock) return
    if (anchor.dataset.editorTask !== undefined) {
      const { marker } = n
      const before = marker && this.session.raw.slice(marker.from, marker.to)
      const expected = before === '[ ]' ? '[x]' : before === '[x]' || before === '[X]' ? '[ ]' : undefined
      // Toggling is a same-length marker replacement, so source offsets identify the same task after render.
      const refreshFocus: RefreshFocus | undefined =
        this.host.ownerDocument.activeElement === anchor && n.role === 'task' && marker && expected
          ? root => {
              if (this.session.raw.slice(marker.from, marker.to) !== expected) return
              return Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-editor-task][role=checkbox]'))
                .find(button => {
                  const task = this.targets.get(button)
                  return task?.role === 'task' && task.from === n.from && task.to === n.to &&
                    task.marker?.from === marker.from && task.marker.to === marker.to
                })
            }
          : undefined
      this.run(() => this.session.toggleTask(n), true, refreshFocus)
    }
    else if (n.wiki && mod) this.hooks.wiki?.(n.wiki, anchor)
    else if (['link', 'image'].includes(n.role) || n.kind === 'protected') this.hooks.inspect?.(n, anchor)
  }
  openLink(node: Box, open: (target: string) => void) {
    return this.run(() => {
      if (this.session.locked || ![...boxes(this.session.projection.root)].includes(node) || node.role !== 'link')
        throw new EditError('链接已变化或编辑器忙，请重新选择')
      open(safeLink(node.attrs?.url ?? ''))
    }, false)
  }

  showBitmap(node: Box, anchor: HTMLElement, encoded: string) {
    if (!anchor.isConnected || this.targets.get(anchor) !== node || !encoded.startsWith('data:image/png;base64,')) return
    const bitmap = document.createElement('img')
    bitmap.alt = node.attrs?.alt ?? node.label ?? ''
    bitmap.src = encoded
    anchor.dataset.state = 'loaded'
    anchor.replaceChildren(bitmap)
  }
  private installRender() {
    const root = this.host.ownerDocument.createElement('div')
    this.root = root
    root.dataset.editorHost = 'render'
    root.spellcheck = false
    root.setAttribute('role', 'textbox')
    root.setAttribute('aria-label', 'Markdown 正文')
    root.setAttribute('aria-multiline', 'true')
    root.tabIndex = 0
    const signal = this.abort.signal
    const active = () => this.root === root
    root.addEventListener('keydown', e => { if (active()) this.key(e) }, { signal })
    root.addEventListener('focusin', () => this.paintSelection(), { signal })
    root.addEventListener('focusout', () => this.caret?.remove(), { signal })
    root.addEventListener('pointerdown', e => { if (this.ime !== 'idle') e.preventDefault() }, { signal })
    root.addEventListener('click', e => {
      if (!active() || this.ime !== 'idle' || !(e.target instanceof HTMLElement) || e.target.closest('[data-p10-slot]')) return
      for (let el: HTMLElement | null = e.target; el && el !== root; el = el.parentElement) {
        const n = this.targets.get(el)
        if (!n) continue
        if (el.dataset.editorTask !== undefined || n.kind !== 'box' || n.role === 'link') {
          e.preventDefault()
          this.activate(n, el, e.ctrlKey || e.metaKey)
          return
        }
      }
    }, { signal })
    root.addEventListener('dragover', e => e.preventDefault(), { signal })
    root.addEventListener('drop', e => e.preventDefault(), { signal })
    root.addEventListener('paste', e => {
      if ((e.target as HTMLElement)?.closest('[data-p10-slot]')) return
      e.preventDefault()
      if (this.ime !== 'idle' || this.readonlyOverride || this.resultLock) return
      this.run(() => { this.readSelection(true); this.session.type(e.clipboardData?.getData('text/plain') ?? '', undefined, 'text', false) })
    }, { signal })
    root.addEventListener('copy', e => {
      const sel = root.ownerDocument.getSelection()
      if (!sel?.rangeCount || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return
      const a = sel.anchorNode.parentElement?.closest('[data-p10-slot]')
      const b = sel.focusNode.parentElement?.closest('[data-p10-slot]')
      if (a && a === b) return // A deliberate copy of the diagnostic itself.
      const contents = sel.getRangeAt(0).cloneContents()
      const ornaments = contents.querySelectorAll('[data-p10-slot], [data-p10-collapsed]')
      if (!ornaments.length) return
      for (const n of ornaments) n.remove()
      for (const n of contents.querySelectorAll('div, p, li, pre, h1, h2, h3, h4, h5, h6, blockquote')) n.append('\n')
      e.preventDefault()
      e.clipboardData?.setData('text/plain',contents.textContent?.trimEnd() ?? '')
    }, { signal })
    root.addEventListener('cut', e => {
      if ((e.target as HTMLElement)?.closest('[data-p10-slot]')) { e.preventDefault(); return }
      e.preventDefault()
      if (this.ime !== 'idle' || this.readonlyOverride || this.resultLock) return
      this.run(() => {
        this.readSelection(true)
        const s = this.session.selection
        if (s.anchor === s.head) return
        const value = this.host.ownerDocument.getSelection()?.toString() ?? ''
        if (this.session.type('', undefined, 'text', false)) e.clipboardData?.setData('text/plain', value)
      })
    }, { signal })
    root.addEventListener('compositionstart', () => {
      if (!active() || this.readonlyOverride || this.resultLock) return
      this.caret?.remove()
      this.run(() => {
        this.imeEdge = this.atTableEdge()
        if (!this.imeEdge) this.readSelection(true)
        this.session.beginComposition()
        this.imeText = ''
        this.ime = 'native'
        this.updateDelegation()
      }, false)
    }, { signal })
    root.addEventListener('compositionend', e => {
      if (!active() || this.ime !== 'native') return
      this.session.endComposition()
      this.ime = 'ending'
      this.imeText = e.data
      // Chromium can emit its last composing input before compositionend. A
      // deferred fallback handles that event order; final input wins if present.
      this.imeTimer = window.setTimeout(() => this.finishIME(this.imeText), 0)
    }, { signal })
    root.addEventListener('beforeinput', e => {
      if (!active()) return
      if (this.readonlyOverride && this.ime === 'idle') { e.preventDefault(); return }
      if (this.ime === 'native' && (e.isComposing || e.inputType === 'insertCompositionText' || e.inputType === 'deleteCompositionText')) return
      e.preventDefault()
      if (this.ime === 'ending') {
        if (['insertText', 'insertCompositionText', 'insertFromComposition'].includes(e.inputType) && e.data != null) this.imeText = e.data
        return
      }
      if (this.ime !== 'idle') return
      const version = this.session.version
      const heading = this.session.headingLevel
      this.run(() => {
        if (e.inputType === 'historyUndo') return this.session.undo()
        if (e.inputType === 'historyRedo') return this.session.redo()
        const edge = this.atTableEdge()
        if (edge && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText'))
          return this.session.tableEdgeText(edge.table, edge.side, e.data ?? '')
        this.readSelection(true)
        const span = e.getTargetRanges()[0]
        if (span) {
          const a = this.position(span.startContainer, span.startOffset)
          const b = this.position(span.endContainer, span.endOffset)
          const current = this.session.selection
          if (a === undefined || b === undefined) throw new EditError('输入范围没有安全的原文映射')
          if (current.anchor === current.head && a !== b && !['deleteContentBackward','deleteContentForward'].includes(e.inputType))
            this.session.select({ anchor: a, head: b })
        }
        if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') return this.session.type(e.data ?? '')
        if (e.inputType === 'insertLineBreak') return this.session.type('\n', undefined, 'hard')
        if (e.inputType === 'insertParagraph') return this.session.type('\n', undefined, 'paragraph')
        if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') return this.session.erase(e.inputType.endsWith('Backward'))
        throw new EditError('此输入操作没有可用的原文映射')
      })
      if (e.inputType === 'insertParagraph') {
        if (this.session.version !== version)
          this.host.ownerDocument.getSelection()?.focusNode?.parentElement?.closest('[data-editor-role]')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        else if (this.session.headingLevel !== heading) this.hooks.selection?.()
      }
    }, { signal })
    root.addEventListener('input', e => {
      if (!active()) return
      if (this.ime === 'ending') this.finishIME((e as InputEvent).data ?? this.imeText)
      else if (this.ime === 'idle') this.refresh(true) // reject unsolicited DOM mutations
    }, { signal })
    this.host.replaceChildren(root)
  }
  private finishIME(text: string) {
    if (this.ime !== 'ending') return
    window.clearTimeout(this.imeTimer)
    this.ime = 'idle'
    const version = this.session.version
    const edge = this.imeEdge
    this.imeEdge = undefined
    const accepted = this.run(() => {
      if (!edge) return this.session.commitComposition(text)
      this.session.abortComposition()
      return this.session.tableEdgeText(edge.table,edge.side,text)
    })
    if (!accepted || this.session.version === version) this.refresh(true)
  }
  private installSource() {
    const source = this.host.ownerDocument.createElement('textarea')
    source.dataset.editorHost = 'source'
    source.setAttribute('aria-label', 'Markdown 全文原文')
    source.spellcheck = false
    this.source = source
    const signal = this.abort.signal
    let sourceComposing = false, sourceEnded = false
    let compositionKeyLock = false
    const input = () => {
      if (this.source !== source || this.readonlyOverride || this.resultLock) return
      const { selectionStart: a, selectionEnd: b, selectionDirection: d } = source
      this.run(() => this.session.sourceEdit(source.value, { anchor: d === 'backward' ? b : a, head: d === 'backward' ? a : b }))
    }
    const finish = () => {
      if (!sourceEnded) return
      sourceEnded = false
      window.clearTimeout(this.sourceTimer)
      this.session.abortComposition()
      input()
      compositionKeyLock = false
    }
    source.addEventListener('keydown', e => { if (!compositionKeyLock && this.source === source) this.key(e) }, { signal })
    source.addEventListener('select', () => {
      if (this.source === source && !compositionKeyLock && source.value === this.session.projection.normalized) this.run(() => this.capture(), false)
    }, { signal })
    source.addEventListener('compositionstart', () => {
      if (this.source !== source) return
      this.run(() => {
        this.capture()
        this.session.beginComposition()
        sourceComposing = compositionKeyLock = true
      }, false)
    }, { signal })
    source.addEventListener('compositionend', () => {
      if (this.source !== source || !sourceComposing) return
      sourceComposing = false
      sourceEnded = true
      this.sourceTimer = window.setTimeout(finish, 0)
    }, { signal })
    source.addEventListener('input', () => { if (sourceEnded) finish(); else if (!sourceComposing) input() }, { signal })
    this.host.replaceChildren(source)
  }
}
