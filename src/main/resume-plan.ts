/** Pure policy. live and evidence are from the trusted host, never the renderer. */
export interface Selection {
  readonly agent: string
  readonly id: string
  readonly revision: string
}

type Method = 'codex-interactive-resume' | 'grok-interactive-resume'
type ExactAgent = 'codex' | 'grok-cli'
const methods = { codex: 'codex-interactive-resume', 'grok-cli': 'grok-interactive-resume' } as const
const uuidAgents = new Set(['codex', 'grok-cli', 'claude'])

export interface NativeIdentity {
  /** Exact canonical drive-local path, after realpath and native binary validation. */
  readonly path: string
  readonly sha256: string
  readonly version: string
}

export interface Scope {
  /** Host-provided opaque token covering machine, Windows user, and CLI account/config scope. */
  readonly key: string
  readonly platform: 'win32'
}

export interface SessionSnapshot extends Selection {
  /** Both paths must come from the live host, never from UI overrides. */
  readonly cwd: string | null
  readonly cwdIdentity: string | null
}

export interface Live {
  readonly platform: string
  readonly scope: Scope | null
  readonly session: SessionSnapshot | null
  readonly native: NativeIdentity | null
  readonly terminal: NativeIdentity | null
  /** Version/fingerprint of the host transport, independently established by the host. */
  readonly terminalAdapter: string | null
  /** Most specific verified local finding for clients without a launcher. */
  readonly availability?: 'client-not-found' | 'registration-only' | 'cannot-locate' | 'unknown'
}

interface InteractiveEvidence {
  readonly scope: Scope
  readonly method: Method
  readonly native: NativeIdentity
  /** Requires direct interactive same-ID open and one completed new turn; headless is a different method. */
  readonly result: 'interactive-same-id-continued'
  readonly ref: string
  readonly fixedArgv?: 'restricted-interactive-v1'
}

interface TerminalEvidence {
  readonly scope: Scope
  readonly method: Method
  readonly native: NativeIdentity
  readonly terminal: NativeIdentity
  readonly terminalAdapter: string
  /** Binds the host's own terminal adapter to proof of fresh independent window, exact argv/cwd,
   * same-ID continuation, and survival of workbench exit. No terminal command is inferred. */
  readonly result: 'independent-window-argv-cwd-and-exit-verified'
  readonly ref: string
  readonly fixedArgv?: 'restricted-interactive-v1'
}

export interface Evidence {
  readonly interactive?: InteractiveEvidence
  readonly terminal?: TerminalEvidence
}

type Reason = 'invalid-id' | 'unknown-session' | 'unsupported-platform' | 'client-not-found' |
  'registration-only' | 'cannot-locate' | 'capability-unknown' | 'native-unverified' |
  'cwd-unverified' | 'interactive-unverified' | 'terminal-unverified'
type Fallback = {
  readonly kind: 'fallback'
  readonly reason: Reason
  /** Available actions in UI order; every copy requires a separate deliberate gesture. */
  readonly copy: readonly (
    { readonly kind: 'id'; readonly text: string } |
    { readonly kind: 'manual-powershell'; readonly text: string }
  )[]
}
type Launch = {
  readonly kind: 'independent-terminal'
  readonly executable: NativeIdentity
  readonly argv: readonly string[]
  readonly cwd: string
  readonly cwdIdentity: string
  readonly terminal: NativeIdentity
  readonly terminalAdapter: string
  readonly session: Selection
  readonly scope: Scope
  readonly evidenceRefs: readonly [string, string]
  readonly shell: false
  readonly window: 'new-independent-window'
  readonly ownership: 'terminal-owned'
  readonly disposition: 'only-after-explicit-user-action'
}
export type Plan = Fallback | Launch

// Lowercase UUID with version and RFC variant, matching the M3.4b Codex/Grok contract.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const safeOpaqueId = /^[A-Za-z0-9_][A-Za-z0-9_.:|+\/-]{0,255}$/
const forbidden = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u
const token = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !forbidden.test(value)
const exact = (pattern: RegExp, value: string): boolean =>
  typeof value === 'string' && !forbidden.test(value) && pattern.test(value)

function localPath(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) ||
      forbidden.test(value) || /[<>:"/|?*]/.test(value.slice(2))) return false
  if (value.length === 3) return true // drive root
  return value.slice(3).split('\\').every(part => part.length > 0 && part.length <= 255 &&
    !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(part))
}

function native(value: NativeIdentity | null | undefined): value is NativeIdentity {
  return !!value && localPath(value.path) && /\.exe$/i.test(value.path) &&
    exact(/^[0-9a-f]{64}$/, value.sha256) && token(value.version)
}
const sameNative = (a: NativeIdentity | null | undefined, b: NativeIdentity) =>
  native(a) && a.path === b.path && a.sha256 === b.sha256 && a.version === b.version
