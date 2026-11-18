import type { ReactNode } from 'react'
import { usePaletteOwner } from './palette-registry'
import { NotesWorkspace } from './notes-workspace'
import { NoteIndexNotice, useNoteIndex } from './note-index-status'

export function Layout({ hudRight, openAgentSettings }: { hudRight: ReactNode; openAgentSettings: () => void }) {
  const index = useNoteIndex()
  usePaletteOwner('layout', {
    index: { state: index.state, error: index.error },
    actions: { 'm51.agent.show': { run: () => { openAgentSettings() } } },
  })
  return index.state?.phase === 'ready'
    ? <NotesWorkspace key={index.state.run} hudRight={hudRight}/>
    : <NoteIndexNotice {...index}/>
}
