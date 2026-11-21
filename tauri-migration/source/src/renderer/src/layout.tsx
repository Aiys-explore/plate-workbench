import type { ReactNode } from 'react'
import { ActivityRail } from './components/activity-rail'
import { usePaletteOwner } from './palette-registry'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'
import { useWorkbench } from './store'
import { SettingsView } from './views/settings-view'
import './styles/s10-shell.css'

export function Layout({ hudRight, openAgentSettings }: { hudRight: ReactNode; openAgentSettings: () => void }) {
  const index = useNoteIndex()
  const active = useWorkbench(state => state.activeView)
  const navigate = useWorkbench(state => state.setActiveView)
  usePaletteOwner('layout', {
    index: { state: index.state, error: index.error },
    actions: { 'm51.agent.show': { run: () => { openAgentSettings() } } },
  })
  if (index.state?.phase !== 'ready') return <NoteIndexNotice {...index}/>

  const notesVisible = active === 'brain' || active === 'library'
  return <div className="s10-shell">
    <ActivityRail/>
    <div className="s10-main">
      <div className="s10-notes" hidden={!notesVisible}>
        <NotesWorkspace key={index.state.run} hudRight={hudRight} brainOpen={active === 'brain'}
          onBrainOpenChange={open => navigate(open ? 'brain' : 'library')}/>
      </div>
      {!notesVisible && <main className="s10-page">
        <div className="s10-controls">{hudRight}</div>
        {active === 'settings' && <SettingsView openAgentSettings={openAgentSettings}/>}
        {active === 'workbench' && <section className="s10-content" aria-label="工作台">
          <h1>工作台</h1>
          <button type="button" onClick={() => navigate('brain')}>打开大脑</button>
          <button type="button" onClick={() => navigate('settings')}>配置模型服务商</button>
        </section>}
        {active === 'skills' && <section className="s10-content" aria-label="技能">
          <h1>技能</h1>
          <button type="button" onClick={() => navigate('brain')}>在大脑中管理技能</button>
        </section>}
      </main>}
    </div>
  </div>
}