const copyNative = ({ path, sha256, version }: NativeIdentity): NativeIdentity => ({ path, sha256, version })
const sameScope = (a: Scope | undefined, b: Scope | null) =>
  !!a && !!b && a.platform === 'win32' && b.platform === 'win32' && token(a.key) && a.key === b.key
const methodFor = (agent: string): Method | null =>
  Object.hasOwn(methods, agent) ? methods[agent as ExactAgent] : null

function fixedArgv(method: Method, id: string): readonly string[] {
  switch (method) {
    case 'codex-interactive-resume': return ['resume', id]
    case 'grok-interactive-resume': return ['--resume', id]
  }
}

export const restrictedArgv = (method: Method, id: string): readonly string[] => method === 'codex-interactive-resume'
  ? ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'resume', id]
  : ['--permission-mode', 'plan', '--deny', '*', '--disable-web-search', '--no-subagents', '--resume', id]

export const validResumeId = (agent: string, id: string) => exact(uuidAgents.has(agent) ? uuid : safeOpaqueId,id)

// Copy-only, clearly labeled PowerShell text. It never enters the launch plan.
// Decline the snippet for curly quotation marks (also delimiters in PowerShell).
function manualPowerShell(executable: string, argv: readonly string[], cwd: string): string | null {
  if (/[\u2018-\u201f]/.test(executable + cwd)) return null
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
  return 'try { Set-Location -LiteralPath ' + quote(cwd) + ' -ErrorAction Stop; & ' +
    [executable, ...argv].map(quote).join(' ') + ' } catch { throw }'
}

/** No I/O, process, clipboard, URI, environment, recent-session or picker action.
 * The default empty evidence is intentional: this package observed no qualifying
 * interactive or terminal proof. A host must recheck identity and session at dispatch. */
export function planResume(selected: Selection, live: Live, evidence: Evidence = {}): Plan {
  const { agent, id, revision } = selected
  if (!validResumeId(agent, id)) {
    return { kind: 'fallback', reason: 'invalid-id', copy: [] }
  }
  const current = live.session
  if (!current || !token(revision) || current.agent !== agent || current.id !== id || current.revision !== revision) {
    return { kind: 'fallback', reason: 'unknown-session', copy: [] }
  }
  const fallback = (reason: Reason, command?: string | null): Fallback => ({
    kind: 'fallback', reason, copy: command
      ? [{ kind: 'id', text: id }, { kind: 'manual-powershell', text: command }]
      : [{ kind: 'id', text: id }],
  })
  if (live.platform !== 'win32') return fallback('unsupported-platform')
  if (live.availability === 'client-not-found' || live.availability === 'cannot-locate') {
    return fallback(live.availability)
  }
  const method = methodFor(agent)
  if (!method) return fallback(live.availability === 'registration-only' ? 'registration-only' : 'capability-unknown')
  if (!native(live.native)) return fallback('native-unverified')
  if (!localPath(current.cwd) || !token(current.cwdIdentity)) return fallback('cwd-unverified')
  const interactive = evidence.interactive
  if (!interactive || interactive.result !== 'interactive-same-id-continued' || interactive.method !== method ||
      !sameScope(live.scope ?? undefined, interactive.scope) || !sameNative(interactive.native, live.native) ||
      !token(interactive.ref)) return fallback('interactive-unverified')
  const argv = interactive.fixedArgv ? restrictedArgv(method,id) : fixedArgv(method, id)
  const terminal = evidence.terminal
  if (!native(live.terminal) || !terminal || terminal.result !== 'independent-window-argv-cwd-and-exit-verified' ||
      terminal.method !== method || !sameScope(terminal.scope, interactive.scope) ||
      !sameNative(terminal.native, live.native) || !sameNative(terminal.terminal, live.terminal) ||
      !token(live.terminalAdapter) || terminal.terminalAdapter !== live.terminalAdapter ||
      !token(terminal.ref) || terminal.ref === interactive.ref || terminal.fixedArgv !== interactive.fixedArgv) {
    return fallback('terminal-unverified', manualPowerShell(live.native.path, argv, current.cwd))
  }
  return {
    kind: 'independent-terminal', executable: copyNative(live.native), terminal: copyNative(live.terminal),
    terminalAdapter: live.terminalAdapter,
    argv, cwd: current.cwd, cwdIdentity: current.cwdIdentity, session: { agent, id, revision },
    scope: { platform: 'win32', key: interactive.scope.key }, evidenceRefs: [interactive.ref, terminal.ref],
    shell: false, window: 'new-independent-window', ownership: 'terminal-owned',
    disposition: 'only-after-explicit-user-action',
  }
}
