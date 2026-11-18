import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppInfo, WorkbenchApi } from '../../shared/ipc'
import { PaletteHost } from './palette'
import { focus, PaletteRegistry, RegistryContext, target, usePaletteOwner, type Source } from './palette-registry'
import { Layout } from './layout'
import { HelpDialog } from './help'
import { StartupGate } from './startup'
import { useWorkbench } from './store'
import { PlateWordmark } from './plate-wordmark'
import { RuntimeManager, useLocalRuntimes } from './runtime-manager'
import { HomeAgentDock } from './home-agent-dock'
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
import './styles/harness.css'
import './styles/home.css'
import './styles/plate-ui.css'
import './styles/note-drawer.css'
import { createTauriBridge } from './tauri-bridge'

declare global {
  interface Window { workbench: WorkbenchApi }
}

if (typeof window.workbench === 'undefined') {
  ;(window as unknown as { workbench: WorkbenchApi }).workbench = createTauriBridge()
}

function ReadyWorkbench({ notePath }: { notePath: string }) {
  const [registry] = useState(() => new PaletteRegistry())
  return <RegistryContext.Provider value={registry}><Workbench registry={registry} notePath={notePath}/></RegistryContext.Provider>
}

const glyph = {
  dock: 'M2.5 3.5h13v11h-13z M7 3.5v11',
  activity: 'M2.5 9h3l2-4.5 2.5 9L12 9h3.5',
}
function RailIcon({ name }: { name: keyof typeof glyph }) {
  return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor"
    strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyph[name]}/></svg>
}

function Workbench({ registry, notePath }: { registry: PaletteRegistry; notePath: string }) {
  const theme = useWorkbench((state) => state.theme)
  const toggleTheme = useWorkbench((state) => state.toggleTheme)
  const [info, setInfo] = useState<AppInfo>()
  const [view, setView] = useState<'home' | 'settings'>('home')
  const [side, setSide] = useState<'notes' | 'agent'>('notes')
  const [helpOrigin, setHelpOrigin] = useState<Source>()
  const [paletteBound, setPaletteBound] = useState(false)
  const sidebarCollapsed = useWorkbench(state => state.sidebarCollapsed)
  const agentCollapsed = useWorkbench(state => state.agentCollapsed)
  const toggleSidebar = useWorkbench(state => state.toggleSidebar)
  const toggleAgent = useWorkbench(state => state.toggleAgent)
  const shell = useRef<HTMLDivElement>(null)
  const fallback = () => shell.current?.querySelector<HTMLElement>('.plate-brand') ?? null
  const forButton = (element: HTMLElement): Source => ({ element, restore: () => { if (!focus(element)) focus(fallback()) } })
  const openHelp = (source: Source) => setHelpOrigin(source)
  const home = () => { setView('home'); setSide('notes'); window.dispatchEvent(new Event('close-workbench-drawer')) }
  const openSettings = () => setView('settings')
  const openFromDrawer = (action: () => void) => {
    window.dispatchEvent(new Event('close-workbench-drawer'))
    action()
  }
  const desktopSidebar = useMedia('(min-width: 880px)')
  const runtimes = useLocalRuntimes()
  usePaletteOwner('app', { actions: {
    'm51.theme.toggle': { run: toggleTheme },
    'm51.help.open': { run: source => { openHelp(source); return target('.p13-help[open] h2') } },
    'm51.settings.open': { run: () => { openSettings(); return target('#home-runtime-title') } }
  } })

  useEffect(() => {
    void window.workbench.getAppInfo().then(setInfo).catch(() => {
      // The header can keep its product label; the Help dialog has its own retryable read.
    })
  }, [])

  const dock = (sessions: SessionSummary[], show: (session: SessionSummary) => void) =>
    <HomeAgentDock sessions={sessions} show={show} manage={() => openFromDrawer(openSettings)}/>

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
          onClick={home}><PlateWordmark /></button>
        {view === 'settings' && <button type="button" className="plate-place" aria-label="返回笔记首页" onClick={home}>返回首页</button>}
        {info && <span className="version" title={info.version}>v{info.version}</span>}
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
          <div className="home-document-host">
            <Layout side={side} onSide={setSide} dock={dock}
              bottom={<nav className="plate-sidebar-bottom" aria-label="工作台入口">
                <button type="button" aria-label="Agent 管理" onClick={() => openFromDrawer(openSettings)}>
                  <RailIcon name="activity"/> 插件中心</button>
              </nav>}/>
          </div>
          {view === 'settings' && <RuntimeManager runtimes={runtimes}/>}
        </div>
      </div>
      {helpOrigin && <HelpDialog notePath={notePath} restore={helpOrigin.restore} paletteBound={paletteBound} readAppInfo={window.workbench.getAppInfo} onClose={() => setHelpOrigin(undefined)}/>}
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
  if (typeof window.workbench === 'undefined') {
    return (
      <div style={{
        display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 8, fontFamily: 'system-ui', color: '#59616d'
      }}>
        <strong style={{ fontSize: 20, color: '#202329' }}>Plate · Tauri S1 壳层</strong>
        <span>WebView 窗口已启动，React 根节点加载正常。</span>
        <span>数据桥接层（window.workbench）将在 S2 接入，本阶段为脚手架占位。</span>
      </div>
    )
  }
  const theme = useWorkbench(state => state.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light')
    document.documentElement.classList.toggle('theme-dark', theme === 'dark')
  }, [theme])
  return <StartupGate workbench={path => <ReadyWorkbench notePath={path}/>}/>
}

createRoot(document.getElementById('root')!).render(<App />)

