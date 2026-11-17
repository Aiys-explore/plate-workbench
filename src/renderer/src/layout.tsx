import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { SessionAdapter, SessionDashboard, SessionSummary } from '../../shared/sessions'
import { commandLayer, focus, target, usePaletteOwner, type Source } from './palette-registry'
import { useWorkbench } from './store'
import { AgentTargets, DeleteRecoveryNotice, P11Host, type BindingGuard } from './p11'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'
import { UsageDialog } from './usage-dialog'
import { ResumeConversation } from './resume'
import type { TerminalActivity } from './plate-terminal/terminal-panel'
import { SessionConversation, SessionDetail, SessionFooter, SessionPanel, useSessionDashboard, sessionAgentNames,
  type ConversationMemory, type SessionPanelMemory, type Metric } from './agent-sessions'

type AgentFilter = SessionAdapter | 'all'
function AgentPicker({value,onChange,data}: {
  value:AgentFilter; onChange:(value:AgentFilter)=>void; data?:SessionDashboard
}) {
  const picker=useRef<HTMLDetailsElement>(null)
  const summary=useRef<HTMLElement>(null)
  const options=['all',...Object.keys(sessionAgentNames)] as AgentFilter[]
  const label=(key:AgentFilter)=>key==='all'?'全部 Agent':sessionAgentNames[key]
  const close=(focus:boolean)=>{
    if(picker.current)picker.current.open=false
    if(focus)summary.current?.focus({preventScroll:true})
  }
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{
      if(picker.current?.open && event.target instanceof Node && !picker.current.contains(event.target))close(false)
    }
    document.addEventListener('pointerdown',outside)
    return()=>document.removeEventListener('pointerdown',outside)
  },[])
  return <div className="agent-rail-controls">
    <details className="agent-picker" ref={picker} onKeyDown={event=>{
      if(event.nativeEvent.isComposing || event.key!=='Escape' || !event.currentTarget.open)return
      event.preventDefault();event.stopPropagation();close(true)
    }} onBlur={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))close(false)}}>
      <summary ref={summary} aria-label={'筛选会话 · '+label(value)}>{label(value)}</summary>
      <div className="agent-picker-options" role="group" aria-label="按日志来源筛选">
        {options.map(key=><button type="button" key={key} aria-pressed={value===key} onClick={()=>{
          onChange(key)
          close(true)
        }}><span>{label(key)}</span><small>{data ? data.sessions.filter(session=>key==='all'||session.adapter===key).length : '—'}</small></button>)}
      </div>
    </details>
    <details className="agent-drop-targets"><summary>任务拖放目标</summary><AgentTargets empty/></details>
  </div>
}

function AgentPanel({ collapsed, data, failed, observedAt, reading, retry, detail, reveal, cardMemory, picker, filter, children }: {
  collapsed: boolean; data?: SessionDashboard; failed: boolean; observedAt?: number; reading:boolean; retry:()=>void
  detail: (session: SessionSummary) => void; reveal?: { key: string; control?: string }; cardMemory: React.RefObject<SessionPanelMemory>; picker:React.ReactNode; filter:AgentFilter; children?: React.ReactNode
}) {
  const toggleAgent = useWorkbench((state) => state.toggleAgent)
  return <aside className="pane agent" aria-label="Agent 面板">
    {(!children || collapsed) && <div className="pane-heading agent-heading">
      {!collapsed && <h2 tabIndex={-1} className="agent-panel-title">Agent</h2>}
      <button type="button" className="icon-button" aria-label={collapsed ? '展开 Agent 面板' : '折叠 Agent 面板'}
        title={collapsed ? '展开 Agent 面板' : '折叠 Agent 面板'}
        aria-expanded={!collapsed} aria-controls="agent-content" onClick={toggleAgent}>
        <span aria-hidden="true">{collapsed ? '展开' : '收起'}</span>
      </button>
    </div>}
    {!collapsed && !children && picker}
    {!collapsed && children ? children : <SessionPanel key={filter} collapsed={collapsed} data={data} failed={failed}
      observedAt={observedAt} reading={reading} retry={retry} detail={detail} reveal={reveal} memory={cardMemory}/>}
  </aside>
}

