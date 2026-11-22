import type { BrainActivationWave, BrainApi } from '../../shared/brain'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  DraftRecovery, DraftSummary, GraphLayoutApi, GraphLayoutEntry, LinkIndex,
  Note, NoteFilters, NotesApi, NoteSummary, ProjectSummary, SaveResult,
  SearchResult, TasksApi, TaskRunCard, WorkbenchApi, AppInfo, AgentSettings, NativeDialogState,
} from '../../shared/ipc'
import type { Candidate, StartupApi, StartupState } from '../../shared/startup'
import type { NoteIndexApi, NoteIndexState } from '../../shared/note-index'
import { capabilityKeys, type AgentProfile, type AgentsApi } from '../../shared/agents'
import type { AgentPluginsApi } from '../../shared/agent-plugins'

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
  let last: StartupState = { phase: 'reading' }
  const remember = async (request: Promise<StartupState>) => last = await request
  const read = () => remember(invoke<StartupState>('startup_state'))
  return {
    state: read,
    suggest: read,
    async browse() {
      const candidate = await invoke<Candidate | null>('startup_browse')
      if (!candidate) return last
      const suggested = last.phase === 'choose' ? last.suggested : undefined
      return last = { phase: 'choose', suggested, candidate }
    },
    submit: (token: string) => remember(invoke<StartupState>('startup_submit', { token })),
    rebuild: (token: string) => remember(invoke<StartupState>('startup_rebuild', { token })),
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
    create: (title, projectId, template, spaceId) => invoke<Note>('notes_create', { title, projectId, template, spaceId }),
    projects: () => invoke<ProjectSummary[]>('projects_list'),
    createProject: (name) => invoke<ProjectSummary>('projects_create', { name }),
    read: (id, touch) => invoke<Note>('notes_read', { id, touch }),
    update: (id, content, revision, draftVersion) => invoke<SaveResult>('notes_update', { id, content, revision, draftVersion }),
    updateStrict: (id, content, revision) => invoke<SaveResult>('notes_update_strict', { id, content, revision }),
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
    openLink: address => invoke<void>('notes_open_link', { address }),
    onChanged: (listener) => {
      let live = true
      const off = listen<{ path: string; external: boolean }>('notes:changed', event => {
        if (live) listener(event.payload.path, event.payload.external)
      })
      return () => { live = false; void off.then(unlisten => unlisten()) }
    },
  }
  return api
}

function createAgentsApi(): AgentsApi {
  const discover = () => invoke<{ type: string; name: string; executable: string }[]>('agents_discover')
  const unsupported = async (): Promise<never> => { throw new Error('请在「使用 / Agent」中管理插件') }
  return {
    async list() {
      const capabilities = Object.fromEntries(capabilityKeys.map(key => [key, {
        state: 'unknown', source: '本机接入', adapter: '', date: null,
      }])) as AgentProfile['capabilities']
      const active = await invoke<Pick<AgentProfile, 'id' | 'name' | 'model' | 'executable'>[]>('agent_plugins_active')
      return active.map(agent => ({
        ...agent, type: agent.id, enabled: true, icon: 'terminal', color: '', effort: '',
        permission: '', workdir: '', extraArgv: [], logOverride: '', timeoutMs: 900_000,
        logPath: '', logSource: '', probe: null, delegationRevision: '', capabilities,
      }))
    },
    async discover(type) {
      return (await discover()).filter(agent => agent.type === type).map(agent => agent.executable)
    },
    cancelDiscover: async () => {},
    save: unsupported, setEnabled: unsupported, remove: unsupported, probe: unsupported,
  }
}

function subscribeBrain<T>(name: string, callback: (value: T) => void) {
  let live = true
  const registration = listen<T>(name, event => { if (live) callback(event.payload) })
  return () => { live = false; void registration.then(unlisten => unlisten()) }
}

