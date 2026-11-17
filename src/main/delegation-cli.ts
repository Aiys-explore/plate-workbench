import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, normalize, relative } from 'node:path'
import type { AgentStore } from './agents'
import type { ConfirmedDelegation } from './delegation-store'

type Profile = NonNullable<ReturnType<AgentStore['delegationProfile']>>
export const externalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

// Positive allowlist for the exact Windows binaries whose runtime protocol and
// permission flags were verified. A replacement build needs adapter revalidation.
const verified = {
  codex: { sha: 'ce1945eb440b5481ed1233ebaf32b7056ee7e4e452fa62ffe1cbfb26103cdee0', version: '0.169.0' },
  'grok-cli': { sha: '6b757512d240a6439535ca75aad039e581d00f17ba8e937112fd0dbaadf1bc81', version: '1.0.77' }
} as const
type Kind = keyof typeof verified
const isKind = (s: string): s is Kind => Object.hasOwn(verified, s)
const local = (p: string) => isAbsolute(p) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(p))
const folded = (p: string) => process.platform === 'win32' ? normalize(p).toLowerCase() : normalize(p)
const samePath = (a: string, b: string) => folded(a) === folded(b)
export function realCwd(p: string) {
  if (!local(p)) throw new Error('需要本机工作目录。')
  const result = realpathSync(p)
  if (!local(result) || !samePath(result, p) || !statSync(result).isDirectory()) {
    throw new Error('请选择实际存在的本机目录，避免别名、重解析路径或指向文件。')
  }
  accessSync(result, constants.R_OK | constants.X_OK)
  return result
}
function identity(file: string) {
  const stat = statSync(file, { bigint: true })
  if (!stat.isFile() || !local(file) || extname(file).toLowerCase() !== '.exe') throw new Error('请选择原生 CLI 可执行文件。')
  accessSync(file, constants.R_OK | constants.X_OK)
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
const doses = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
const modelFor = { codex: 'gpt-6.1-sol', 'grok-cli': 'grok-4.7-build-fast' } as const
export type Plan = Awaited<ReturnType<typeof prepareCli>>
export async function prepareCli(c: ConfirmedDelegation, profile: Profile) {
  if (process.platform !== 'win32' || !isKind(profile.type)) throw new Error('该档案没有经验证的无界面适配器。可选择手动交接。')
  const kind = profile.type
  const mode = kind === 'codex' ? 'read-only' : 'plan'
  if (profile.permission && profile.permission !== mode || profile.extraArgv.length) {
    throw new Error('档案权限必须为空或为 '+mode+'，额外参数须为空。')
  }
  const model = c.model ?? modelFor[kind]
  if (model !== modelFor[kind]) throw new Error('模型未在此适配器验证。可用：'+modelFor[kind]+'。')
  if (kind === 'grok-cli' && c.effort) throw new Error('Grok 只验证了默认强度，请清空强度。')
  const effort = c.effort ?? (kind === 'codex' ? 'low' : null)
  if (kind === 'codex' && !doses.some(d => d === effort)) throw new Error('Codex 强度须为 minimal、low、medium、high 或 xhigh。')
  if (!local(profile.executable)) throw new Error('档案中缺少原生 CLI 路径。')
  const cwd = realCwd(c.cwd)
  const executable = realpathSync(profile.executable)
  if (!samePath(executable, profile.executable)) throw new Error('请选择 CLI 的实际文件路径。')
  const stamp = identity(executable)
  const digest = createHash('sha256')
  for await (const data of createReadStream(executable)) digest.update(data)
  if (identity(executable) !== stamp || digest.digest('hex') !== verified[kind].sha) {
    throw new Error('此 CLI 二进制未通过发车验证。请核对产品与版本，或选择手动交接。')
  }
  const cwdStat = statSync(cwd, { bigint: true })
  return { cwd, executable, stamp, cwdKey: [cwdStat.dev, cwdStat.ino].join(':'), kind, model, effort, mode, version: verified[kind].version, binarySha: verified[kind].sha }
}

export function verifyPlan(plan: Plan) {
  const dir = statSync(realCwd(plan.cwd), { bigint: true })
  if ([dir.dev, dir.ino].join(':') !== plan.cwdKey ||
      !samePath(realpathSync(plan.executable), plan.executable) || identity(plan.executable) !== plan.stamp) {
    throw new Error('确认后可执行文件或工作目录已变化。')
  }
}

export function argv(plan: Plan, promptFile?: string, target?: string) {
  if (target !== undefined && !externalUuid.test(target)) throw new Error('无法核对续接会话 ID。')
  if (target && plan.kind === 'codex') return ['-a', 'never', 'exec', 'resume', '--ignore-user-config', '--json',
    '--skip-git-repo-check', '-m', plan.model, '-c', 'model_reasoning_effort="'+plan.effort+'"',
    '-c', 'sandbox_mode="read-only"', target, '-']
  if (plan.kind === 'codex') return ['-a', 'never', 'exec', '--ignore-user-config', '--json', '--color', 'never',
    '--skip-git-repo-check', '-s', 'read-only', '-C', plan.cwd, '-m', plan.model, '-c', 'model_reasoning_effort="'+plan.effort+'"', '-']
  if (!promptFile) throw new Error('Missing private prompt file')
  return ['--cwd', plan.cwd, '--model', plan.model, '--verbatim', '--prompt-file', promptFile, '--permission-mode', 'plan',
    '--deny', '*', '--disable-web-search', '--no-subagents', '--max-turns', '1', '--output-format', 'streaming-json', ...(target ? ['--resume', target] : [])]
}

// Current local CLI login is used through its ordinary home lookup. No API
// tokens, shell injection variables, Electron flags, or provider overrides are copied.
export function launchEnvironment() {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'dumb' }
  for (const key of ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramData', 'PATH']) {
    const value = process.env[key] ?? Object.entries(process.env).find(([k]) => k.toUpperCase() === key.toUpperCase())?.[1]
    if (value) env[key] = value
  }
  // Explicit homes could contain unrelated accounts/config; the verified launch
  // uses the current OS user's default login, never a renderer-provided home.
  return env
}

export function defaultCodexLog() { return join(homedir(), '.codex', 'sessions') }
export function isInside(root: string, target: string) {
  const part = relative(root, target)
  return !!part && !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../')
}

export function preflightReason(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return '找不到可执行文件或工作目录。'
  if (code === 'EACCES' || code === 'EPERM') return '无权读取或执行该 CLI，或无权访问工作目录。'
  if (code) return '无法安全读取 CLI、目录或本地记录。'
  return error instanceof Error ? error.message : '无法核验发车条件。'
}