export function Layout({ side, onSide, terminalSlots, openTerminal, dock, bottom }: {
  side: 'notes' | 'agent'; onSide: (side: 'notes' | 'agent') => void
  terminalSlots: TerminalActivity[]; openTerminal: () => void; bottom?: React.ReactNode
  dock: (sessions: SessionSummary[], show: (session: SessionSummary) => void) => React.ReactNode
}) {
  const noteIndex=useNoteIndex()
  const [agentFilter,setAgentFilter]=useState<AgentFilter>('all')
  const changeAgentFilter=(value:AgentFilter)=>{
    cardMemory.current.anchor=undefined
    setReveal(undefined)
    setAgentFilter(value)
  }
  const notesReady=noteIndex.state?.phase==='ready'
  const bindingGuard=useRef<BindingGuard|undefined>(undefined)
  const agent = useWorkbench((state) => state.agentCollapsed)
  const sidebar = useWorkbench((state) => state.sidebarCollapsed)
  const editor = useWorkbench((state) => state.editorCollapsed)
  const expandAgent = useWorkbench((state) => state.expandAgent)
  const sidebarWidth = useWorkbench((state) => state.sidebarWidth)
  const setSidebarWidthStored = useWorkbench((state) => state.setSidebarWidth)
  const { data, failed, observedAt, reading, retry } = useSessionDashboard()
  useEffect(()=>{
    const removed=(event:Event)=>{
      const x=(event as CustomEvent<import('../../shared/p11').Subject>).detail
      if(x.kind!=='session')return
      setConversation(old=>{
        if(old?.adapter!==x.session.adapter||old.id!==x.session.id)return old
        conversationMemory.current=undefined
        return undefined
      })
    }
    window.addEventListener('p11-removed',removed)
    return()=>window.removeEventListener('p11-removed',removed)
  },[])
  const [detail, setDetail] = useState<Metric | 'usage'>()
  const [conversation, setConversation] = useState<SessionSummary>()
  const conversationOrigin = useRef('.session-expand')
  const runOrigin = useRef<HTMLElement | null>(null)
  const conversationMemory = useRef<ConversationMemory | undefined>(undefined)
  const cardMemory = useRef<SessionPanelMemory>({folded:new Set(),full:false,order:{}})
  const previousDesktop = useRef(innerWidth >= 880)
  const [reveal,setReveal] = useState<{key:string; control?:string}>()
  const [width, setWidth] = useState(innerWidth)
  const [drawer, setDrawer] = useState<'notes' | 'agent'>()
  const [leftWidth, setLeftWidth] = useState<number>()  // 临时拖拽值；落盘后由 store.sidebarWidth 承接
  const [trackMotion,setTrackMotion]=useState<'sidebar'|'agent'>()
  const drawerOrigin = useRef<HTMLElement | null>(null)
  const drawerRestore = useRef<(() => void) | undefined>(undefined)
  const drawerHost = useRef<HTMLDialogElement>(null)
  const compact = width < 880, desktop = !compact
  const band = width >= 1440 ? 'wide' : desktop ? 'desktop' : compact ? 'compact' : 'tablet'
  const left = (side === 'agent' ? agent : sidebar) ? 0 : Math.max(224, Math.min(leftWidth ?? sidebarWidth, 256, width - 480))
  const openDrawer = (name: 'notes' | 'agent', source?: Source) => {
    if (name==='notes' && !noteIndexReady.current) return
    drawerOrigin.current = source?.element ?? document.activeElement as HTMLElement
    drawerRestore.current = source?.restore
    setDrawer(name)
  }
  const noteIndexReady=useRef(notesReady)
  noteIndexReady.current=notesReady
  const closeDrawer = (restoreFocus = true) => {
    if (drawer === 'agent') {setConversation(undefined);runOrigin.current=null}
    setDrawer(undefined)
    if (!restoreFocus) { drawerRestore.current = undefined; return }
    requestAnimationFrame(() => {
      const restore = drawerRestore.current
      drawerRestore.current = undefined
      if (restore) { restore(); return }
      const origin = drawerOrigin.current
      if (origin?.getClientRects().length) origin.focus()
      else document.querySelector<HTMLElement>('.plate-sidebar-toggle')?.focus()
    })
  }
  useEffect(() => {
    const resize = () => setWidth(innerWidth)
    const openNotes = () => openDrawer('notes')
    const openAgent = () => openDrawer('agent')
    window.addEventListener('resize', resize)
    window.addEventListener('open-notes-drawer', openNotes)
    window.addEventListener('open-agent-drawer', openAgent)
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('open-notes-drawer', openNotes); window.removeEventListener('open-agent-drawer', openAgent) }
  }, [])
  useEffect(() => {
    const dismiss = () => { drawerRestore.current = undefined; setDrawer(undefined) }
    window.addEventListener('close-workbench-drawer', dismiss)
    return () => window.removeEventListener('close-workbench-drawer', dismiss)
  }, [])
  useLayoutEffect(() => { setLeftWidth(undefined) }, [band])
  const changeLeftWidth = (value: number) => { setLeftWidth(value); setSidebarWidthStored(value) }
  useEffect(()=>{
    if(!trackMotion)return
    const finish=setTimeout(()=>setTrackMotion(undefined),260)
    return()=>clearTimeout(finish)
  },[trackMotion,sidebar,agent])
  useLayoutEffect(()=>{setTrackMotion(undefined)},[width])
  useLayoutEffect(() => {
    if (!desktop && previousDesktop.current && conversation && !detail && !commandLayer()) {
      drawerOrigin.current = null
      drawerRestore.current = undefined
      setDrawer('agent')
    }
    previousDesktop.current = desktop
  },[desktop,conversation,detail])
  useLayoutEffect(() => {
    if (drawer === 'notes' && !compact || drawer === 'agent' && desktop) {
      setDrawer(undefined)
      requestAnimationFrame(() => {
        if (drawer==='agent' && conversation) {
          const host=document.querySelector('.session-conversation')
          const previous=conversationMemory.current?.control
          const target=previous && host?.querySelector<HTMLElement>(`[data-chat-control="${CSS.escape(previous)}"]:not([disabled])`)
          ;(target || host?.querySelector<HTMLElement>('h2'))?.focus({preventScroll:true})
        } else document.querySelector<HTMLElement>(drawer==='notes'?'.plate-sidebar-toggle':'.agent-heading button')?.focus()
      })
      return
    }
    const dialog = drawerHost.current
    if (!drawer || !dialog) return
    const previous=conversationMemory.current?.control
    dialog.showModal()
    const exact=previous && dialog.querySelector<HTMLElement>(`[data-chat-control="${CSS.escape(previous)}"]:not([disabled])`)
    const entry = dialog.querySelector<HTMLElement>('.session-conversation h2, [aria-label="关闭笔记栏"]')
    ;(exact || entry || dialog.querySelector<HTMLElement>('.agent-panel-title') || dialog.querySelector('button'))?.focus({preventScroll:true})
    if (drawer==='agent' && !conversation) setReveal(old=>old && {...old})
    return () => dialog.close()
  }, [drawer, compact, desktop])
  const searchNotes = (source?: Source) => {
    onSide('notes')
    const state = useWorkbench.getState()
    if (compact && !drawer) openDrawer('notes', source)
    else if (!compact && state.sidebarCollapsed) state.toggleSidebar()
  }
  const searchTarget = target('.notes-sidebar input[type=search]')
  usePaletteOwner('layout', { index: { state: noteIndex.state, error: noteIndex.error }, drawer: !!drawer, actions: {
    'm51.agent.show': { run: source => {
      onSide('agent')
      expandAgent()
      if (!desktop) openDrawer('agent', source)
      return target(desktop ? '.agent .session-conversation h2, .agent .agent-panel-title'
        : '.agent-drawer[open] .session-conversation h2, .agent-drawer[open] .agent-panel-title')
    } }
  } })
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (document.querySelector('.home-document-host[hidden]')) return
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key === 'Process' ||
        event.keyCode === 229 || !event.ctrlKey || event.altKey || event.metaKey) return
      if (commandLayer() || document.querySelector('dialog[open]:not(.workbench-drawer),[role=menu]')) return
      const key = event.key.toLowerCase()
      const slash = event.code === 'Backslash' || key === '\\'
      const target = event.target
      const state = useWorkbench.getState()
      if (drawer === 'agent' && !(slash && event.shiftKey)) return
      if (drawer === 'notes' && !(slash && !event.shiftKey) && key !== 'f') return
      if (slash) {
        event.preventDefault()
        if (drawer) closeDrawer()
        else if (event.shiftKey && !desktop) openDrawer('agent')
        else if (!event.shiftKey && compact) openDrawer('notes')
        else {
          setTrackMotion(event.shiftKey?'agent':'sidebar')
          if (event.shiftKey) {
            onSide('agent')
            if (side !== 'agent') expandAgent()
            else { state.toggleAgent(); if (!state.agentCollapsed) setConversation(undefined) }
          } else {
            onSide('notes')
            if (side === 'notes' || state.sidebarCollapsed) state.toggleSidebar()
          }
          const selector = '.plate-sidebar-toggle'
          requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus({preventScroll:true}))
        }
      } else if (key === 'f') {
        if (!event.shiftKey && target instanceof HTMLElement && target.closest('input,select,textarea,[contenteditable=true]')) return
        event.preventDefault()
        searchNotes()
        requestAnimationFrame(() => focus(searchTarget.element()))
      } else if (key === 't' && event.shiftKey && !drawer) {
        event.preventDefault()
        state.toggleTheme()
      }
    }
    window.addEventListener('keydown',shortcut)
    return () => window.removeEventListener('keydown',shortcut)
  },[compact,desktop,drawer,side,onSide,expandAgent])
  const origin = useRef<HTMLElement | null>(null)
  const open = (metric: Metric | 'usage') => { origin.current = document.activeElement as HTMLElement; setDetail(metric) }
  const close = () => { setDetail(undefined); requestAnimationFrame(() => origin.current?.focus()) }
  const displayedData=data && agentFilter!=='all' ? {...data,sessions:data.sessions.filter(s=>s.adapter===agentFilter)} : data
  const picker=<>
    <button type="button" className="plate-dock-back" onClick={() => {
      if (compact) openDrawer('notes')
      onSide('notes')
      if (!compact) requestAnimationFrame(() => document.querySelector<HTMLElement>('.plate-sidebar-toggle')?.focus())
    }}>返回笔记栏</button>
    <div className="harness-terminal-activity">
      <button type="button" onClick={openTerminal}>打开终端工作台</button>
      {!!terminalSlots.length && <ul aria-label="本机终端槽位">
        {terminalSlots.slice(0, 4).map(slot => <li key={slot.id} title={slot.label}>
          <span>{slot.label}</span><small>{slot.exited ? '已退出' : '运行中'}</small>
        </li>)}
        {terminalSlots.length > 4 && <li><small>另有 {terminalSlots.length - 4} 个槽位</small></li>}
      </ul>}
    </div>
    <AgentPicker value={agentFilter} onChange={changeAgentFilter} data={failed?undefined:data}/>
  </>
  const jump = (s: SessionSummary) => {
    onSide('agent')
    if(agentFilter!=='all' && s.adapter!==agentFilter) changeAgentFilter('all')
    runOrigin.current=null
    setDetail(undefined); expandAgent()
    setConversation(undefined)
    setReveal({key:s.adapter+':'+s.id})
    if (!desktop) openDrawer('agent')

  }
  const showConversation = (s: SessionSummary) => {
    runOrigin.current=null
    conversationOrigin.current = '.session-expand'
    conversationMemory.current = {owner:s.adapter+':'+s.id,full:false,stale:false,scroll:0}
    setConversation(s)
  }
  const backToCards = () => {
    if (runOrigin.current) {
      const target=runOrigin.current
      runOrigin.current=null
      if (!desktop) setDrawer(undefined)
      setConversation(undefined)
      requestAnimationFrame(()=>{
        if (target.isConnected) target.focus({preventScroll:true})
        else document.querySelector<HTMLElement>('[data-editor-host], .agent-panel-title')?.focus({preventScroll:true})
      })
      return
    }
    const active = conversation
    if (active) setReveal({key:active.adapter+':'+active.id,control:conversationOrigin.current})
    setConversation(undefined)
  }
  const currentConversation = conversation && data?.sessions.find(s => s.id === conversation.id && s.adapter === conversation.adapter)
  const activeConversation = currentConversation ?? conversation
  return <>
    <div className="layout" data-band={band} data-harness-side={side} data-agent-collapsed={agent} data-sidebar-collapsed={sidebar} data-editor-collapsed={editor}
      data-sidebar-motion={trackMotion==='sidebar'} data-agent-motion={trackMotion==='agent'}
      onClickCapture={event=>{
        if(!(event.target instanceof Element))return
        if(!compact && event.target.closest('.notes-sidebar .pane-toggle'))setTrackMotion('sidebar')
        else if(desktop && event.target.closest('.agent-heading button[aria-controls="agent-content"]'))setTrackMotion('agent')
      }}
      onPointerDownCapture={event=>{if(event.target instanceof Element && event.target.closest('.workbench-splitter'))setTrackMotion(undefined)}}
      style={{ '--left-workbench-width': `${left}px` } as CSSProperties}>
      <ResumeConversation.Provider value={(log,origin)=>{
        const exact=!failed && data?.sessions.find(s=>s.adapter===log.adapter && s.id===log.id && s.messageRevision===log.revision)
        if (!exact) return false
        showConversation(exact)
        onSide('agent')
        runOrigin.current=origin
        expandAgent()
        if (!desktop) openDrawer('agent')
        return true
      }}>
      {notesReady ? <NotesWorkspace key={noteIndex.state?.run} searchNotes={searchNotes} bindingGuard={bindingGuard}
        agentCounts={dock(failed ? [] : data?.sessions ?? [], s => {
          showConversation(s)
          expandAgent()
          onSide('agent')
          if (!desktop) openDrawer('agent')
        })} sidebarBottom={bottom}
        sidebarSplitter={!compact && side === 'notes' && <Splitter side="left" active={desktop && !sidebar} value={left} min={224}
          max={256} change={changeLeftWidth} />} notesDrawer={compact ? {
        open: drawer === 'notes', dialog: drawerHost, close: closeDrawer
      } : undefined}/> : <NoteIndexNotice {...noteIndex}/>}
      </ResumeConversation.Provider>
      {desktop && side === 'agent' && <>
        <Splitter side="left" panel="agent" active={!agent} value={left} min={224} max={256} change={changeLeftWidth} />
        <AgentPanel filter={agentFilter} picker={picker} collapsed={agent} data={displayedData} failed={failed} observedAt={observedAt} reading={reading} retry={retry} detail={showConversation} reveal={reveal} cardMemory={cardMemory}>
          {activeConversation && <SessionConversation session={activeConversation} available={!!currentConversation && !failed}
            back={backToCards} close={backToCards} memory={conversationMemory}/>}
        </AgentPanel>
      </>}
    </div>
    {!desktop && drawer === 'agent' && <dialog ref={drawerHost} className="workbench-drawer agent-drawer" aria-label="Agent 面板"
      onCancel={event => { event.preventDefault(); closeDrawer() }} onClick={event => { if (event.target === event.currentTarget) closeDrawer() }}>
      {activeConversation ? <SessionConversation session={activeConversation} available={!!currentConversation && !failed}
        back={backToCards} close={closeDrawer} memory={conversationMemory}/> : <>
        <div className="pane-heading"><h2 tabIndex={-1} className="agent-panel-title">Agent</h2><button type="button" onClick={() => closeDrawer()}>关闭</button></div>
        {picker}
        <SessionPanel key={agentFilter} collapsed={false} data={displayedData} failed={failed} observedAt={observedAt} reading={reading} retry={retry} detail={showConversation} reveal={reveal} memory={cardMemory}/>
      </>}
    </dialog>}
    <DeleteRecoveryNotice/>
    <P11Host sessions={data?.sessions ?? []} guard={bindingGuard}/>
    <SessionFooter data={data} failed={failed} open={open} drawer={desktop ? undefined : () => openDrawer('agent')}/>
    {detail === 'usage' ? <UsageDialog close={close}/> : detail &&
      <SessionDetail data={data} failed={failed} metric={detail} close={close} jump={jump} openUsage={() => setDetail('usage')}/>}
  </>
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
