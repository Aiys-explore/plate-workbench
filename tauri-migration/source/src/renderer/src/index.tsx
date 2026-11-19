import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { WorkbenchApi } from '../../shared/ipc'
import { PaletteHost } from './palette'
import { focus, PaletteRegistry, RegistryContext, target, usePaletteOwner, type Source } from './palette-registry'
import { Layout } from './layout'
import { HelpDialog } from './help'
import { StartupGate } from './startup'
import { useWorkbench } from './store'
import { AgentSettingsDialog, useAgentSettingsEntry } from './agent-settings-dialog'
import './styles/tokens.css'
import './styles/light.css'
import './styles/dark.css'
import './styles/workbench.css'
import './styles/agent-settings.css'
import './styles/agent-settings-dialog.css'
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
import './styles/map-workspace.css'
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

function Workbench({ registry, notePath }: { registry: PaletteRegistry; notePath: string }) {
  const theme = useWorkbench((state) => state.theme)
  const toggleTheme = useWorkbench((state) => state.toggleTheme)
  const [helpOrigin, setHelpOrigin] = useState<Source>()
  const [agentSettings, setAgentSettings] = useState(false)
  const openSettings = useCallback(() => setAgentSettings(true), [])
  useAgentSettingsEntry(openSettings)
  const [paletteBound, setPaletteBound] = useState(false)
  const shell = useRef<HTMLDivElement>(null)
  const fallback = () => shell.current?.querySelector<HTMLElement>('.plate-map-search-entry') ?? null
  const forButton = (element: HTMLElement): Source => ({ element, restore: () => { if (!focus(element)) focus(fallback()) } })
  const openHelp = (source: Source) => setHelpOrigin(source)
  const [agentCount, setAgentCount] = useState<number>()
  usePaletteOwner('app', { actions: {
    'm51.theme.toggle': { run: toggleTheme },
    'm51.help.open': { run: source => { openHelp(source); return target('.p13-help[open] h2') } },
  } })

  useEffect(() => {
    let sequence = 0
    const refresh = async () => {
      const request = ++sequence
      try {
        const agents = await window.workbench.agentPlugins.active()
        if (request === sequence) setAgentCount(agents.length)
      } catch {
        if (request === sequence) setAgentCount(undefined)
      }
    }
    const unsubscribe = window.workbench.agentPlugins.onChange(refresh)
    void refresh()
    return () => { sequence++; unsubscribe() }
  }, [agentSettings])

  const controls = <>
    <button type="button" className="plate-agent-settings-entry" aria-haspopup="dialog"
      onClick={openSettings}>Agent 设置{agentCount === undefined ? '' : ' · ' + agentCount}</button>
    <button type="button" onClick={toggleTheme}
      title={theme === 'light' ? '切换至深色主题' : '切换至浅色主题'}
      aria-label={theme === 'light' ? '切换至深色主题' : '切换至浅色主题'}>
      {theme === 'light' ? '◐ 深色' : '◑ 浅色'}
    </button>
    <button type="button" data-element="P13.entry.help"
      aria-label="帮助" title="帮助" aria-haspopup="dialog" onClick={event => openHelp(forButton(event.currentTarget))}>?</button>
  </>
  return (
    <div className="shell plate-ui plate-map-shell" ref={shell}>
      <Layout hudRight={controls} openAgentSettings={openSettings}/>
      {helpOrigin && <HelpDialog notePath={notePath} restore={helpOrigin.restore} paletteBound={paletteBound} readAppInfo={window.workbench.getAppInfo} onClose={() => setHelpOrigin(undefined)}/>}
      {agentSettings && <AgentSettingsDialog onClose={() => setAgentSettings(false)}/>}
      <PaletteHost registry={registry} shell={shell} fallback={fallback} binding={setPaletteBound}/>
    </div>
  )
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

