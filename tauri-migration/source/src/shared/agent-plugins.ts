export interface AgentPluginView {
  id: string
  name: string
  icon: string
  installed: boolean
  enabled: boolean
  priority: number
  selectedModel: string
  executable: string | null
  customExecutable: string | null
  cliVersion: string | null
  appVersion: string | null
  models: string[]
  modelSource: 'local' | 'preset' | 'none'
  supportsModel: boolean
  status: 'connected' | 'setup' | 'off' | 'available'
  hint: string
  deepseekKey?: 'unset' | 'saved' | 'environment'
  baseUrl?: string | null
}

export interface AgentPluginSnapshot {
  installed: AgentPluginView[]
  available: AgentPluginView[]
  defaultAgent: string | null
}

export interface AgentPluginUpdate {
  id: string
  enabled?: boolean
  selectedModel?: string
  customExecutable?: string
  deepseekKey?: string
  clearDeepseekKey?: boolean
  baseUrl?: string
}

export interface AgentPluginsApi {
  saveDeepSeek(input: { key?: string; clear: boolean; baseUrl: string }): Promise<AgentPluginSnapshot>
  active(): Promise<{ id: string }[]>
  list(refresh?: boolean): Promise<AgentPluginSnapshot>
  install(id: string): Promise<AgentPluginSnapshot>
  uninstall(ids: string[]): Promise<AgentPluginSnapshot>
  update(input: AgentPluginUpdate): Promise<AgentPluginSnapshot>
  reorder(ids: string[]): Promise<AgentPluginSnapshot>
  resetOrder(): Promise<AgentPluginSnapshot>
  importManifest(json: string): Promise<AgentPluginSnapshot>
  browseExecutable(): Promise<string | null>
  onChange(callback: () => void): () => void
  resolveTarget(id?: string): Promise<string | null>
}
