import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { NoteIndexState } from '../../shared/note-index'
import { commands, focus, indexError, type CommandId, type PaletteRegistry, type Source, type Target } from './palette-registry'

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()
const ime = (event: globalThis.KeyboardEvent) => event.isComposing || event.key === 'Process' || event.keyCode === 229
const changed = '条件已变化，请重新选择'
const rowId = (id: CommandId) => 'M51.row.' + id
type Entry = NonNullable<ReturnType<PaletteRegistry['read']>>
type View = { source: Source; query?: string; active?: CommandId; failure?: string }
const same = (a: Entry | undefined, b: Entry | undefined) => !!a && !!b &&
  a.owner === b.owner && a.run === b.run && a.sequence === b.sequence && a.action.basis === b.action.basis

export function PaletteHost({ registry, shell, fallback, binding }: {
  registry: PaletteRegistry; shell: RefObject<HTMLDivElement | null>
  fallback: () => HTMLElement | null; binding: (active: boolean) => void
}) {
  const [view, setView] = useState<View>()
  const opened = useRef(false)
  const epoch = useRef(0)
  const globalComposition = useRef<EventTarget | null>(null)
  const host = useRef<HTMLDialogElement>(null)
  const native = useRef<boolean | undefined>(undefined)
  const blocked = () => native.current !== false || registry.drawerOpen ||
    !!document.querySelector('dialog[open]:not([data-element="M51.palette"]),[aria-modal=true]:not([data-element="M51.palette"]),[role=menu]')
  const canAct = () => {
    const composing = globalComposition.current
    return !blocked() && document.hasFocus() && !registry.composing &&
      !(composing instanceof Node && composing.isConnected)
  }

  useLayoutEffect(() => {
    const workbench = window.workbench
    let live = true, sequence = -1
    const accept = (update: Awaited<ReturnType<typeof workbench.nativeDialog.status>>) => {
      if (live && update.sequence >= sequence) { sequence = update.sequence; native.current = update.pending; binding(true) }
    }
    const off = workbench.nativeDialog.onChange(accept)
    void workbench.nativeDialog.status().then(accept, () => {})
    const compositionStart = (event: Event) => { globalComposition.current = event.target }
    const compositionEnd = (event: Event) => {
      if (globalComposition.current === event.target) globalComposition.current = null
    }
    const blur = () => { globalComposition.current = null; epoch.current++ }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || ime(event) || !event.ctrlKey || event.shiftKey ||
        event.metaKey || event.altKey || event.key.toLowerCase() !== 'p' || !canAct()) return
      if (opened.current) {
        host.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
        return
      }
      const source = registry.capture(fallback)
      epoch.current++
      flushSync(() => setView({ source }))
      if (host.current?.open) { opened.current = true; event.preventDefault() }
      else setView(undefined)
    }
    window.addEventListener('compositionstart', compositionStart, true)
    window.addEventListener('compositionend', compositionEnd, true)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', key)
    return () => {
      live = false; epoch.current++; off()
      window.removeEventListener('keydown', key)
      window.removeEventListener('compositionstart', compositionStart, true)
      window.removeEventListener('compositionend', compositionEnd, true)
      window.removeEventListener('blur', blur)
    }
  }, [registry, fallback, binding])

  function hide(source?: Source) {
    epoch.current++
    opened.current = false
    flushSync(() => setView(undefined))
    source?.restore()
  }

  async function handoff(row: typeof commands[number], expected: Entry, view: View, current: () => boolean, fail: (why: string) => void) {
    const [id, , , , notes] = row
    const ticket = ++epoch.current
    const valid = () => opened.current && epoch.current === ticket && current() && canAct()
    if (!valid()) return
    if (notes) {
      let latest: NoteIndexState
      try {
        latest = await window.workbench.notes.index.status()
      } catch { if (valid()) fail(indexError); return }
      if (!valid()) return
      if (latest.phase !== 'ready' || latest.run !== expected.run || latest.sequence !== expected.sequence) { fail(changed); return }
    }
    const entry = registry.read(id, notes)
    if (!same(expected, entry) || !entry || entry.reason || entry.action.allowed?.() === false) {
      fail(changed); return
    }
    hide()
    const generation = epoch.current
    const recover = () => {
      if (epoch.current !== generation || !document.hasFocus()) return
      view.source.restore()
      if (canAct()) {
        flushSync(() => setView({ ...view, failure: '命令目标未能打开。请重新选择。' }))
        opened.current = !!host.current?.open
      } else setNotice('命令目标未能打开。请重新选择。')
    }
    if (!document.hasFocus() || blocked()) { recover(); return }
    let target: Target | void
    try { target = flushSync(() => entry.action.run(view.source)) } catch { recover(); return }
    if (!target) { view.source.restore(); return }
    const destination = target
    const ensureFocus = (frames: number) => {
      if (epoch.current !== generation || !document.hasFocus()) return
      const owner = registry.read(id, notes)
      if (!owner || owner.owner !== entry.owner || owner.run !== entry.run || owner.sequence !== entry.sequence) { recover(); return }
      const el = destination.element()
      if (el && focus(el)) return
      if (frames) requestAnimationFrame(() => ensureFocus(frames - 1))
      else recover()
    }
    ensureFocus(8)
  }
  const [notice, setNotice] = useState('')
  return <>{notice && <p className="note-notice" role="alert">{notice}</p>}
    {view && createPortal(<Palette registry={registry} shell={shell} host={host} view={view}
      close={() => hide(view.source)} handoff={handoff}/>, document.body)}</>
}

