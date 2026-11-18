/**
 * First-run agent discovery. Restricted candidates only: PATH scan for the
 * known command names, verified known locations, and the DeepSeek Harness
 * desktop bundled launcher. Never starts a TUI, never probes login state, and
 * never treats a desktop app as a terminal CLI.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { DiscoveryResult, ProviderCandidate, ProviderFlavor } from '../../shared/plate-terminal/contract'

const MAX_SCAN_MS = 3000
const MAX_CANDIDATE_DIRS = 64

interface KnownSpec {
  flavor: ProviderFlavor
  displayName: string
  /** PATH command names to look for (native exe only). */
  commands: readonly string[]
  /** Verified absolute locations checked before/alongside PATH. */
  knownLocations: readonly string[]
  notInstalledReason: string
}

const localPrograms = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs')

const npmGlobal = () => {
  const roaming = process.env.APPDATA
  return roaming ? join(roaming, 'npm') : null
}

const knownSpecs: readonly KnownSpec[] = [
  {
    flavor: 'claude-code',
    displayName: 'Claude Code',
    commands: ['claude'],
    knownLocations: [join(homedir(), '.local', 'bin', 'claude.exe'), join(homedir(), '.claude', 'local', 'claude.exe')],
    notInstalledReason: '未在本机发现 claude.exe（PATH 与已知安装位置）。',
  },
  {
    flavor: 'codex',
    displayName: 'Codex',
    commands: ['codex'],
    knownLocations: (() => {
      const npm = npmGlobal()
      const base = npm ? [
        join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
        join(npm, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
      ] : []
      return base
    })(),
    notInstalledReason: '未在本机发现 codex.exe（PATH 与 npm 全局位置）。',
  },
  {
    flavor: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    commands: ['dsh'],
    knownLocations: [join(localPrograms(), 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')],
    notInstalledReason: '未发现 DeepSeek Harness CLI（PATH、桌面捆绑位置）。',
  },
  {
    flavor: 'zcode',
    displayName: 'ZCode',
    commands: [],
    knownLocations: [],
    notInstalledReason: '未检测到 ZCode 桌面版。',
  },
]

interface ZcodeDesktop {
  executable: string | null
  version: string | null
}

const zcodeDesktop = (): ZcodeDesktop => {
  const dirs = [localPrograms(), process.env.ProgramFiles ?? 'C:\\Program Files']
  for (const dir of dirs) {
    const exe = join(dir, 'ZCode', 'ZCode.exe')
    if (isNativeExe(exe)) {
      return { executable: exe, version: null }
    }
  }
  return { executable: null, version: null }
}

/**
 * The dsh.cmd shim wraps `DeepSeek Harness.exe --expose-internals <cli.js>`
 * with %~dp0-relative ..\ chains and usually sets ELECTRON_RUN_AS_NODE=1;
 * resolve to that argv vector plus the required environment.
 */
const resolveDshLauncher = (
  shim: string,
): { argv: string[]; version: string | null; env: Readonly<Record<string, string>> | null } | null => {
  try {
    const content = readFileSync(shim, 'utf8')
    const exeMatch = content.match(/"%~dp0((?:\.{2}\\)+[^"]*?\.exe)"/)
    const scriptMatch = content.match(/"%~dp0((?:\.{2}\\)+[^"]*?\.js)"/)
    if (!exeMatch || !scriptMatch) return null
    const exe = join(shim, '..', exeMatch[1])
    const script = join(shim, '..', scriptMatch[1])
    const root = join(shim, '..', '..', '..', '..', '..')
    const expectedExe = join(root, 'DeepSeek Harness.exe')
    const expectedScript = join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    if (exe.toLowerCase() !== expectedExe.toLowerCase() || script.toLowerCase() !== expectedScript.toLowerCase() || !isNativeExe(exe)) return null
    // Plain Node cannot look inside an .asar archive; verifying the archive
    // root is the strongest check available outside Electron. The exact
    // script position inside the archive is verified at real-launch time.
    const asarIndex = script.toLowerCase().indexOf('app.asar')
    const archiveOk = existsSync(script)
      || (asarIndex >= 0 && existsSync(script.slice(0, asarIndex + 'app.asar'.length)))
    if (!archiveOk) return null
    const env = /ELECTRON_RUN_AS_NODE\s*=\s*1/.test(content) ? { ELECTRON_RUN_AS_NODE: '1' } : null
    return { argv: [exe, '--expose-internals', script, '--profile', 'tui'], version: null, env }
  } catch {
    return null
  }
}

const isNativeExe = (path: string): boolean => {
  try {
    if (!path.toLowerCase().endsWith('.exe')) return false
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function discoverAgents(now = Date.now()): DiscoveryResult {
  const startedAt = now
  const pathDirs = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => /^[a-z]:[\\/]/i.test(dir))
    .slice(0, MAX_CANDIDATE_DIRS)
  const candidates: ProviderCandidate[] = []
  let truncated = false

  for (const spec of knownSpecs) {
    const scanned: string[] = []
    let found: { exe: string; bundled: boolean; argv: readonly string[] | null; env: Readonly<Record<string, string>> | null } | null = null
    let detectFailed = false

    for (const location of spec.knownLocations) {
      if (Date.now() - startedAt > MAX_SCAN_MS) { truncated = true; break }
      if (!existsSync(location)) continue
      if (spec.flavor === 'deepseek-harness' && location.toLowerCase().endsWith('.cmd')) {
        const launcher = resolveDshLauncher(location)
        if (launcher) { found = { exe: location, bundled: true, argv: launcher.argv, env: launcher.env }; break }
        detectFailed = true
        continue
      }
      if (isNativeExe(location)) { found = { exe: location, bundled: false, argv: [location], env: null }; break }
    }

    if (!found) {
      for (const dir of pathDirs) {
        if (Date.now() - startedAt > MAX_SCAN_MS) { truncated = true; break }
        for (const command of spec.commands) {
          const exe = join(dir, `${command}.exe`)
          scanned.push(exe)
          if (isNativeExe(exe)) { found = { exe, bundled: false, argv: [exe], env: null }; break }
        }
        if (found && !found.bundled) break
      }
    }

    if (spec.flavor === 'zcode') {
      const desktop = zcodeDesktop()
      candidates.push({
        flavor: 'zcode',
        displayName: spec.displayName,
        status: desktop.executable ? 'desktop' : 'not-installed',
        executable: desktop.executable,
        argv: null,
        env: null,
        workingDirectory: null,
        version: desktop.version,
        reason: desktop.executable
          ? '已发现 ZCode 桌面版。可以打开应用，或复制选中的笔记任务。'
          : spec.notInstalledReason,
        bundledLauncher: false,
      })
      continue
    }

    if (found) {
      candidates.push({
        flavor: spec.flavor,
        displayName: spec.displayName,
        status: 'startable',
        executable: found.argv?.[0] ?? found.exe,
        argv: found.argv,
        env: found.env,
        workingDirectory: null,
        version: null,
        reason: found.bundled
          ? '复用桌面版自带的 dsh，无需另装 CLI。'
          : '在 PATH 或已知安装位置发现原生 exe；登录状态未验证。',
        bundledLauncher: found.bundled,
      })
    } else if (detectFailed) {
      candidates.push({
        flavor: spec.flavor,
        displayName: spec.displayName,
        status: 'detect-failed',
        executable: null,
        argv: null,
        env: null,
        workingDirectory: null,
        version: null,
        reason: '检测到候选路径但解析失败；不执行任意 shim。',
        bundledLauncher: false,
      })
    } else {
      candidates.push({
        flavor: spec.flavor,
        displayName: spec.displayName,
        status: 'not-installed',
        executable: null,
        argv: null,
        env: null,
        workingDirectory: null,
        version: null,
        reason: spec.notInstalledReason,
        bundledLauncher: false,
      })
    }
    void scanned
  }

  void basename
  return { candidates, startedAt, finishedAt: Date.now(), truncated }
}
