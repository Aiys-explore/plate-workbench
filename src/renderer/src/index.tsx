import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppInfo, WorkbenchApi } from '../../shared/ipc'
import { PaletteHost } from './palette'
import { focus, PaletteRegistry, RegistryContext, target, usePaletteOwner, type Source } from './palette-registry'
import { Layout } from './layout'
import { HelpDialog } from './help'
import { StartupGate } from './startup'
import { useWorkbench } from './store'
import { PlateWordmark } from './plate-wordmark'
import { PlateTerminalPanel, type TerminalActivity, type TerminalIntent } from './plate-terminal/terminal-panel'
import { RuntimeManager, useLocalRuntimes } from './runtime-manager'
import { HomeAgentDock } from './home-agent-dock'
import type { Destination, Extract, Handoff } from './home-handoff'
import type { SessionSummary } from '../../shared/sessions'
import './styles/tokens.css'
import './styles/light.css'
import './styles/dark.css'
import './styles/workbench.css'
import './styles/agent-settings.css'
import './styles/agent-sessions.css'
import './styles/delegation.css'
import './styles/editor.css'
import './styles/p10.m3.3.css'
import './styles/resume.css'
import './styles/p11-m4.2-style.css'
import './styles/p11-runtime.css'
import './styles/help.css'
import './styles/palette.css'
import './styles/ux-refresh.css'
import './styles/collaboration.css'
import './styles/plate-board.css'
import './styles/harness.css'
import './styles/home.css'
import './styles/plate-ui.css'

declare global {
  interface Window { workbench: WorkbenchApi }
}

function ReadyWorkbench({ notePath }: { notePath: string }) {
  const [registry] = useState(() => new PaletteRegistry())
  return <RegistryContext.Provider value={registry}><Workbench registry={registry} notePath={notePath}/></RegistryContext.Provider>
}

const glyph = {
  doc: 'M5 2.5h6.5L15 6v9.5H5z M11 2.5V6h4 M7.5 9h5 M7.5 12h5',
  board: 'M3 3.5h12v11H3z M6 6.5h2v2H6z M10.5 9.5h2v2h-2z',
  collab: 'M4.5 6h9v7h-9z M7 6V4h4v2 M4.5 9h9',
  activity: 'M2.5 9h3l2-4.5 2.5 9L12 9h3.5',
  dock: 'M2.5 3.5h13v11h-13z M7 3.5v11',
}
function RailIcon({ name }: { name: keyof typeof glyph }) {
  return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyph[name]}/></svg>
}

