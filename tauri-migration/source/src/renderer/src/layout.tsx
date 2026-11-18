import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentProfile } from '../../shared/agents'
import { commandLayer, focus, target, usePaletteOwner, type Source } from './palette-registry'
import { useWorkbench } from './store'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'

function LocalAgents() {
  const [agents, setAgents] = useState<AgentProfile[]>()
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.workbench.agents.list().then(rows => {
      if (live) { setAgents(rows); setError('') }
    }, () => { if (live) setError('读取本机 Agent 失败，请重试。') })
    return () => { live = false }
  }, [attempt])
  return <section className="home-agent-dock" aria-labelledby="local-agents-title">
    <div className="home-agent-dock-heading">
      <h3 id="local-agents-title" tabIndex={-1}>本机 Agent</h3>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>刷新</button>
    </div>
    {error ? <p role="status">{error}</p> : !agents ? <p>正在查找…</p>
      : agents.length ? <ul>{agents.map(agent => <li key={agent.id}>{agent.name}</li>)}</ul>
        : <p>安装支持的 Agent 后，点击刷新。</p>}
  </section>
}

export function Layout() {
  const noteIndex = useNoteIndex()
  const sidebar = useWorkbench(state => state.sidebarCollapsed)
  const sidebarWidth = useWorkbench(state => state.sidebarWidth)
  const setSidebarWidth = useWorkbench(state => state.setSidebarWidth)
  const [width, setWidth] = useState(innerWidth)
  const [drawer, setDrawer] = useState(false)
  const drawerHost = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<() => void>(undefined)
  const compact = width < 880
  const band = width >= 1440 ? 'wide' : compact ? 'compact' : 'desktop'
  const left = sidebar ? 0 : Math.max(224, Math.min(sidebarWidth, 256, width - 480))
  const notesReady = noteIndex.state?.phase === 'ready'
  const ready = useRef(notesReady)
  ready.current = notesReady

  function openDrawer(source?: Source) {
    if (!ready.current) return
    const opener = document.activeElement
    returnFocus.current = source?.restore ?? (() => {
      if (!(opener instanceof HTMLElement && focus(opener))) {
        focus(document.querySelector<HTMLElement>('.plate-sidebar-toggle'))
      }
    })
    setDrawer(true)
  }
  function closeDrawer(restore = true) {
    const previous = returnFocus.current
    returnFocus.current = undefined
    setDrawer(false)
    if (restore && previous) requestAnimationFrame(previous)
  }
  useEffect(() => {
    const resize = () => setWidth(innerWidth)
    const open = () => openDrawer()
    window.addEventListener('resize', resize)
    window.addEventListener('open-notes-drawer', open)
    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('open-notes-drawer', open)
    }
  }, [])
  useLayoutEffect(() => {
    if (!drawer) return
    if (!compact) { closeDrawer(); return }
    const dialog = drawerHost.current
    if (!dialog) return
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[aria-label="关闭笔记栏"]')?.focus()
    return () => dialog.close()
  }, [drawer, compact])

  const searchNotes = (source?: Source) => {
    if (compact && !drawer) openDrawer(source)
    else if (!compact && useWorkbench.getState().sidebarCollapsed) useWorkbench.getState().toggleSidebar()
  }
  const searchTarget = target('.notes-sidebar input[type=search]')
  usePaletteOwner('layout', { index: { state: noteIndex.state, error: noteIndex.error }, drawer,
    actions: { 'm51.agent.show': { allowed: () => notesReady,
      run: source => { searchNotes(source); return target('#local-agents-title') } } }
  })
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
          !event.ctrlKey || event.altKey || event.metaKey || commandLayer() ||
          document.querySelector('dialog[open]:not(.workbench-drawer),[role=menu]')) return
      const key = event.key.toLowerCase()
      if (event.code === 'Backslash' && !event.shiftKey) {
        event.preventDefault()
        if (drawer) closeDrawer()
        else if (compact) openDrawer()
        else useWorkbench.getState().toggleSidebar()
      } else if (key === 'f') {
        if (!event.shiftKey && event.target instanceof HTMLElement && event.target.closest('input,select,textarea,[contenteditable=true]')) return
        event.preventDefault()
        searchNotes()
        requestAnimationFrame(() => focus(searchTarget.element()))
      } else if (key === 't' && event.shiftKey && !drawer) {
        event.preventDefault()
        useWorkbench.getState().toggleTheme()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [compact, drawer])
  return <div className="layout" data-band={band} data-harness-side="notes" data-sidebar-collapsed={sidebar}
    style={{ '--left-workbench-width': left + 'px' } as CSSProperties}>
    {notesReady ? <NotesWorkspace key={noteIndex.state?.run} searchNotes={searchNotes}
      agentCounts={<LocalAgents/>}
      sidebarSplitter={!compact && <Splitter side="left" active={!sidebar} value={left} min={224} max={256} change={setSidebarWidth}/>}
      notesDrawer={compact ? { open: drawer, dialog: drawerHost, close: closeDrawer } : undefined}
    /> : <NoteIndexNotice {...noteIndex}/>}
  </div>
}

function Splitter({ side, panel = 'notes', active, value, min, max, change }: {
  side: 'left' | 'right'; panel?: 'notes' | 'agent'; active: boolean; value: number; min: number; max: number; change: (value: number) => void
}) {
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null)
  const update = (next: number) => change(Math.min(Math.max(next, min), Math.max(max, min)))
  const direction = side === 'left' ? 1 : -1
  return <div className="workbench-splitter" data-side={side} role={active ? 'separator' : undefined} tabIndex={active ? 0 : undefined}
    aria-label={active ? (panel === 'notes' ? '调整笔记栏宽度' : '调整 Agent 栏宽度') : undefined}
    aria-orientation={active ? 'vertical' : undefined} aria-valuemin={active ? min : undefined}
    aria-valuemax={active ? Math.max(min, max) : undefined} aria-valuenow={active ? Math.round(value) : undefined}
    aria-controls={active ? (panel === 'notes' ? 'sidebar-content' : 'agent-content') : undefined}
    onPointerDown={event => {
      if (!active || event.button !== 0 || !event.isPrimary || drag.current) return
      event.currentTarget.focus({preventScroll:true})
      drag.current = { x: event.clientX, width: value, pointer: event.pointerId }
      event.currentTarget.setPointerCapture(event.pointerId)
    }} onPointerMove={event => {
      if (drag.current?.pointer===event.pointerId) update(drag.current.width + direction * (event.clientX - drag.current.x))
    }} onPointerUp={event => { if (drag.current?.pointer===event.pointerId) drag.current = null }} onLostPointerCapture={event => {
      if (drag.current?.pointer===event.pointerId) { update(drag.current.width); drag.current = null }
    }} onKeyDown={event => {
      if (!active || event.nativeEvent.isComposing || event.keyCode===229) return
      if (event.key === 'Escape' && drag.current) {
        const state = drag.current
        drag.current = null
        update(state.width); event.currentTarget.releasePointerCapture(state.pointer)
      } else if (event.key === 'Home') update(min)
      else if (event.key === 'End') update(max)
      else if (event.key === 'ArrowLeft') update(value - direction * 16)
      else if (event.key === 'ArrowRight') update(value + direction * 16)
      else return
      event.preventDefault()
    }}/>
}

