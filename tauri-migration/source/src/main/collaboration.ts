import { clipboard } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NoteStore } from './notes'
import type { BoardStore } from './board-store'
import { makeCollaborationCore, openCollabDb, type CollaborationCore, type PipeAdapter } from './collaboration-store'

// 协作存储放在当前会话的隔离 scope（独立预览用户配置）下，不写日用配置。
export class CollaborationService {
  private readonly db: ReturnType<typeof openCollabDb>
  readonly core: CollaborationCore

  constructor(scope: string, notes: NoteStore, boards: BoardStore) {
    this.db = openCollabDb(join(scope, 'collaboration.sqlite'))
    this.core = makeCollaborationCore(this.db, {
      newId: () => randomUUID(),
      now: () => Date.now(),
      readNote: (noteId) => {
        try {
          const note = notes.read(noteId)
          return note ? { id: note.id, revision: note.revision, title: note.title, content: note.content } : null
        } catch {
          return null
        }
      },
      // R2：生产解析器按板 ID、卡 ID 与实际版本核对画板卡片材料。
      resolveBoardCards: input => boards.resolveCards(input),
      copyText: (text) => clipboard.writeText(text)
    }, join(scope, 'collab-artifacts'))
  }

  registerPipeAdapter(adapter: PipeAdapter | null) {
    this.core.registerPipeAdapter(adapter)
  }

  close() {
    try {
      this.db.close()
    } catch (error) {
      console.error(error)
    }
  }
}