function Workbench({ registry, notePath }: { registry: PaletteRegistry; notePath: string }) {
  const theme = useWorkbench((state) => state.theme)
  const toggleTheme = useWorkbench((state) => state.toggleTheme)
  const [info, setInfo] = useState<AppInfo>()
  const [view, setView] = useState<'home' | 'settings' | 'terminal'>('home')
  const [terminalVisited, setTerminalVisited] = useState(false)
  const [side, setSide] = useState<'notes' | 'agent'>('notes')
  const [slots, setSlots] = useState<TerminalActivity[]>([])
  const [intent, setIntent] = useState<TerminalIntent>()
  const [material, setMaterial] = useState<Extract>()
  const [destination, setDestination] = useState('')
  const assignmentOrigin = useRef<Source | undefined>(undefined)
  const [desktopTask, setDesktopTask] = useState<Extract>()
  const [desktopStatus, setDesktopStatus] = useState('')
  const desktopDialog = useRef<HTMLDialogElement>(null)
  const [assignmentNotice, setAssignmentNotice] = useState('')
  const [helpOrigin, setHelpOrigin] = useState<Source>()
  const [paletteBound, setPaletteBound] = useState(false)
  const sidebarCollapsed = useWorkbench(state => state.sidebarCollapsed)
  const agentCollapsed = useWorkbench(state => state.agentCollapsed)
  const toggleSidebar = useWorkbench(state => state.toggleSidebar)
  const toggleAgent = useWorkbench(state => state.toggleAgent)
  const shell = useRef<HTMLDivElement>(null)
  const settingsEntry = useRef<HTMLButtonElement>(null)
  const terminalHeading = useRef<HTMLHeadingElement>(null)
  const lastTerminalFocus = useRef<HTMLElement | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const terminalOpenedFrom = useRef<HTMLElement | null>(null)
  const desktopSidebar = useMedia('(min-width: 880px)')
  const runtimes = useLocalRuntimes()
  const available = runtimes.items.filter(item =>
    runtimes.installed.some(plugin => plugin.id === item.flavor) &&
    ((item.status === 'startable' && item.argv) || item.status === 'desktop'))
  const openZcode = () => { void window.workbench.plateTerminal.desktop().catch(error => setAssignmentNotice(String(error))) }
  const targetSlots = slots.filter(slot => runtimes.installed.some(plugin => plugin.id === slot.flavor))
  const fallback = () => shell.current?.querySelector<HTMLElement>('.plate-brand') ?? null
  const forButton = (element: HTMLElement): Source => ({ element, restore: () => { if (!focus(element)) focus(fallback()) } })
  const openHelp = (source: Source) => setHelpOrigin(source)
  const home = () => { setView('home'); setSide('notes'); window.dispatchEvent(new Event('close-workbench-drawer')) }
  const openSettings = () => setView('settings')
  const openFromDrawer = (action: () => void) => {
    window.dispatchEvent(new Event('close-workbench-drawer'))
    action()
  }
  const targetKey = (target: Destination) => target.kind === 'slot' ? 'slot:' + target.id : target.kind + ':' + target.flavor
  const restoreAssignment = () => requestAnimationFrame(() => assignmentOrigin.current?.restore())
  const closeAssignment = () => { setMaterial(undefined); restoreAssignment() }
  const closeDesktopTask = () => { setDesktopTask(undefined); restoreAssignment() }
  const open = (target?: Destination, handoff?: Handoff) => {
    if (target?.kind === 'desktop') {
      if (handoff) { setDesktopStatus(''); setDesktopTask(handoff) }
      else openZcode()
      return
    }
    if (view !== 'terminal') terminalOpenedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (target) setIntent({ id: handoff?.id ?? crypto.randomUUID(),
      ...(target.kind === 'slot' ? { slot: target.id } : { flavor: target.flavor }), handoff })
    setTerminalVisited(true)
    setView('terminal')
  }
  const returning = useRef(false)
  useLayoutEffect(() => {
    if (view === 'terminal') {
      if (!focus(lastTerminalFocus.current)) focus(terminalHeading.current)
    } else if (view === 'settings') focus(shell.current?.querySelector<HTMLElement>('#home-runtime-title'))
    else if (returning.current) {
      returning.current = false
      if (!focus(terminalOpenedFrom.current)) focus(shell.current?.querySelector<HTMLElement>('[aria-label="首页"]'))
    }
  }, [view])
  usePaletteOwner('app', { actions: {
    'm51.theme.toggle': { run: toggleTheme },
    'm51.help.open': { run: source => { openHelp(source); return target('.p13-help[open] h2') } },
    'm51.settings.open': { run: () => { openSettings(); return target('#home-runtime-title') } }
  } })
  useEffect(() => {
    const send = (event: Event) => {
      const task = (event as CustomEvent<Handoff>).detail
      if (!task?.text.trim()) return
      if (task.text.length > 8000) { setAssignmentNotice('当前任务太长，请分成不超过 8000 字符的选区'); return }
      setAssignmentNotice('')
      assignmentOrigin.current = forButton(document.activeElement as HTMLElement)
      window.dispatchEvent(new Event('close-workbench-drawer'))
      setDestination(targetKey(task.target)); setMaterial(task)
    }
    const preview = (event: Event) => {
      const input = (event as CustomEvent<Extract>).detail
      if (!input?.text.trim()) return
      if (input.text.length > 8000) { setAssignmentNotice('当前选区太长，请分成不超过 8000 字符的选区'); return }
      setAssignmentNotice('')
      assignmentOrigin.current = forButton(document.activeElement as HTMLElement)
      setDestination(''); setMaterial(input)
    }
    window.addEventListener('plate-note-handoff', send)
    window.addEventListener('plate-note-destination', preview)
    return () => {
      window.removeEventListener('plate-note-handoff', send)
      window.removeEventListener('plate-note-destination', preview)
    }
  }, [view])
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element || !material) return
    element.showModal()
    element.querySelector('h2')?.focus()
    return () => { element.close() }
  }, [material])

  useLayoutEffect(() => {
    const element = desktopDialog.current
    if (!desktopTask || !element) return
    element.showModal()
    element.querySelector('h2')?.focus()
    return () => element.close()
  }, [desktopTask])

  useEffect(() => {
    void window.workbench.getAppInfo().then(setInfo).catch(() => {
      // The header can keep its product label; the Help dialog has its own retryable read.
    })
  }, [])

  const destinations = [
    ...targetSlots.filter(slot => !slot.exited).map(slot => ({ key: 'slot:' + slot.id,
      target: { kind: 'slot', id: slot.id } as const, title: slot.label + ' · #' + slot.id,
      help: '使用 Plate 已打开的终端。你可以检查终端中准备的任务，再手动提交。' })),
    ...available.map(agent => ({ key: (agent.status === 'desktop' ? 'desktop:' : 'runtime:') + agent.flavor,
      target: agent.status === 'desktop' ? { kind: 'desktop', flavor: 'zcode' } as const : { kind: 'runtime', flavor: agent.flavor } as const,
      title: agent.displayName, help: agent.status === 'desktop' ? '打开桌面版或复制选区。请在原客户端粘贴并提交。' :
        '启动新的本机终端。任务先在终端工作台准备，由你检查后提交。' })),
  ]
  const selectedTarget = destinations.find(option => option.key === destination)
  const dock = (sessions: SessionSummary[], show: (session: SessionSummary) => void) =>
    <HomeAgentDock slots={targetSlots} available={available} sessions={sessions}
      open={target => openFromDrawer(() => open(target))} show={show} manage={() => openFromDrawer(openSettings)}/>

  return (
    <div className="shell harness-shell plate-ui" ref={shell}>
      <header className="topbar">
        {view === 'home' && <button type="button" className="icon-button plate-sidebar-toggle"
          aria-label={!desktopSidebar ? '打开笔记栏' : (side === 'agent' ? agentCollapsed : sidebarCollapsed) ? '展开左侧栏' : '收起左侧栏'}
          aria-haspopup={!desktopSidebar ? 'dialog' : undefined}
          aria-expanded={desktopSidebar ? !(side === 'agent' ? agentCollapsed : sidebarCollapsed) : undefined}
          onClick={!desktopSidebar ? () => window.dispatchEvent(new Event('open-notes-drawer')) : side === 'agent' ? toggleAgent : toggleSidebar}>
          <RailIcon name="dock"/></button>}
        <button type="button" className="plate-brand" title="首页" aria-label="首页" aria-current={view === 'home' ? 'page' : undefined}
          onClick={() => { if (view === 'terminal') returning.current = true; home() }}><PlateWordmark /></button>
        {view === 'settings' && <button type="button" className="plate-place" aria-label="返回笔记首页" onClick={home}>返回首页</button>}
        {info && <span className="version" title={info.version}>v{info.version}</span>}
        {assignmentNotice && <span role="status" className="home-assignment-notice">{assignmentNotice}</span>}
        <div className="agent-settings-actions topbar-actions">
        <button type="button" className="icon-button" onClick={toggleTheme} aria-label={theme === 'light' ? '切换至深色主题' : '切换至浅色主题'}>
          <span aria-hidden="true">{theme === 'light' ? '深色' : '浅色'}</span>
        </button>
        <button type="button" className="icon-button p13-help-entry" data-element="P13.entry.help"
          aria-label="帮助" title="帮助" aria-haspopup="dialog" onClick={event => openHelp(forButton(event.currentTarget))}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="10" cy="10" r="8"/><path d="M7.6 7.3a2.5 2.5 0 1 1 3.6 2.5c-.8.4-1.2 1-1.2 1.7m0 2.8h.01"/>
          </svg>
        </button>
        </div>
      </header>
      <div className="workbench-frame">
        <div className="workbench-main">
          <div className="home-document-host" hidden={view !== 'home'}>
            <Layout side={side} onSide={setSide} terminalSlots={slots} openTerminal={() => open()}
              dock={dock} bottom={<nav className="plate-sidebar-bottom" aria-label="工作台入口">
                <button type="button" ref={settingsEntry} aria-label="Agent 管理" onClick={() => openFromDrawer(openSettings)}>
                  <RailIcon name="activity"/> 插件中心</button>
                <button type="button" onClick={() => openFromDrawer(() => open())}><RailIcon name="collab"/> 终端</button>
              </nav>}/>
          </div>
          {view === 'settings' && <RuntimeManager runtimes={runtimes} open={agent => open({ kind: 'runtime', flavor: agent.flavor })}/>}
          {terminalVisited && <div className="collab-workspace" hidden={view !== 'terminal'}>
            <section className="collab-workspace__screen" aria-labelledby="plate-terminal-heading">
              <div className="collab-workspace__bar">
                <h2 ref={terminalHeading} id="plate-terminal-heading" tabIndex={-1}>终端工作台</h2>
                <button type="button" aria-label="返回笔记首页" onClick={() => { returning.current = true; home() }}>返回首页</button>
              </div>
              <div className="collab-workspace__terminal" onFocusCapture={event => {
                if (event.target instanceof HTMLElement) lastTerminalFocus.current = event.target
              }}><PlateTerminalPanel onActivity={setSlots} intent={intent}/></div>
            </section>
          </div>}
        </div>
      </div>
      {helpOrigin && <HelpDialog notePath={notePath} restore={helpOrigin.restore} paletteBound={paletteBound} readAppInfo={window.workbench.getAppInfo} onClose={() => setHelpOrigin(undefined)}/>}
      {material && <dialog className="home-runtime-dialog home-target-dialog" ref={dialog} aria-label="交给 Agent"
        onCancel={event => { event.preventDefault(); closeAssignment() }}>
        <form onSubmit={event => {
          event.preventDefault()
          if (!selectedTarget) return
          const { target } = selectedTarget
          const task = { ...material, id: crypto.randomUUID(), target }
          setMaterial(undefined)
          open(target, task)
        }}>
          <small className="plate-kicker">分派选区</small><h2 tabIndex={-1}>交给 Agent</h2><p>来自「{material.title}」</p><pre>{material.text}</pre>
          <label>目标 Agent <select aria-label="目标 Agent" value={destination} onChange={event => setDestination(event.target.value)}>
            <option value="">请选择</option>
            <option value="native" disabled>发到原桌面会话 · 未接通</option>
            {destinations.map(option => <option key={option.key} value={option.key}>
              {option.target.kind === 'desktop' ? '打开桌面版／复制任务' : option.target.kind === 'slot' ? '已有终端' : '打开终端'} · {option.title}</option>)}
          </select></label>
          <p className="plate-target-help">{selectedTarget?.help ?? '可选终端或桌面交接；发到原桌面会话尚未接通。'}</p>
          {!destinations.length && <button type="button" onClick={() => { setMaterial(undefined); openSettings() }}>前往插件中心</button>}
          <div className="plate-dialog-actions">
            <button type="button" onClick={closeAssignment}>取消</button>
            <button type="submit" className="button-primary" disabled={!selectedTarget}>{!selectedTarget ? '继续' :
              selectedTarget.target.kind === 'desktop' ? '继续到桌面交接' : '前往终端工作台'}</button>
          </div>
        </form>
      </dialog>}
      {desktopTask && <dialog className="home-runtime-dialog home-target-dialog" ref={desktopDialog} aria-label="ZCode 桌面版交接"
        onCancel={event => { event.preventDefault(); closeDesktopTask() }}>
        <h2 tabIndex={-1}>ZCode 桌面版</h2><p>{desktopTask.title}</p><pre>{desktopTask.text}</pre>
        <p>复制后，请到 ZCode 粘贴并提交。</p>
        <button type="button" onClick={() => void window.workbench.plateTerminal.copyDesktopTask(desktopTask.text)
          .then(() => setDesktopStatus('已复制')).catch(error => setDesktopStatus(String(error)))}>复制任务</button>
        <button type="button" onClick={() => void window.workbench.plateTerminal.desktop()
          .catch(error => setDesktopStatus(String(error)))}>打开桌面版</button>
        <button type="button" onClick={closeDesktopTask}>关闭</button>
        <p role="status">{desktopStatus}</p>
      </dialog>}
      <PaletteHost registry={registry} shell={shell} fallback={fallback} binding={setPaletteBound}/>
    </div>
  )
}

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const change = () => setMatches(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [query])
  return matches
}

function App() {
  const theme = useWorkbench(state => state.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light')
    document.documentElement.classList.toggle('theme-dark', theme === 'dark')
  }, [theme])
  return <StartupGate workbench={path => <ReadyWorkbench notePath={path}/>}/>
}

createRoot(document.getElementById('root')!).render(<App />)
