import { useState, type ReactNode } from 'react'
import { ActivityRail } from './components/activity-rail'
import { usePaletteOwner } from './palette-registry'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'
import { useWorkbench } from './store'
import { LibraryAndLogsView } from './views/library-and-logs-view'
import { SettingsView } from './views/settings-view'
import { WorkbenchView } from './views/workbench-view'
import './styles/s10-shell.css'

export function Layout({ hudRight, openAgentSettings }: { hudRight: ReactNode; openAgentSettings: () => void }) {
  const index = useNoteIndex()
  const active = useWorkbench(state => state.activeView)
  const navigate = useWorkbench(state => state.setActiveView)
  const [libraryTab, setLibraryTab] = useState<'notes' | 'logs'>('notes')
  usePaletteOwner('layout', {
    index: { state: index.state, error: index.error },
    actions: { 'm51.agent.show': { run: () => { openAgentSettings() } } },
  })
  if (index.state?.phase !== 'ready') return <NoteIndexNotice {...index}/>

  const library = active === 'library'
  const logsVisible = library && libraryTab === 'logs'
  const notesVisible = active === 'brain' || (library && !logsVisible)
  const switchBrain = (open: boolean) => {
    if (!open) setLibraryTab('notes')
    navigate(open ? 'brain' : 'library')
  }
  return <div className="s10-shell">
    <ActivityRail/>
    <div className="s10-main">
      <div className="s10-library" data-library={library}>
        {library && <div className="s10-library-tabs" role="group" aria-label="资料与记录">
          <button type="button" aria-pressed={!logsVisible} onClick={() => setLibraryTab('notes')}>本地笔记库</button>
          <button type="button" aria-pressed={logsVisible} onClick={() => setLibraryTab('logs')}>本机 Agent 记录</button>
        </div>}
        <div className="s10-notes" hidden={!notesVisible}>
          <NotesWorkspace key={index.state.run} hudRight={hudRight} brainOpen={active === 'brain'}
            onBrainOpenChange={switchBrain}/>
        </div>
        {logsVisible && <main className="s10-page"><LibraryAndLogsView/></main>}
      </div>
      {!notesVisible && !logsVisible && <main className="s10-page">
        <div className="s10-controls">{hudRight}</div>
        {active === 'settings' && <SettingsView openAgentSettings={openAgentSettings}/>}
        {active === 'workbench' && <WorkbenchView/>}
        {active === 'skills' && <section className="s10-content" aria-label="技能">
          <h1>技能</h1>
          <button type="button" onClick={() => navigate('brain')}>在大脑中管理技能</button>
        </section>}
      </main>}
    </div>
  </div>
}
