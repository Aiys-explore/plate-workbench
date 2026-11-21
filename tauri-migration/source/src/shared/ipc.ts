import type { BrainApi, BrainDelta } from './brain'
import type { AgentLogsApi, ProviderApi } from './harness'
import type { StartupApi } from './startup'
import type { AgentsApi } from './agents'
import type { AgentPluginsApi } from './agent-plugins'
import type { SessionsApi } from './sessions'
import type { DelegationDiagnosticApi } from './delegation-diagnostic'
import type { DelegationApi } from './delegation'
import type { CollaborationApi } from './collaboration'
import type { BoardApi } from './plate-board'
import type { PlateTerminalApi } from './plate-terminal/contract'

import type { P10Api } from './p10'
import type { ResumeApi } from './resume'
import type { P12Api } from './p12'
import type { P11Api } from './p11'
import type { NoteIndexApi } from './note-index'

export const IPC = {
  p10List: 'p10:list',
  p11: 'p11:request',
  p12: 'p12:request',
  p10Act: 'p10:act',
  resumeReview: 'resume:review',
  resumeAct: 'resume:act',
  resumeClose: 'resume:close',
  agentList: 'agents:list',
  agentSave: 'agents:save',
  agentRemove: 'agents:remove',
  agentDiscover: 'agents:discover',
  agentCancelDiscover: 'agents:cancel-discover',
  agentSetEnabled: 'agents:set-enabled',
  agentProbe: 'agents:probe',
  diagnosticOpen: 'delegation:diagnostic-open',
  diagnosticCopy: 'delegation:diagnostic-copy',
  diagnosticClose: 'delegation:diagnostic-close',
  delegationContext: 'delegation:context',
  delegationAddAnchor: 'delegation:add-anchor',
  delegationSubmit: 'delegation:submit',
  delegationStart: 'delegation:start',
  delegationReview: 'delegation:review',
  delegationReconcile: 'delegation:reconcile',
  delegationDiscardReservation: 'delegation:discard-reservation',
  delegationStatus: 'delegation:status',
  delegationCancel: 'delegation:cancel',
  delegationCopyHandoff: 'delegation:copy-handoff',
  delegationFindHandoff: 'delegation:find-handoff',
  delegationLinkHandoff: 'delegation:link-handoff',
  sessionList: 'sessions:list',
  sessionDashboard: 'sessions:dashboard',
  sessionUsage: 'sessions:usage',
  sessionManualLimit: 'sessions:manual-limit',
  sessionMessages: 'sessions:messages',
  sessionMessagePage: 'sessions:message-page',
  appInfo: 'app:info',
  nativeDialogStatus: 'window:native-dialog-status',
  nativeDialogChanged: 'window:native-dialog-changed',
  create: 'notes:create',
  read: 'notes:read',
  update: 'notes:update',
  delete: 'notes:delete',
  list: 'notes:list',
  links: 'notes:links',
  search: 'notes:search',
  tags: 'notes:tags',
  draftList: 'drafts:list',
  draftWrite: 'drafts:write',
  draftDiscard: 'drafts:discard',
  draftRestore: 'drafts:restore',
  draftSaveCopy: 'drafts:save-copy',
  bitmap: 'notes:bitmap',
  openLink: 'notes:open-link',
  projects: 'projects:list',
  createProject: 'projects:create',
  changed: 'notes:changed',
  noteIndex: 'notes:index',
  noteIndexProgress: 'notes:index-progress',
  collabOverview: 'collab:overview',
  collabCreateTask: 'collab:create-task',
  collabAddSlot: 'collab:add-slot',
  collabRenameRole: 'collab:rename-role',
  collabPrepareReview: 'collab:prepare-review',
  collabPrepareHandoff: 'collab:prepare-handoff',
  collabConfirmRequest: 'collab:confirm-request',
  collabCancelRequest: 'collab:cancel-request',
  collabCopyRequestText: 'collab:copy-request-text',
  boardOpen: 'board:open',
  boardSave: 'board:save'
} as const

export const DEFAULT_PROJECT = 'default'

export interface ProjectSummary {
  id: string
  name: string
  archivedAt: number | null
  color?: string
  revision?: number
}

export const NOTE_TEMPLATES = {
  blank: { label: '空白笔记', body: '' },
  plan: { label: '计划', body: '## 目标\n\n## 步骤\n\n- [ ] \n\n## 截止日期\n' },
  review: { label: '复盘', body: '## 结果\n\n## 做得好的地方\n\n## 下一步改进\n' },
  journal: { label: '日记', body: '## 今天发生了什么\n\n## 感想\n\n## 明天想做的事\n' }
} as const
export type NoteTemplate = keyof typeof NOTE_TEMPLATES

export interface NoteSummary {
  id: string
  path: string
  title: string
  projectId: string
  kind: 'note' | 'conflict'
  createdAt: number
  updatedAt: number
}

export interface Note extends NoteSummary {
  content: string
  revision: string
}

export interface NoteEdge { source: string; target: string }
export interface LinkBinding { source: string; ref: string; target: string | null }
export type RelationshipNote = NoteSummary & { preview?: string; tags?: string[] }
export interface LinkIndex { nodes: RelationshipNote[]; edges: NoteEdge[]; bindings: LinkBinding[]; removedRefs?:string[] }

