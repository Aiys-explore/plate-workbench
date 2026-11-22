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

export interface ModelProfile {
  id: string
  name: string
  backendKind: BackendKind
  backendId: string
  modelName: string
  reasoningEffort: 'low' | 'medium' | 'high'
  temperature: number
  maxSteps: number
  maxBudgetUsd: number
  defaultSpaceId: string
  defaultPermissions: PermissionManifest
}

export interface PromptLayer { layerName: string; sourceLabel: string; content: string; approxTokens: number }
export interface AssembledPrompt { layers: PromptLayer[]; finalPrompt: string; totalApproxTokens: number }

export interface HarnessRunRequest {
  title: string
  prompt: string
  backendKind: BackendKind
  backendId: string
  modelOverride?: string
  profileId?: string
  spaceScope?: import('./brain').SpaceScope
  seedNoteId?: string
  skillId?: string
  promptVersionId?: string
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
  executionMode: 'shadow'
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
  | { kind: 'prompt_assembled'; prompt: AssembledPrompt; spaceIds: string[] }
  | ({ kind: 'step_usage'; step: number } & Usage)
  | { kind: 'hook_status'; hookId: string; name: string; eventName: HookEvent; status: 'executed' | 'denied' | 'skipped' | 'error'; message: string }
  | { kind: 'hook_needs_trust'; hookId: string; name: string; eventName: HookEvent; scriptSha256: string }
  | { kind: 'token_delta'; delta: string }
  | { kind: 'tool_call'; toolName: string; summary: string; allowed: boolean }
  | { kind: 'diff_proposed'; diffId: string }
  | ({ kind: 'run_status_changed'; status: RunStatus; error: string | null } & Usage)
)

export type PromptStatus = 'testing' | 'production' | 'retired'
export interface PromptVersion {
  id: string; skillId: string; versionTag: string; status: PromptStatus; systemPrompt: string; changeNote: string; createdAt: number
}
export type EvalAssertion =
  | { kind: 'max_chars'; limit: number }
  | { kind: 'must_contain' | 'must_not_contain'; text: string }
  | { kind: 'must_have_citation_link' }
  | { kind: 'llm_rubric'; criterion: string }
export interface EvalCase {
  id: string; skillId: string; title: string; inputPrompt: string; attachedContext: unknown; assertions: EvalAssertion[]
}
export interface EvalResult {
  caseId: string; title: string; output: string; passed: boolean; error?: string
  checks: { assertion: EvalAssertion; passed: boolean; reason?: string }[]
}
export interface EvalRun {
  id: string; skillId: string; promptVersionId: string; totalCases: number; passedCases: number; results: EvalResult[]; createdAt: number
}

export type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd'
export interface HarnessHook {
  id: string; name: string; eventName: HookEvent; matcher: string
  handlerKind: 'builtin' | 'command' | 'mcp_tool'; commandOrRef: string
  scriptSha256: string; trustedSha256: string; timeoutSec: number; asyncRun: boolean; enabled: boolean; sourcePreview: string
}

export interface HarnessApi {
  hooks(): Promise<HarnessHook[]>
  saveHook(hook: HarnessHook): Promise<HarnessHook>
  trustHook(id: string, expectedSha256: string): Promise<HarnessHook>
  toggleHook(id: string, enabled: boolean): Promise<HarnessHook>
  candidates(runId: string): Promise<import('./brain').EpisodicEvent[]>
  promptVersions(skillId: string): Promise<PromptVersion[]>
  createVersion(input: { skillId: string; versionTag: string; systemPrompt: string; changeNote: string }): Promise<PromptVersion>
  setVersionStatus(id: string, status: PromptStatus): Promise<void>
  evalCases(skillId: string): Promise<EvalCase[]>
  saveEvalCase(sample: EvalCase): Promise<EvalCase>
  deleteEvalCase(skillId: string, id: string): Promise<void>
  runEval(skillId: string, promptVersionId: string): Promise<EvalRun[]>
  evalRuns(skillId: string): Promise<EvalRun[]>
  preview(request: HarnessRunRequest): Promise<AssembledPrompt>
  profiles(): Promise<ModelProfile[]>
  saveProfile(profile: ModelProfile): Promise<ModelProfile>
  deleteProfile(id: string): Promise<void>
  globalPrompt(): Promise<string>
  saveGlobalPrompt(prompt: string): Promise<void>
  start(request: HarnessRunRequest): Promise<string>
  cancel(runId: string): Promise<void>
  list(): Promise<HarnessRun[]>
  events(runId: string): Promise<HarnessEvent[]>
  diffs(runId: string): Promise<StagedDiff[]>
  resolve(diffId: string, accept: boolean): Promise<void>
  onEvent(callback: (event: HarnessEvent) => void): () => void
}
