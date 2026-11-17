// Main process only. Pure projection: no IPC, clock, filesystem, environment or clipboard.
export const SCHEMA = 1
const OMITTED = '已省略：错误来源或整段内容无法安全显示。'
const EMPTY = '未提供错误详情'
const LIMIT = 768
const phases = {
  'note-read': ['note'], 'note-save': ['note'], 'draft-recover': ['note'],
  'scan-read': ['log-source'], 'scan-decode': ['log-source'],
  'probe-discover': ['profile'], 'probe-version': ['profile'], 'probe-help': ['profile'],
  'cli-start': ['run'], 'cli-run': ['run'], 'cli-close': ['run'],
  'login-check': ['profile', 'run'], 'resume-dispatch': ['session', 'run']
} as const
type Phase = keyof typeof phases
type Kind = (typeof phases)[Phase][number]
type Action = 'compare-note' | 'check-original-operation' | 'retry-read' | 'repair-log-source' |
  'check-storage' | 'open-agent-settings' | 'verify-run' | 'review-launch' |
  'login-in-client' | 'manual-locate'
type Rule = readonly [readonly Phase[], string, Action]
const rules = {
  conflict: [['note-save', 'draft-recover'], '笔记版本冲突', 'compare-note'],
  'file-permission': [['note-read', 'note-save', 'draft-recover'], '无法访问笔记位置', 'check-storage'],
  'disk-full': [['note-save', 'draft-recover'], '磁盘空间不足', 'check-storage'],
  'file-io': [['note-read', 'note-save', 'draft-recover'], '笔记磁盘操作失败', 'check-original-operation'],
  'read-failed': [['note-read', 'scan-read'], '读取失败', 'retry-read'],
  'draft-missing': [['draft-recover'], '草稿已不可恢复', 'check-original-operation'],
  'log-unreadable': [['scan-read'], '无法读取日志来源', 'repair-log-source'],
  'log-invalid': [['scan-decode'], '无法解析日志记录', 'repair-log-source'],
  'log-partial': [['scan-read', 'scan-decode'], '日志尚未读完', 'repair-log-source'],
  'cli-missing': [['probe-discover'], '没有找到 CLI', 'open-agent-settings'],
  'probe-permission': [['probe-discover', 'probe-version', 'probe-help'], 'CLI 探测访问被拒绝', 'open-agent-settings'],
  'probe-timeout': [['probe-version', 'probe-help'], 'CLI 探测超时', 'open-agent-settings'],
  'probe-incompatible': [['probe-discover', 'probe-version', 'probe-help'], 'CLI 探测结果不兼容', 'open-agent-settings'],
  'probe-unknown': [['probe-discover', 'probe-version', 'probe-help'], '尚未核实 CLI 能力', 'open-agent-settings'],
  'launch-unknown': [['cli-start', 'cli-run', 'cli-close'], '无法核对 CLI 运行结果', 'verify-run'],
  'launch-permission': [['cli-start'], '系统拒绝访问或执行 CLI', 'verify-run'],
  'cli-permission-reported': [['cli-close'], '运行记录含权限错误提示（原因未核实）', 'verify-run'],
  'cli-model-reported': [['cli-close'], '运行记录含模型错误提示（原因未核实）', 'verify-run'],
  'cli-output-limit': [['cli-close'], 'CLI 输出超过处理上限', 'verify-run'],
  'launch-refused': [['cli-start', 'cli-close'], 'CLI 未能启动', 'review-launch'],
  'cli-timeout': [['cli-run', 'cli-close'], 'CLI 运行超时', 'verify-run'],
  'cli-exit-error': [['cli-close'], 'CLI 回合失败', 'verify-run'],
  'auth-reported': [['cli-run', 'cli-close'], 'CLI 报告认证问题', 'verify-run'],
  'cli-auth-indicator': [['cli-close'], '运行记录含认证提示（登录状态未核实）', 'verify-run'],
  'login-failed': [['login-check'], '客户端登录失败', 'login-in-client'],
  'not-logged-in': [['login-check'], '客户端未登录', 'login-in-client'],
  'login-unverified': [['login-check'], '尚未验证登录', 'open-agent-settings'],
  'jump-refused': [['resume-dispatch'], '无法跳回客户端', 'manual-locate'],
  'jump-unverified': [['resume-dispatch'], '尚未验证定位到同一会话', 'manual-locate']
} as const satisfies Record<string, Rule>
type Failure = keyof typeof rules

