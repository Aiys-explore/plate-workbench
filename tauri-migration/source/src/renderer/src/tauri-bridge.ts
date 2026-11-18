import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  DraftRecovery, DraftSummary, GraphLayoutApi, GraphLayoutEntry, LinkIndex,
  Note, NoteFilters, NotesApi, NoteSummary, ProjectSummary, SaveResult,
  SearchResult, TasksApi, TaskRunCard, WorkbenchApi, AppInfo, NativeDialogState,
} from '../../shared/ipc'
import type { StartupApi, StartupState } from '../../shared/startup'
import type { NoteIndexApi, NoteIndexState } from '../../shared/note-index'

// S2 桥接层：notes/startup/appInfo/graphLayout 走真实 Rust 命令；
// 其余模块（agents/p10/p11/p12/resume/delegation/collaboration/board/plateTerminal/sessions）
// 在 S3/S5 迁移前统一返回显式拒绝，避免静默假数据。
function stubGroup(group: string): unknown {
  return new Proxy({}, {
    get(_target, prop) {
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`「${group}.${String(prop)}」将在 S3/S5 迁移后可用`))
    }
  })
}

function createStartupApi(): StartupApi {
  const read = () => invoke<StartupState>('startup_state')
  return {
    state: read,
    suggest: read,
    browse: () => Promise.reject(new Error('目录选择器将在 S3 接入，请先使用默认建议')),
    submit: (token: string) => invoke<StartupState>('startup_submit', { token }),
    rebuild: (token: string) => invoke<StartupState>('startup_rebuild', { token }),
    retry: read,
    continue: read,
    exit: () => invoke<void>('startup_exit'),
  }
}

function createNotesApi(): NotesApi {
  const api: NotesApi = {
    index: {
      status: () => Promise.resolve<NoteIndexState>({ phase: 'ready', run: 1, sequence: 1 }),
      cancel: () => Promise.reject(new Error('笔记索引重扫在 S2 为全量同步执行，无需取消')),
      retry: () => Promise.reject(new Error('笔记索引重扫在 S2 为全量同步执行，无需重试')),
      onProgress: () => () => undefined,
    } satisfies NoteIndexApi,
    create: (title, projectId, template) => invoke<Note>('notes_create', { title, projectId, template }),
    projects: () => invoke<ProjectSummary[]>('projects_list'),
    createProject: (name) => invoke<ProjectSummary>('projects_create', { name }),
    read: (id) => invoke<Note>('notes_read', { id }),
    update: (id, content, revision, draftVersion) => invoke<SaveResult>('notes_update', { id, content, revision, draftVersion }),
    delete: (id, revision) => invoke<'deleted' | 'changed'>('notes_delete', { id, revision }),
    list: (filters) => invoke<NoteSummary[]>('notes_list', { filters: filters ?? null }),
    links: () => invoke<LinkIndex>('notes_links'),
    search: (filters) => invoke<SearchResult[]>('notes_search', { filters }),
    tags: () => invoke<string[]>('notes_tags'),
    draftList: () => invoke<DraftSummary[]>('drafts_list'),
    draftWrite: (id, content, revision, version) => invoke<boolean>('drafts_write', { id, content, revision, version }),
    draftDiscard: (id, version) => invoke<boolean>('drafts_discard', { id, version }),
    draftRestore: (id) => invoke<DraftRecovery>('drafts_restore', { id }),
    draftSaveCopy: (id, version) => invoke<Note>('drafts_save_copy', { id, version }),
    bitmap: () => Promise.reject(new Error('位图导出将在后续阶段迁移')),
    openLink: () => Promise.reject(new Error('外部链接打开将在后续阶段迁移')),
    onChanged: (listener) => {
      let off: (() => void) | undefined
      void listen<{ path: string; external: boolean }>('notes:changed', (event) => {
        listener(event.payload.path, event.payload.external)
      }).then(unlisten => { off = unlisten })
      return () => { off?.() }
    },
  }
  return api
}

function createGraphLayoutApi(): GraphLayoutApi {
  return {
    getAll: () => invoke<Record<string, GraphLayoutEntry>>('graph_layout_get_all'),
    saveBatch: (items) => invoke<void>('graph_layout_save_batch', { items }),
    resetAll: () => invoke<void>('graph_layout_reset'),
    connectNodes: (sourceId, targetId) => invoke<Note>('graph_layout_connect_nodes', { sourceId, targetId }),
  }
}

function createTasksApi(): TasksApi {
  return {
    listByNote: (noteId) => invoke<TaskRunCard[]>('tasks_list_by_note', { noteId }),
    summaryByNotes: () => invoke<Record<string, { todo: number; doing: number; pending: number; done: number; error: number }>>('tasks_summary'),
    start: (input) => invoke<TaskRunCard>('tasks_start', {
      taskId: input.taskId, noteId: input.noteId, promptText: input.promptText,
      agentSelector: input.agentSelector ?? null,
    }),
    stop: (taskId) => invoke<TaskRunCard>('tasks_stop', { taskId }),
    followUp: (taskId, instruction) => invoke<TaskRunCard>('tasks_follow_up', { taskId, instruction }),
    markDone: (taskId) => invoke<TaskRunCard>('tasks_mark_done', { taskId }),
    reject: (taskId) => invoke<TaskRunCard>('tasks_reject', { taskId }),
    onStateChanged: (listener) => {
      let live = true
      const registered = listen<TaskRunCard>('task:state-changed', (event) => {
        if (live) listener(event.payload)
      })
      return () => { live = false; void registered.then((fn) => fn()) }
    },
  }
}

export function createTauriBridge(): WorkbenchApi {
  return {
    startup: createStartupApi(),
    notes: createNotesApi(),
    graphLayout: createGraphLayoutApi(),
    tasks: createTasksApi(),
    getAppInfo: () => invoke<AppInfo>('app_info'),
    nativeDialog: {
      status: () => Promise.resolve<NativeDialogState>({ pending: false, sequence: 0 }),
      onChange: () => () => undefined,
    },
    agents: stubGroup('agents') as WorkbenchApi['agents'],
    p10: stubGroup('p10') as WorkbenchApi['p10'],
    p11: stubGroup('p11') as WorkbenchApi['p11'],
    p12: stubGroup('p12') as WorkbenchApi['p12'],
    resume: stubGroup('resume') as WorkbenchApi['resume'],
    delegation: stubGroup('delegation') as WorkbenchApi['delegation'],
    delegationDiagnostic: stubGroup('delegationDiagnostic') as WorkbenchApi['delegationDiagnostic'],
    collaboration: stubGroup('collaboration') as WorkbenchApi['collaboration'],
    board: stubGroup('board') as WorkbenchApi['board'],
    plateTerminal: stubGroup('plateTerminal') as WorkbenchApi['plateTerminal'],
    sessions: stubGroup('sessions') as WorkbenchApi['sessions'],
  }
}

