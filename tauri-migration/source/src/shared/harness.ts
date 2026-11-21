export type ActiveView = 'workbench' | 'brain' | 'library' | 'skills' | 'settings'
export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openai_compatible'
export type ModelRole = 'workbench_chat' | 'brain_consolidator' | 'embedding'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  defaultModel: string
  roles: ModelRole[]
  keyHint: string
  inputPricePer1m: number
  outputPricePer1m: number
  enabled: boolean
  updatedAt: number
}

export type UpsertProviderInput = Omit<ProviderConfig, 'id' | 'keyHint' | 'updatedAt'> & {
  id?: string
  apiKey?: string
}

export interface ProviderApi {
  list(): Promise<ProviderConfig[]>
  upsert(input: UpsertProviderInput): Promise<ProviderConfig>
  remove(id: string): Promise<void>
  test(id: string): Promise<void>
}

export interface ExternalAgentSession {
  id: string
  sourceTool: 'claude_code' | 'codex_cli' | 'gemini_cli' | 'custom'
  sourcePath: string
  workspaceCwd: string
  title: string
  summary: string
  messageCount: number
  updatedAt: number
}

export interface ExternalAgentMessage {
  id: string
  sessionId: string
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName: string | null
  touchedFiles: string[]
  createdAt: number
}

export interface AgentLogsApi {
  scan(input: { includeDefaults: boolean; customDirectory?: string }): Promise<{
    scannedFiles: number; updatedSessions: number; newMessages: number; skippedPaths: number
  }>
  list(offset: number): Promise<ExternalAgentSession[]>
  search(query: string, offset: number): Promise<ExternalAgentSession[]>
  messages(sessionId: string, offset: number): Promise<ExternalAgentMessage[]>
  sendToHippocampus(sessionId: string, projectId: string): Promise<string>
}

export type BackendKind = 'local_cli' | 'api_key'
export type RunStatus = 'running' | 'review_ready' | 'completed' | 'failed' | 'cancelled'

export interface PermissionManifest {
  readableNoteIds: string[]
  allowAllNotesRead: boolean
  readableLogSessionIds: string[]
  writableDirs: string[]
  allowBrainNotePropose: boolean
  allowShell: boolean
  allowNetwork: boolean
  maxSteps: number
  maxBudgetUsd: number
}

export interface HarnessRunRequest {
  title: string
  prompt: string
  backendKind: BackendKind
  backendId: string
  modelOverride?: string
  seedNoteId?: string
  skillId?: string
  attachedLogSessionIds: string[]
  permissions: PermissionManifest
}

export interface Usage {
  tokenIn: number
  tokenOut: number
  costUsd: number
}

export interface HarnessRun extends Usage {
  id: string
  title: string
  backendKind: BackendKind
  backendId: string
  modelName: string
  status: RunStatus
  updatedAt: number
}

export interface StagedDiff {
  id: string
  runId: string
  targetKind: 'workspace_file' | 'brain_note'
  targetRef: string
  baseSha256: string
  proposedContent: string
  unifiedDiff: string
  rationale: string
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: number
}

export type HarnessEvent = { runId: string } & (
  | { kind: 'run_started'; prompt: string }
  | { kind: 'context_activated'; wave: import('./brain').BrainActivationWave | null; attachedLogCount: number }
  | { kind: 'token_delta'; delta: string }
  | { kind: 'tool_call'; toolName: string; summary: string; allowed: boolean }
  | { kind: 'diff_proposed'; diffId: string }
  | ({ kind: 'run_status_changed'; status: RunStatus; error: string | null } & Usage)
)

export interface HarnessApi {
  start(request: HarnessRunRequest): Promise<string>
  cancel(runId: string): Promise<void>
  list(): Promise<HarnessRun[]>
  events(runId: string): Promise<HarnessEvent[]>
  diffs(runId: string): Promise<StagedDiff[]>
  resolve(diffId: string, accept: boolean): Promise<void>
  onEvent(callback: (event: HarnessEvent) => void): () => void
}