export interface NoteFilters {
  projectId?: string
  kind?: NoteSummary['kind']
  tag?: string
  tags?: string[]
  query?: string
  linksTo?: string
  linkedFrom?: string
}

export interface SearchMatch { field: 'title' | 'body'; before: string; match: string; after: string }
export interface SearchResult { note: NoteSummary; match?: SearchMatch }
export interface DraftSummary {
  id: string
  title: string
  path: string
  revision: string
  version: string
  writtenAt: number
  source: 'unchanged' | 'changed' | 'missing' | 'unavailable' | 'same-content'
}
export type DraftRecovery = { status: 'restored'; note: Note; content: string; version: string }
  | { status: 'preview'; draft: DraftSummary; content: string; diskRevision: string | null }
  | { status: 'missing' }

export type SaveResult = { status: 'saved'; note: Note }
  | { status: 'conflict'; current: Note | null; copy: Note }

export interface GraphLayoutEntry {
  x: number
  y: number
  pinned: boolean
  parentNoteId: string | null
  collapsed?: boolean
}

export interface GraphLayoutApi {
  getAll(): Promise<Record<string, GraphLayoutEntry>>
  saveBatch(items: { noteId: string; x: number; y: number; pinned: boolean; parentNoteId?: string | null }[]): Promise<void>
  setCollapsed(noteId: string, collapsed: boolean): Promise<void>
  resetAll(): Promise<void>
  connectNodes(sourceId: string, targetId: string, downstream?: boolean): Promise<Note>
}

export type TaskState = 'TODO' | 'DOING' | 'PENDING' | 'DONE' | 'ERROR'

export interface TaskRunCard {
  taskId: string
  noteId: string
  agentId: string
  state: TaskState
  pendingKind: 'review_ready' | 'approval_needed' | null
  promptText: string
  outputDraft: string
  memoryDelta?: BrainDelta
  logTail: string
  errorMsg: string | null
  externalSessionId: string | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  tokensUsed: number | null
  updatedAt: number
}

export interface TasksApi {
  listByNote(noteId: string): Promise<TaskRunCard[]>
  summaryByNotes(): Promise<Record<string, { todo: number; doing: number; pending: number; done: number; error: number }>>
  start(input: { noteId: string; taskId: string; promptText: string; agentSelector?: string }): Promise<TaskRunCard>
  stop(taskId: string): Promise<TaskRunCard>
  followUp(taskId: string, instruction: string): Promise<TaskRunCard>
  markDone(taskId: string): Promise<TaskRunCard>
  reject(taskId: string): Promise<TaskRunCard>
  onStateChanged(listener: (card: TaskRunCard) => void): () => void
}

export interface NotesApi {
  index: NoteIndexApi
  create(title: string, projectId: string, template?: NoteTemplate): Promise<Note>
  projects(): Promise<ProjectSummary[]>
  createProject(name: string): Promise<ProjectSummary>
  read(id: string, touch?: boolean): Promise<Note>
  update(id: string, content: string, revision?: string, draftVersion?: string): Promise<SaveResult>
  updateStrict?(id: string, content: string, revision: string): Promise<SaveResult>
  delete(id: string, revision?: string): Promise<'deleted' | 'changed'>
  list(filters?: NoteFilters): Promise<NoteSummary[]>
  links(): Promise<LinkIndex>
  search(filters: NoteFilters): Promise<SearchResult[]>
  tags(): Promise<string[]>
  draftList(): Promise<DraftSummary[]>
  draftWrite(id: string, content: string, revision: string, version?: string): Promise<boolean>
  draftDiscard(id: string, version: string): Promise<boolean>
  draftRestore(id: string): Promise<DraftRecovery>
  draftSaveCopy(id: string, version: string, expected?: { source:DraftSummary['source']; diskRevision:string|null }): Promise<Note>
  bitmap(id: string, address: string): Promise<string>
  openLink(address: string): Promise<void>
  onChanged(listener: (path: string, external: boolean) => void): () => void
}

export type NativeDialogState = { pending: boolean; sequence: number }

export interface AppInfo {
  name: string
  version: string
}

export interface AgentSettings {
  defaultAgent: string | null
  deepseekKey: 'unset' | 'saved' | 'environment'
}

export interface WorkbenchApi {
  startup: StartupApi
  agents: AgentsApi
  agentPlugins: AgentPluginsApi
  brain: BrainApi
  providers: ProviderApi
  agentLogs: AgentLogsApi
  agentSettings: {
    get(): Promise<AgentSettings>
    save(input: { defaultAgent: string | null; deepseekKey?: string; clearDeepseekKey?: boolean }): Promise<AgentSettings>
  }
  p10: P10Api
  p11: P11Api
  p12: P12Api
  resume: ResumeApi
  delegation: DelegationApi
  delegationDiagnostic: DelegationDiagnosticApi
  collaboration: CollaborationApi
  board: BoardApi
  plateTerminal: PlateTerminalApi
  sessions: SessionsApi
  graphLayout: GraphLayoutApi
  tasks: TasksApi
  getAppInfo(): Promise<AppInfo>
  nativeDialog: { status(): Promise<NativeDialogState>; onChange(listener: (state: NativeDialogState) => void): () => void }
  notes: NotesApi
}