function createBrainApi(): BrainApi {
  return {
    status: () => invoke('brain_status'),
    setContext: enabled => invoke('set_brain_context', { enabled }),
    metadata: () => invoke('brain_note_metadata'),
    spaces: () => invoke('brain_spaces_list'),
    saveSpace: space => invoke('brain_space_upsert', { space }),
    updateCandidate: (id, newContent, spaceId) => invoke('episodic_update_candidate', { id, newContent, spaceId }),
    promote: (id, targetSpaceId) => invoke('episodic_promote_to_note', { id, targetSpaceId }),
    discard: id => invoke('episodic_discard', { id }),
    scan: spaceId => invoke('brain_scan_context_rot', { spaceId }),
    capture: (projectId, rawText, spaceId) => invoke('capture_episodic_event', { projectId, rawText, spaceId }),
    events: (projectId, spaceId) => invoke('list_episodic_events', { projectId, spaceId }),
    consolidate: (eventIds, title, targetNoteId, synthesis) => invoke('consolidate_episodic_to_note', { eventIds, title, targetNoteId, synthesis }),
    stageDream: (eventIds, title, targetNoteId, synthesis) => invoke('dream_stage', { eventIds, title, targetNoteId, synthesis }),
    dreamSuggestion: eventIds => invoke('dream_model_suggestion', { eventIds }),
    dream: (projectId, spaceId) => invoke('trigger_dream_consolidation', { projectId, spaceId }),
    skills: () => invoke('list_procedural_skills'),
    saveSkill: input => invoke('save_procedural_skill', { input }),
    saveWorkbenchSkill: input => invoke('save_workbench_skill', { ...input }),
    history: noteId => invoke('get_note_evolution_history', { noteId }),
    applyDelta: runId => invoke('apply_memory_delta', { runId }),
    recalculate: () => invoke('recalculate_brain_vitality'),
    onChanged: callback => subscribeBrain('brain://changed', callback),
    onActivation: callback => subscribeBrain<BrainActivationWave>('brain://activation-wave', callback),
  }
}

function createAgentPluginsApi(): AgentPluginsApi {
  return {
    saveDeepSeek: ({ key, clear, baseUrl }) => invoke('agent_plugin_save_deepseek', { key: key ?? null, clear, baseUrl }),
    active: () => invoke('agent_plugins_active'),
    list: (refresh = false) => invoke('agent_plugins_list', { refresh }),
    install: id => invoke('agent_plugin_install', { id }),
    uninstall: ids => invoke('agent_plugin_uninstall', { ids }),
    update: input => invoke('agent_plugin_update', { input }),
    reorder: ids => invoke('agent_plugins_reorder', { ids }),
    resetOrder: () => invoke('agent_plugins_reset_order'),
    importManifest: json => invoke('agent_plugin_import', { json }),
    browseExecutable: () => invoke('agent_plugin_browse'),
    resolveTarget: id => invoke('agent_plugins_resolve', { id: id ?? null }),
    onChange: callback => {
      let live = true
      const registered = listen('agent-plugins:changed', () => { if (live) callback() })
      return () => { live = false; void registered.then(unlisten => unlisten()) }
    },
  }
}

function createGraphLayoutApi(): GraphLayoutApi {
  return {
    getAll: () => invoke<Record<string, GraphLayoutEntry>>('graph_layout_get_all'),
    saveBatch: (items) => invoke<void>('graph_layout_save_batch', { items }),
    setCollapsed: (noteId, collapsed) => invoke<void>('graph_layout_set_collapsed', { noteId, collapsed }),
    resetAll: () => invoke<void>('graph_layout_reset'),
    connectNodes: (sourceId, targetId, downstream = false) => invoke<Note>('graph_layout_connect_nodes', { sourceId, targetId, downstream }),
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
    agents: createAgentsApi(),
    agentPlugins: createAgentPluginsApi(),
    brain: createBrainApi(),
    harness: {
      preview: request => invoke('harness_preview_prompt', { request }),
      profiles: () => invoke('profile_list'),
      saveProfile: profile => invoke('profile_upsert', { profile }),
      deleteProfile: id => invoke('profile_delete', { id }),
      globalPrompt: () => invoke('global_prompt_get'),
      saveGlobalPrompt: prompt => invoke('global_prompt_set', { prompt }),
      start: request => invoke('harness_start_run', { request }),
      cancel: runId => invoke('harness_cancel_run', { runId }),
      list: () => invoke('harness_list_runs'),
      events: runId => invoke('harness_get_events', { runId }),
      diffs: runId => invoke('staging_list_diffs', { runId }),
      resolve: (diffId, accept) => invoke('staging_resolve_diff', { diffId, accept }),
      onEvent: callback => subscribeBrain('harness:event', callback),
    },
    agentLogs: {
      scan: input => invoke('agent_logs_scan', { input }),
      list: offset => invoke('agent_logs_list', { offset }),
      search: (query, offset) => invoke('agent_logs_search', { query, offset }),
      messages: (sessionId, offset) => invoke('agent_logs_get_messages', { sessionId, offset }),
      sendToHippocampus: (sessionId, projectId) => invoke('agent_logs_send_to_hippocampus', { sessionId, projectId }),
    },
    providers: {
      list: () => invoke('provider_list'),
      upsert: input => invoke('provider_upsert', { input }),
      remove: id => invoke('provider_delete', { id }),
      test: id => invoke('provider_test_connection', { id }),
    },
    agentSettings: {
      get: () => invoke<AgentSettings>('agent_settings_get'),
      save: input => invoke<AgentSettings>('agent_settings_save', {
        defaultAgent: input.defaultAgent,
        deepseekKey: input.deepseekKey ?? null,
        clearDeepseekKey: input.clearDeepseekKey ?? false,
      }),
    },
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