function Palette({ registry, shell, host, view, close, handoff }: {
  registry: PaletteRegistry; shell: RefObject<HTMLDivElement | null>; host: RefObject<HTMLDialogElement | null>;
  view: View; close: () => void;
  handoff: (row: typeof commands[number], expected: Entry, view: View, current: () => boolean, fail: (why: string) => void) => Promise<void>
}) {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const input = useRef<HTMLInputElement>(null)
  const exit = useRef<HTMLButtonElement>(null)
  const [typed, setTyped] = useState(view.query ?? '')
  const [query, setQuery] = useState(view.query ?? '')
  const [chosen, setChosen] = useState<CommandId | undefined>(view.active)
  const [failure, setFailure] = useState(view.failure ?? '')
  const composing = useRef(false)
  const generation = useRef(0)
  const armed = useRef(new Map<CommandId, Entry>())
  const requiresReselect = useRef(new Set<CommandId>())
  const attempt = useRef(false)
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  const registered = commands.flatMap(definition => {
    const [id, label, , aliases, notes] = definition
    const entry = registry.read(id, notes)
    const haystack = normalize([label, ...aliases].join(' '))
    return entry && terms.every(term => haystack.includes(term)) ? [{ definition, entry }] : []
  })
  if (terms.length) registered.sort((a, b) =>
    Number(normalize(b.definition[1]).startsWith(terms[0])) - Number(normalize(a.definition[1]).startsWith(terms[0])))
  const active = registered.find(row => row.definition[0] === chosen) ?? registered[0]
  const activeId = active?.definition[0]

  useLayoutEffect(() => {
    const dialog = host.current!, background = shell.current!
    if (!background.isConnected) return
    try { dialog.showModal() } catch { return }
    input.current?.focus({ preventScroll: true })
    return () => {
      generation.current++
      if (dialog.open) dialog.close()
    }
  }, [shell, host])
  useLayoutEffect(() => {
    for (const [id, , , , notes] of commands) {
      const entry = registry.read(id, notes)
      if (entry && !entry.reason && !armed.current.has(id)) armed.current.set(id, entry)
    }
  })
  useLayoutEffect(() => {
    if (activeId) document.getElementById(rowId(activeId))?.scrollIntoView({ block: 'nearest' })
  }, [activeId, query])

  function select(id: CommandId, entry: Entry) {
    generation.current++
    requiresReselect.current.delete(id)
    armed.current.set(id, entry)
    setChosen(id)
    setFailure('')
  }
  function update(value: string) {
    generation.current++
    setQuery(value)
    setChosen(undefined)
    setFailure('')
  }
  function execute(row: typeof active, pointer = false) {
    if (!row || composing.current || attempt.current) return
    const [id] = row.definition
    if (pointer) { setChosen(id); input.current?.focus({ preventScroll: true }) }
    if (row.entry.reason) { setFailure('命令当前不可用，原因见结果区'); return }
    if (pointer && requiresReselect.current.delete(id)) armed.current.set(id, row.entry)
    if (requiresReselect.current.has(id) || !same(armed.current.get(id), row.entry)) {
      requiresReselect.current.add(id)
      setFailure(changed)
      return
    }
    const ticket = ++generation.current
    attempt.current = true
    void handoff(row.definition, row.entry, { ...view, query, active: id }, () => ticket === generation.current,
      why => { if (why === changed) requiresReselect.current.add(id); setFailure(why) }
    ).finally(() => { attempt.current = false })
  }
  function key(event: KeyboardEvent<HTMLDialogElement>) {
    if (composing.current || ime(event.nativeEvent)) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      ;(document.activeElement === input.current ? exit.current : input.current)?.focus({ preventScroll: true })
      return
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.target !== input.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = registered.indexOf(active)
      const next = registered[Math.max(0, Math.min(registered.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) select(next.definition[0], next.entry)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.repeat) execute(active)
    }
  }
  const busy = registry.preparing && registry.index?.state?.phase === 'ready'
  const longFailure = failure.length > 28
  const status = failure ? (longFailure ? '无法打开命令，详情见结果区' : failure)
    : busy ? (registry.indexReason || '命令正在准备')
    : registry.indexReason || (registered.length ? registered.length + ' 项命令' : '没有匹配命令')
  return <dialog ref={host} data-element="M51.palette" className="m51-palette" aria-modal="true"
    aria-labelledby="M51.title" onCancel={event => event.preventDefault()} onKeyDown={key}>
    <header data-element="M51.head">
      <h2 id="M51.title" data-element="M51.title">命令</h2>
      <button type="button" ref={exit} data-element="M51.close" aria-label="关闭命令面板" title="关闭命令面板" onClick={close}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>
      </button>
    </header>
    <div data-element="M51.queryBand">
      <label htmlFor="M51.query" data-element="M51.queryLabel">查找命令</label>
      <input ref={input} id="M51.query" data-element="M51.query" role="combobox" autoComplete="off" spellCheck={false}
        aria-controls="M51.results" aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeId && rowId(activeId)}
        placeholder="输入命令名称" value={typed}
        onCompositionStart={() => { composing.current = true; generation.current++ }}
        onCompositionEnd={event => { composing.current = false; setTyped(event.currentTarget.value); update(event.currentTarget.value) }}
        onChange={event => { const value = event.target.value; setTyped(value); if (!composing.current) update(value) }}/>
    </div>
    <div data-element="M51.results" data-scroll-element="M51.scroll" id="M51.results" role="listbox" aria-label="命令结果">
      {longFailure && <p data-element="M51.empty">{failure}</p>}
      {registered.map(row => {
        const [id, label, description] = row.definition
        return <div key={id} id={rowId(id)} data-element={rowId(id)} className="m51-row" role="option"
          aria-selected={id === activeId} aria-disabled={!!row.entry.reason}
          onMouseDown={event => event.preventDefault()} onClick={() => execute(row, true)}>
          <span className="m51-marker" data-element={rowId(id)+'.marker'} aria-hidden="true"/>
          <span className="m51-label" data-element={rowId(id)+'.label'}>{label}</span>
          <span className="m51-reason" data-element={rowId(id)+'.reason'}>{row.entry.reason || description}</span>
        </div>
      })}
      {!registered.length && !longFailure && <p data-element="M51.empty">{busy ? '命令正在准备' : '没有匹配命令。请修改查询。'}</p>}
    </div>
    <footer data-element="M51.tail">
      <div role="status" aria-live="polite" data-element="M51.status">{status}</div>
      <div data-element="M51.keys"><div>↑↓ 选择 Enter 打开</div><div>Tab 切换 Esc 关闭</div></div>
    </footer>
  </dialog>
}
