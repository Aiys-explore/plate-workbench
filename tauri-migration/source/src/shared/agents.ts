export const capabilityLabels = {
  cli: 'CLI', logs: '日志', headless: '无界面发车', resume: '续接', protocol: '协议注册',
  exactLocation: '精确定位', handoff: '客户端交接', tokens: 'Tokens', sessions: 'Sessions',
  quota: 'Quota', liveStatus: 'Live Status', approvals: 'Approvals', questions: 'Questions',
  replies: 'Replies', oneClickBack: 'One Click Back', turns: 'Turns', calls: 'Calls'
} as const
export type Capability = keyof typeof capabilityLabels
export const capabilityKeys = Object.keys(capabilityLabels) as Capability[]
export type Icon = 'terminal' | 'wave' | 'spark' | 'robot'
export interface AgentInput {
  name: string; type: string; executable: string; model: string; effort: string; permission: string
  workdir: string; extraArgv: string[]; logOverride: string; enabled: boolean; icon: Icon; color: string
  timeoutMs: number
}
export interface Evidence {
  state: 'supported' | 'unsupported' | 'unknown'
  source: string; adapter: string; date: string | null
}
export const probeLabels = {
  ok: 'CLI 可用', missing: '未发现', permission: '无权限', timeout: '超时',
  incompatible: '版本或参数不兼容', failed: '探测失败'
} as const
export interface ProbeStep {
  flag: '--version' | '--help'; status: keyof typeof probeLabels; code: number | null; detail: string
}
export interface Probe {
  executable: string; version: string | null; status: keyof typeof probeLabels
  steps: ProbeStep[]; helpFlags: string[]; date: string; adapter: string; cached: boolean
}
export interface AgentProfile extends AgentInput {
  id: string; logPath: string; logSource: string; probe: Probe | null
  delegationRevision: string
  capabilities: Record<Capability, Evidence>
  historicalCapabilities?: Partial<Record<Capability, Evidence>>
}
export interface AgentsApi {
  list(): Promise<AgentProfile[]>
  save(id: string | null, input: AgentInput, creationId?: string): Promise<AgentProfile>
  setEnabled(id: string, enabled: boolean): Promise<AgentProfile>
  remove(id: string): Promise<void>
  discover(type: string, requestId?: string): Promise<string[]>
  cancelDiscover(requestId: string): Promise<void>
  probe(id: string, force: boolean): Promise<AgentProfile>
}

export type AgentFieldErrors = Partial<Record<keyof AgentInput, string>>
export function checkAgentInput(input: AgentInput, windows: boolean) {
  const errors: AgentFieldErrors = {}
  const normalized = { ...input }
  for (const key of ['type','name','executable','model','effort','permission','workdir','logOverride','icon','color'] as const) {
    const value = input[key]
    const max = key==='name' ? 100 : key==='type' ? 64 : 2048
    if (typeof value!=='string' || value.length>max || /[\x00-\x1f]/.test(value)) {
      errors[key]='请输入不超过 '+max+' 字符的单行值。'
      continue
    }
    Object.assign(normalized,{[key]:value.trim()})
  }
  if (!errors.name && !normalized.name) errors.name='请输入档案名称。'
  if (!errors.type && !/^[a-z][a-z0-9_-]*$/.test(normalized.type)) errors.type='请用小写英文字母开头，只含字母、数字、下划线或连字符。'
  for (const key of ['executable','workdir','logOverride'] as const) {
    const value=normalized[key]
    if (!errors[key] && value && !(windows ? /^[a-z]:[/\\]/i : /^\//).test(value)) errors[key]='需要本机绝对路径。'
  }
  if (!errors.icon && !['terminal','wave','spark','robot'].includes(normalized.icon)) errors.icon='请选择有效图标。'
  if (!errors.color && !/^#[0-9a-f]{6}$/i.test(normalized.color)) errors.color='请输入 #RRGGBB 颜色。'
  if (typeof input.enabled!=='boolean') errors.enabled='请选择是否启用。'
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs<100 || input.timeoutMs>30000) errors.timeoutMs='探测超时须为 100–30000 ms 的整数。'
  if (!Array.isArray(input.extraArgv) || input.extraArgv.length>32 ||
      input.extraArgv.some(value=>typeof value!=='string' || value.length>1024 || /[\x00-\x1f]/.test(value))) {
    errors.extraArgv='额外 argv 每项必须是单行字符串，最多 32 项。'
  }
  return {normalized,errors}
}

type Preset = { type: string; name: string; commands: string[]; log?: string; color?: string; icon?: Icon; hud: boolean }
const hud = (type: string, name: string, commands: string[] = [], extras: Partial<Preset> = {}): Preset =>
  ({ type, name, commands, hud: true, ...extras })
export const presets: Preset[] = [
  hud('codex', 'Codex', ['codex'], { log: '~/.codex/sessions', color: '#5265dc' }),
  hud('deepseek', 'DeepSeek Harness', ['dsh'], { log: '~/.dsh/sessions', color: '#4d6bfe', icon: 'wave' }),
  hud('zcode', 'ZCode', [], { log: '~/.zcode/cli/db/db.sqlite', color: '#008477', icon: 'robot' }), { type: 'minimax-code', name: 'MiniMax Code', commands: [], hud: false },
  hud('workbuddy', 'WorkBuddy'), hud('claude', 'Claude Code', ['claude'], { log: '~/.claude/projects', color: '#c66443', icon: 'spark' }),
  hud('kimi', 'Kimi', ['kimi']), { type: 'gemini', name: 'Gemini', commands: ['gemini'], hud: false },
  hud('copilot', 'GitHub Copilot CLI', ['copilot']), hud('antigravity', 'Antigravity'),
  hud('cursor', 'Cursor', ['cursor-agent']), hud('grok-cli', 'Grok CLI', ['grok']), hud('grok-bot', 'Grok Bot'),
  hud('opencode', 'OpenCode', ['opencode']), hud('pi', 'Pi', ['pi']),
  hud('openclaw', 'OpenClaw', ['openclaw']), hud('hermes', 'Hermes Agent', ['hermes']),
  hud('codebuddy', 'CodeBuddy', ['codebuddy']), hud('qwen', 'Qwen Code', ['qwen']),
  hud('devin', 'Devin CLI', ['devin']), hud('kilo', 'Kilo Code'), hud('mimo', 'MiMo Code'),
  hud('oh-my-pi', 'Oh My Pi'), hud('droid', 'Factory Droid', ['droid']), hud('trae', 'TRAE'),
  hud('qoder', 'Qoder'), hud('cline', 'Cline'), hud('roo', 'Roo Code'), hud('goose', 'Goose', ['goose'])
]
export const defaultInput = (type = 'custom'): AgentInput => {
  const preset = presets.find((item) => item.type === type)
  return {
    type, name: preset?.name ?? '', executable: '', model: '', effort: '', permission: '', workdir: '',
    extraArgv: [], logOverride: '', enabled: true, timeoutMs: 5000,
    icon: preset?.icon ?? 'terminal', color: preset?.color ?? '#6475a0'
  }
}
