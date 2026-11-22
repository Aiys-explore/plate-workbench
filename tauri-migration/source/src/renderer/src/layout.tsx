import { useCallback, useState } from 'react'
import { ActivityRail, viewLabels } from './components/activity-rail'
import { IconBrain, IconInspector, IconSearch } from './components/icons'
import { IconAction } from './icon-action'
import { openCommandPalette } from './palette'
import { usePaletteOwner } from './palette-registry'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'
import { useWorkbench } from './store'
import { LibraryAndLogsView } from './views/library-and-logs-view'
import { SettingsView } from './views/settings-view'
import { WorkbenchView, type WorkbenchHeader } from './views/workbench-view'
import { SkillsView } from './views/skills-view'
import './styles/workbench-shell.css'

export function Layout({ openAgentSettings }: { openAgentSettings: () => void }) {
  const index = useNoteIndex()
  const active = useWorkbench(state => state.activeView)
  const navigate = useWorkbench(state => state.setActiveView)
  const inspector = useWorkbench(state => state.inspectorOpen)
  const toggleInspector = useWorkbench(state => state.toggleInspector)
  const pending = useWorkbench(state => state.pendingDiffCount)
  const [libraryTab, setLibraryTab] = useState<'notes' | 'logs'>('notes')
  const [workbenchHeader, setWorkbenchHeader] = useState<WorkbenchHeader>({ activated: 0 })
  const openLogs = useCallback(() => {
    setLibraryTab('logs')
    navigate('library')
  }, [navigate])
  const switchBrain = useCallback((open: boolean) => {
    if (!open) setLibraryTab('notes')
    navigate(open ? 'brain' : 'library')
  }, [navigate])
  usePaletteOwner('layout', {
    index: { state: index.state, error: index.error },
    actions: { 'm51.agent.show': { run: () => { openAgentSettings() } } },
  })
  if (index.state?.phase !== 'ready') return <NoteIndexNotice {...index}/>

  const library = active === 'library'
  const logsVisible = library && libraryTab === 'logs'
  const notesVisible = active === 'brain' || (library && !logsVisible)
  return <div className="s10-shell">
    <ActivityRail/>
    <div className="s10-frame">
      <header className="s10-header">
        <div className="s10-header-title">
          <strong>{(active === 'workbench' && workbenchHeader.title) || viewLabels[active]}</strong>
          {active === 'workbench' && workbenchHeader.activated > 0 && <span className="s10-activated-memory">
            <IconBrain size={14} strokeWidth={1.65} aria-hidden="true"/>已激活 {workbenchHeader.activated} 条记忆
          </span>}
        </div>
        <div className="s10-header-actions">
          <IconAction icon={IconSearch} label="命令面板" shortcut="Ctrl+P" className="s10-palette-entry" onClick={openCommandPalette}/>
          {active === 'workbench' && <IconAction icon={IconInspector} label="暂存审阅" active={inspector}
            aria-expanded={inspector} badge={pending} onClick={toggleInspector}/>}
        </div>
      </header>
      <div className="s10-main">
        <div className="s10-library" data-library={library}>
          {library && <div className="s10-library-tabs" role="group" aria-label="资料与记录">
            <button type="button" aria-pressed={!logsVisible} onClick={() => setLibraryTab('notes')}>本地笔记库</button>
            <button type="button" aria-pressed={logsVisible} onClick={() => setLibraryTab('logs')}>本机 Agent 记录</button>
          </div>}
          <div className="s10-notes" hidden={!notesVisible}>
            <NotesWorkspace key={index.state.run} hudRight={null} brainOpen={active === 'brain'} onBrainOpenChange={switchBrain}/>
          </div>
          {logsVisible && <main className="s10-page"><LibraryAndLogsView/></main>}
        </div>
        <main className="s10-page" hidden={active !== 'workbench'}>
          <WorkbenchView visible={active === 'workbench'} onHeaderChange={setWorkbenchHeader} openLogs={openLogs}/>
        </main>
        {(active === 'settings' || active === 'skills') && <main className="s10-page">
          {active === 'settings' && <SettingsView openAgentSettings={openAgentSettings}/>}
          {active === 'skills' && <SkillsView/>}
        </main>}
      </div>
    </div>
  </div>
}