const instruction: Record<Action, string> = {
  'compare-note': '回到原笔记核对差异或已确认的冲突副本。',
  'check-original-operation': '回到原操作核对结果；状态未知时不要重做。',
  'retry-read': '重新读取同一对象；已有读取在途时等待其结果。',
  'repair-log-source': '检查该日志来源。修复后重新读取；保留原日志。',
  'check-storage': '回原操作检查权限或可用空间；先核实写入是否发生。',
  'open-agent-settings': '在 Agent 设置核对档案；此诊断未执行探测或登录。',
  'verify-run': '在 P10 核对原运行及外部会话；不要直接重发。',
  'review-launch': '回 P09 重新核对并完整确认；此诊断不会发车。',
  'login-in-client': '在同档案对应的客户端处理登录。',
  'manual-locate': '在原客户端按已核实的会话 ID 手动查找。'
}
const safeCodes = new Set([
  'EACCES','EPERM','ENOSPC','EDQUOT','EROFS','ENOENT','ENOTDIR','EBUSY','EIO','EINVAL','EMFILE',
  'ENOEXEC','ETIMEDOUT','SQLITE_BUSY','SQLITE_READONLY','SQLITE_CORRUPT','SQLITE_FULL',
  'ERR_INVALID_UTF8','ERR_INVALID_JSON','ERR_BAD_FRAME','401','403'
])
const sessionAdapters = new Set(['codex', 'grok', 'zcode'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// No coercion, dotted/recursive access, inherited property or getter reads.
function get(record: unknown, k: string): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  return Object.getOwnPropertyDescriptor(record, k)?.value
}
function key<T extends string>(table: Record<T, unknown>, x: unknown): x is T {
  return typeof x === 'string' && Object.hasOwn(table, x)
}
function id(x: unknown): string | undefined {
  return typeof x === 'string' && x.length === 36 && uuid.test(x) ? x : undefined
}
function code(x: unknown): string | undefined {
  return typeof x === 'string' && x.length <= 24 && safeCodes.has(x) ? x : undefined
}
type Binding = Readonly<{
  kind: Kind; sourceId: string; operationId: string; attemptId: string; failureId: string;
  phase: Phase; profileId?: string; adapter?: string
}>
function binding(record: unknown): Binding | null {
  const phase = get(record, 'phase'), kind = get(record, 'kind')
  if (!key(phases, phase) || !(phases[phase] as readonly unknown[]).includes(kind)) return null
  const sourceId = id(get(record, 'sourceId')), operationId = id(get(record, 'operationId'))
  const attemptId = id(get(record, 'attemptId')), failureId = id(get(record, 'failureId'))
  const rawProfile = get(record, 'profileId'), profileId = id(rawProfile)
  const adapter = get(record, 'adapter')
  if (!sourceId || !operationId || !attemptId || !failureId ||
      (rawProfile !== undefined && !profileId) ||
      (kind === 'profile' && sourceId !== profileId) ||
      (kind === 'run' && !profileId) ||
      (kind === 'note' && profileId) ||
      (kind !== 'note' && (typeof adapter !== 'string' || !sessionAdapters.has(adapter))) ||
      (kind === 'note' && adapter !== undefined)) return null
  return {kind: kind as Kind, sourceId, operationId, attemptId, failureId, phase,
    ...(profileId && {profileId}), ...(typeof adapter === 'string' && {adapter})}
}
function same(a: Binding, b: Binding): boolean {
  return a.kind === b.kind && a.sourceId === b.sourceId && a.operationId === b.operationId &&
    a.attemptId === b.attemptId && a.failureId === b.failureId && a.phase === b.phase &&
    a.profileId === b.profileId && a.adapter === b.adapter
}
const absent = (v: unknown) => v === 'unverified' ? '未核实' : '未返回'
function version(value: unknown): string {
  // Only numeric component/build versions; arbitrary vendor suffixes may carry private data.
  return typeof value === 'string' && value.length < 25 &&
    /^v?\d{1,5}(?:\.\d{1,5}){1,3}$/.test(value) && !/[^v0-9.]/.test(value) ? value :
    value == null ? '未返回' : '未核实'
}
function moment(at: unknown, offsetMinutes: unknown): string {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at >= 253402214400000 ||
      typeof offsetMinutes !== 'number' || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) {
    return absent(at === undefined || at === null ? at : 'unverified')
  }
  const offset = Math.abs(offsetMinutes), pad = (i: number) => String(i).padStart(2, '0')
  return new Date(at + offsetMinutes * 60_000).toISOString().replace('T', ' ').slice(0, -1) +
    (offsetMinutes >= 0 ? '+' : '-') + pad(Math.floor(offset / 60)) + ':' + pad(offset % 60)
}
function exitText(phase: Phase, event: unknown): string {
  const value = get(event, 'exitCode')
  if (get(event, 'exitEvidence') !== 'observed-close' ||
      (phase !== 'probe-version' && phase !== 'probe-help' && phase !== 'cli-close')) {
    return value === undefined || value === null ? '未返回' : '未核实'
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 &&
    value <= 4294967295 ? String(value) : absent(value)
}

// Reject invisible controls, bidi, unpaired surrogates and Unicode line separators.
// LF and CRLF are the only permitted line breaks. Tabs and lone CR are rejected.
const unsafe = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const syscall = /^([A-Z0-9_]{2,24}): (permission denied|operation not permitted|no space left on device|read-only file system|no such file or directory|input\/output error|resource busy or locked), (open|read|stat|lstat|mkdir|rename|unlink|write|scandir) ('[^']{1,320}')(?: -> ('[^']{1,320}'))?$/
const pathStart = /^(?:[A-Za-z]:[\\/]|\\\\|\/)./
function nodeFragment(line: string, evidenceCode?: string): string | null {
  const m = syscall.exec(line)
  if (!m || m[1] !== evidenceCode || !m.slice(4).every(p => !p || pathStart.test(p.slice(1, -1)))) return null
  // All path components (including basename, drive and UNC host/share) are removed.
  return m[1] + ': ' + m[2] + ', ' + m[3] + " '[路径已遮盖]'" + (m[5] ? " -> '[路径已遮盖]'" : '')
}
function scopedFragment(lines: string[], evidenceCode?: string): string[] | null {
  // Closed grammar for a *dedicated*, framed error field, never stdout/stderr/JSON message.
  if (!evidenceCode || !['401', '403'].includes(evidenceCode)) return null
  if (lines[0] !== (evidenceCode === '401' ? '401 Unauthorized' : '403 Forbidden')) return null
  const fields = [
    [/^Authorization: (?:Bearer|Basic) [A-Za-z0-9._~+/=-]{1,256}$/i, 'Authorization: [凭据已遮盖]'],
    [/^(?:token|api[_-]key|access[_-]token)[:=] ?[A-Za-z0-9._~+/=-]{1,256}$/i, 'token: [凭据已遮盖]'],
    [/^URL: https?:\/\/[^\s<>"'{}`\\]{1,480}$/i, 'URL: [地址已遮盖]'],
    [/^Username: [^\s<>"'{}`\\]{1,128}$/i, 'Username: [账号已遮盖]']
  ] as const
  const out = [lines[0]], seen = new Set<number>()
  for (const line of lines.slice(1)) {
    const field = fields.findIndex(([regex]) => regex.test(line))
    if (field < 0 || seen.has(field)) return null
    seen.add(field)
    out.push(fields[field][1])
  }
  return out
}
function detail(event: unknown, failure: Failure, phase: Phase, evidenceCode?: string): string {
  const type = get(event, 'detailKind'), raw = get(event, 'detail')
  if (raw === undefined || raw === null || raw === '') return EMPTY
  if (typeof raw !== 'string' || raw.length > LIMIT ||
      (type !== 'node-fs-message' && type !== 'framed-http-error')) return OMITTED
  const lines = raw.split(/\r?\n/)
  if (lines.length > 5 || lines.some(line => unsafe.test(line))) return OMITTED
  if (type === 'node-fs-message' && lines.length === 1 &&
      (phase.startsWith('note-') || phase === 'draft-recover' || phase === 'scan-read' || phase === 'probe-discover')) {
    return nodeFragment(lines[0], evidenceCode) ?? OMITTED
  }
  if (type === 'framed-http-error' &&
      (failure === 'login-failed' || failure === 'not-logged-in' || failure === 'auth-reported' || failure === 'cli-auth-indicator')) {
    const clean = scopedFragment(lines, evidenceCode)
    if (clean) {
      // Preserve the exact LF/CRLF pattern for accepted fragments.
      const seps = raw.match(/\r?\n/g) ?? []
      return clean.map((v, i) => v + (seps[i] ?? '')).join('')
    }
  }
  return OMITTED
}

export type Snapshot = Readonly<{
  schema: typeof SCHEMA; scope: Binding; failure: Failure; title: string;
  detail: string; action: Action; text: string
}>

/**
 * current is a main-owned selection, not a renderer-supplied DTO. event is
 * captured with its ORIGINAL binding, never stamped with whichever selection is active now.
 * Null means no eligible snapshot; invalidate the corresponding view/copy capability.
 */
export function project(current: unknown, event: unknown): Snapshot | null {
  const a = binding(current), b = binding(get(event, 'scope'))
  if (!a || !b || !same(a, b)) return null
  const failure = get(event, 'failure')
  if (!key(rules, failure)) return null
  const [allowed, title, action] = rules[failure]
  if (!(allowed as readonly Phase[]).includes(b.phase)) return null
  // Positive claims require owning-event evidence; no inference from text/help/version/exit code.
  if ((failure === 'cli-missing' && get(event, 'observation') !== 'confirmed-missing') ||
      (failure === 'launch-refused' && get(event, 'observation') !== 'confirmed-unstarted') ||
      (failure === 'login-failed' && get(event, 'observation') !== 'client-login-failed') ||
      (failure === 'not-logged-in' && get(event, 'observation') !== 'client-not-logged-in') ||
      (failure === 'jump-refused' && get(event, 'observation') !== 'dispatch-rejected') ||
      (failure === 'jump-unverified' && get(event, 'observation') !== 'dispatch-requested')) return null
  const evidenceCode = code(get(event, 'code'))
  const clean = detail(event, failure, b.phase, evidenceCode)
  const scope = Object.freeze(b)
  const rawCode = get(event, 'code')
  const text = [
    title, '对象：' + scope.kind + ' / ' + scope.sourceId,
    '操作：' + scope.operationId, '尝试：' + scope.attemptId, '错误：' + scope.failureId,
    ...(scope.profileId ? ['档案：' + scope.profileId] : []),
    ...(scope.adapter ? ['适配器：' + scope.adapter] : []),
    '阶段：' + scope.phase,
    '时间：' + moment(get(event, 'atMs'), get(event, 'offsetMinutes')),
    '应用版本：' + version(get(event, 'appVersion')),
    ...(scope.kind === 'profile' || scope.kind === 'run' ? ['CLI 版本：' + version(get(event, 'cliVersion'))] : []),
    '退出码：' + exitText(scope.phase, event),
    '错误码：' + (evidenceCode ?? (rawCode == null ? '未返回' : '未核实')),
    '错误详情（已脱敏）：', clean,
    '下一步：' + instruction[action]
  ].join('\n')
  return Object.freeze({schema: SCHEMA, scope, failure, title, action, detail: clean, text})
}

// Two consumers of the same immutable literal. The product copy handler must still
// authenticate the owner, check the current snapshot handle and await the actual write.
export const displayText = (snapshot: Snapshot): string => snapshot.text
export const copyText = (snapshot: Snapshot): string => snapshot.text
