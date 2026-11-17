import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'
import { presets, type Probe, type ProbeStep } from '../shared/agents'

export const adapter = 'cli-probe/1'
const win = process.platform === 'win32'
const localAbsolute = (path: string) => isAbsolute(path) && (!win || /^[a-z]:[/\\]/i.test(path))
const desktop = (path: string) => win && (/[/\\]WindowsApps[/\\]/i.test(path) ||
  /^(cursor|antigravity|grok bot|claude desktop|workbuddy|zcode|trae|qoder|devin desktop|codebuddy)\.exe$/i.test(basename(path)))
const ioStatus = (code?: string): ProbeStep['status'] =>
  code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'permission' :
    code === 'ENOEXEC' || code === 'EINVAL' ? 'incompatible' : 'failed'

export async function executableIdentity(path: string) {
  if (!localAbsolute(path)) throw Object.assign(new Error('Expected a local absolute path'), { code: 'ENOENT' })
  if (desktop(path)) return { executable: path, stamp: null }
  const executable = await realpath(path)
  if (!localAbsolute(executable) || desktop(executable)) return { executable, stamp: null }
  const file = await stat(executable, { bigint: true })
  if (!file.isFile() || (win && extname(executable).toLowerCase() !== '.exe')) {
    return { executable, stamp: null }
  }
  return { executable, stamp: [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':') }
}

export async function discover(type: string, signal?: AbortSignal) {
  const preset = presets.find((p) => p.type === type)
  const dirs = (process.env.PATH ?? '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, '')).filter(localAbsolute)
  const candidates = (preset?.commands ?? []).flatMap((command) => dirs.map((dir) => join(dir, command + (win ? '.exe' : ''))))
  // The official npm distribution ships a native executable. Look for that binary
  // directly; cmd scripts, JavaScript launchers and global Node are not needed.
  if (type === 'codex' && win) {
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const roaming = process.env.APPDATA
    for (const dir of new Set([...dirs, ...(roaming && isAbsolute(roaming) ? [join(roaming, 'npm')] : [])])) {
      const pkg = join(dir, 'node_modules', '@openai', 'codex')
      candidates.push(join(pkg, 'node_modules', '@openai', 'codex-win32-' + arch, 'vendor', triple, 'bin', 'codex.exe'))
      candidates.push(join(pkg, 'vendor', triple, 'bin', 'codex.exe'))
    }
  }
  const found = new Set<string>()
  // Bound concurrent filesystem work so cancellation also stops scheduling new checks.
  const paths = [...new Set(candidates)]
  for (let i=0; i<paths.length; i+=8) {
    signal?.throwIfAborted()
    const resolved = await Promise.all(paths.slice(i,i+8).map(async path => {
      try {
        const identity = await executableIdentity(path)
        return identity.stamp ? identity.executable : null
      } catch (error) {
        if (ioStatus((error as NodeJS.ErrnoException).code) === 'missing') return null
        throw new Error('无法检查本机 CLI 路径：'+path+'（'+((error as NodeJS.ErrnoException).code ?? '读取失败')+'）')
      }
    }))
    for (const path of resolved) if (path) found.add(path)
  }
  signal?.throwIfAborted()
  return [...found]
}

function run(executable: string, flag: ProbeStep['flag'], timeoutMs: number, cwd: string): Promise<{ step: ProbeStep; output: string }> {
  // Do not inherit API variables, PATH, NODE_OPTIONS, or the user's Agent home.
  const env: NodeJS.ProcessEnv = {
    HOME: cwd, USERPROFILE: cwd, CODEX_HOME: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
    XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_CACHE_HOME: cwd, TEMP: cwd, TMP: cwd,
    NO_COLOR: '1', CI: '1'
  }
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]
  return new Promise((resolve) => {
    let output = ''
    let finished = false
    const child = spawn(executable, [flag], { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (status: ProbeStep['status'], code: number | null, detail: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ step: { flag, status, code, detail }, output })
    }
    const stop = () => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy() }
    const timer = setTimeout(() => {
      stop()
      finish('timeout', null, `超过 ${timeoutMs} ms`)
    }, timeoutMs)
    const capture = (data: Buffer) => {
      if (finished) return
      if (output.length + data.length > 256 * 1024) {
        stop()
        finish('failed', null, '输出超过 256 KiB')
      } else output += data.toString('utf8')
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error: NodeJS.ErrnoException) => finish(ioStatus(error.code), null, error.code ?? 'spawn error'))
    child.once('close', (code) => {
      if (code === 0) finish('ok', code, '退出码 0')
      else if (/(?:unknown|unrecognized|unsupported|unexpected|invalid|no such)\s+(?:command|argument|option|flag)|(?:argument|option|flag).*not (?:recognized|supported)/i.test(output)) {
        finish('incompatible', code, 'CLI 拒绝固定参数')
      } else if (/permission denied|access is denied/i.test(output)) finish('permission', code, 'CLI 报告访问被拒绝')
      else finish('failed', code, code === null ? '进程中止' : 'CLI 返回非零退出码')
    })
  })
}

