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
