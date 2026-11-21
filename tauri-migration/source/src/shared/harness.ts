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