export async function probeExecutable(path: string, timeoutMs: number): Promise<{ probe: Probe; stamp: string | null }> {
  const probe: Probe = { executable: path, version: null, status: 'missing', steps: [], helpFlags: [],
    date: new Date().toISOString(), adapter, cached: false }
  if (!path) return { probe, stamp: null }
  let identity
  try { identity = await executableIdentity(path) } catch (error) {
    probe.status = ioStatus((error as NodeJS.ErrnoException).code)
    return { probe, stamp: null }
  }
  if (!identity.stamp) {
    probe.status = 'incompatible'
    probe.steps.push({ flag: '--version', status: probe.status, code: null, detail: '需要原生 CLI 可执行文件；不运行桌面程序或脚本' })
    return { probe, stamp: null }
  }
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-cli-probe-'))
  try {
    const version = await run(identity.executable, '--version', timeoutMs, cwd)
    probe.steps.push(version.step)
    if (version.step.status === 'ok') {
      // Retain only the version token, never arbitrary output or environment data.
      probe.version = version.output.match(/\bv?(\d+\.\d+(?:\.\d+)*(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1] ?? null
      if (!probe.version) Object.assign(version.step, { status: 'incompatible', detail: '未识别到版本号' })
    }
    if (['ok', 'incompatible', 'failed'].includes(version.step.status)) {
      const help = await run(identity.executable, '--help', timeoutMs, cwd)
      probe.steps.push(help.step)
      if (help.step.status === 'ok') {
        probe.helpFlags = [...new Set(help.output.split(/\r?\n/).flatMap((line) => {
          const option = line.match(/^\s+(?:-[\w?],?\s+)?(--[a-z][a-z0-9-]*)(?=[\s=,]|$)/i)
          return option ? [option[1]] : []
        }))].slice(0, 80)
      }
    }
    probe.status = probe.steps.find((step) => step.status !== 'ok')?.status ?? 'ok'
    return { probe, stamp: identity.stamp }
  } finally { await rm(cwd, { recursive: true, force: true }).catch(() => undefined) }
}

export function resolveLog(type: string, override: string) {
  const prefix = type.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const envKey = `NOTES_WORKBENCH_AGENT_${prefix}_LOG_DIR`
  const fromEnv = process.env[envKey]?.trim()
  const rootKey = ({ codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' } as Record<string, string>)[type]
  const root = rootKey ? process.env[rootKey]?.trim() : undefined
  const hint = presets.find((p) => p.type === type)?.log
  if (override) return { logPath: override, logSource: '档案覆盖' }
  if (fromEnv && localAbsolute(fromEnv)) return { logPath: fromEnv, logSource: envKey }
  if (root && localAbsolute(root) && hint) return { logPath: join(root, basename(hint)), logSource: rootKey }
  return { logPath: hint ? join(homedir(), hint.slice(2)) : '', logSource: hint ? '预设路径提示（未验证）' : '未配置' }
}
