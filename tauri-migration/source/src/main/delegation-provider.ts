import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import { homedir } from 'node:os'
import type { Basis, Wait } from '../shared/p10'
import { defaultCodexLog, externalUuid, hash } from './delegation-cli'

const samePath = (a: unknown, b: string) => typeof a === 'string' &&
  normalize(a).toLowerCase() === normalize(b).toLowerCase()
const pad = (n: number) => String(n).padStart(2, '0')
const windowMs = 180_000 + 10_000
const within = (value: unknown, start: number) => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) && t >= start - 1_000 && t <= start + windowMs && t <= Date.now() + 1_000
}

function exactDirectory(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  if (!stat.isDirectory() || !samePath(realpathSync(path), path)) throw new Error('日志目录无法核对。')
  return true
}

function snapshot(path: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return
  if (!stat.isFile() || stat.nlink !== 1 || !samePath(realpathSync(path), path)) throw new Error('日志文件无法核对。')
  const fd = openSync(path, 'r')
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size > 8_000_000) throw new Error()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error()
    return bytes
  } finally { closeSync(fd) }
}

type Watermark = { bytes: number; sha256: string }
function mark(bytes: Buffer): Watermark { return { bytes: bytes.length, sha256: hash(bytes) } }
function delta(bytes: Buffer, baseline?: Watermark) {
  if (baseline && (!Number.isSafeInteger(baseline.bytes) || baseline.bytes < 1 || baseline.bytes >= bytes.length ||
      bytes[baseline.bytes - 1] !== 10 || hash(bytes.subarray(0, baseline.bytes)) !== baseline.sha256)) throw new Error()
  const tail = bytes.subarray(baseline?.bytes ?? 0).toString('utf8').split('\n')
  const incomplete = !!tail.pop()
  const lines = tail.filter(line => line.trim())
  return { rows: lines.map(line => JSON.parse(line)), lines, incomplete }
}

function codexFile(id: string, createdNear: number) {
  if (!externalUuid.test(id) || !Number.isFinite(createdNear)) return
  const root = defaultCodexLog()
  if (!exactDirectory(root)) return
  const files = []
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const d = new Date(createdNear + offset)
    const day = join(root, String(d.getFullYear()), pad(d.getMonth()+1), pad(d.getDate()))
    if (!exactDirectory(day)) continue
    for (const name of readdirSync(day)) {
      if (name.endsWith('-'+id+'.jsonl') && /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/.test(name)) files.push(join(day, name))
    }
  }
  if (files.length > 1) throw new Error('同一标识存在多个日志，无法核对。')
  return files[0]
}

type CodexInput = { id: string; cwd: string; version: string; model: string; effort: string | null;
  createdNear: number; startedAt: number; digest: string; watermark?: Watermark }
export function codexTurn(input: CodexInput) {
  const file = codexFile(input.id, input.createdNear)
  const bytes = file ? snapshot(file) : undefined
  if (!file || !bytes?.length) return
  const head = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'))
  const meta = head.payload
  if (head.type !== 'session_meta' || meta?.id !== input.id || meta.session_id !== input.id ||
      !samePath(meta.cwd, input.cwd) || meta.cli_version !== input.version || !within(meta.timestamp,input.createdNear)) return
  const { rows, lines, incomplete } = delta(bytes, input.watermark)
  const starts = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started')
  const contexts = rows.filter(r => r.type === 'turn_context')
  const users = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'item_completed' && r.payload.item?.type === 'UserMessage')
  if (starts.length > 1 || contexts.length > 1 || users.length > 1) return { ambiguous: true } as const
  const start = starts[0], ctx = contexts[0]?.payload, user = users[0]?.payload
  const turnId = start?.payload?.turn_id
  if (!externalUuid.test(turnId ?? '') || !within(start.timestamp, input.startedAt) ||
      start.payload.turn_attribution?.turn_trigger !== 'exec' || start.payload.root_turn_id !== turnId ||
      ctx?.turn_id !== turnId || ctx.root_turn_id !== turnId || !samePath(ctx.cwd, input.cwd) ||
      ctx.model !== input.model || ctx.effort !== input.effort || ctx.approval_policy !== 'never' ||
      ctx.sandbox_policy?.type !== 'read-only' || user?.turn_id !== turnId || user.thread_id !== input.id ||
      user.item.content?.length !== 1 || user.item.content[0]?.type !== 'text' ||
      typeof user.item.content[0].text !== 'string' || hash(user.item.content[0].text) !== input.digest) return
  const terminals = rows.filter(r => r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(r.payload?.type))
  if (terminals.length > 1 || terminals.some(r => r.payload.turn_id !== turnId)) return { ambiguous: true } as const
  const final = terminals[0]
  const successful = !incomplete && final?.payload?.type === 'task_complete' &&
    final.payload.root_turn_id === turnId && within(final.timestamp, input.startedAt) &&
    Number.isSafeInteger(final.payload.completed_at) &&
    !rows.some(r => r.type === 'event_msg' && r.payload?.type === 'error') &&
    typeof final.payload.last_agent_message === 'string' && final.payload.last_agent_message.trim().length > 0 &&
    rows.some(r => r.type === 'event_msg' && r.payload?.type === 'item_completed' &&
      r.payload.thread_id === input.id && r.payload.turn_id === turnId && r.payload.item?.type === 'AgentMessage')
  const ref = successful ? 'codex-log/'+basename(file)+'/'+turnId+'#'+hash(lines[rows.indexOf(final)]) : undefined
  // No session totals or inferred deltas. Accept a single explicit total
  // explicitly tagged to this turn, including a measured zero.
  const events = rows.filter(r => r.type === 'event_msg' && r.payload?.turn_id === turnId)
  const totals = events.flatMap(r => {
    const t = r.payload.type === 'task_complete' ? r.payload.usage?.total_tokens : undefined
    return Number.isSafeInteger(t) && t >= 0 ? [t as number] : []
  })
  const waits = new Map<string, Wait>()
  for (const r of events) {
    const p = r.payload, id = p.request_id ?? p.approval_id ?? p.call_id ?? p.item_id
    if (typeof id !== 'string' || !id || id.length > 256 || !within(r.timestamp, input.startedAt)) continue
    if (['approval_response', 'user_input_response'].includes(p.type)) waits.delete(id)
    const kind = p.type === 'request_user_input' ? 'question' :
      ['exec_approval_request', 'apply_patch_approval_request', 'request_permissions'].includes(p.type) ? 'approval' : undefined
    if (!kind) continue
    const raw = p.message ?? p.question ?? p.command ?? p.reason ?? (Array.isArray(p.questions) ? JSON.stringify(p.questions,null,2) : null)
    waits.set(id, { id, kind, at: Date.parse(r.timestamp), text: typeof raw === 'string' && raw.length <= 16000 ? raw : null })
  }
  const startAt = Date.parse(start.timestamp)
  const endAt = ref ? Date.parse(final.timestamp) : null
  const summary = ref ? final.payload.last_agent_message as string : null
  const basis: Basis | undefined = ref ? { ref, summary: summary && summary.length <= 2000 ? summary : null,
    startedAt: startAt, endedAt: endAt !== null && endAt >= startAt ? endAt : null,
    tokens: totals.length === 1 ? totals[0] : null, tokenSource: totals.length === 1 ? 'Codex turn completion' : null,
    source: 'Codex turn log', archived: false } : undefined
  const eventAt = events.reduce((max, r) => within(r.timestamp, input.startedAt) ? Math.max(max, Date.parse(r.timestamp)) : max, startAt)
  return { turnId, watermark: successful ? mark(bytes) : undefined, ref, basis, waits: terminals.length ? [] : [...waits.values()], eventAt }
}

// Verify a complete prior session has not gained another turn outside the
// workbench. The watermark records exactly the bytes observed at completion.
export function codexWatermark(id: string, cwd: string, version: string, createdNear: number) {
  const file = codexFile(id, createdNear)
  const bytes = file ? snapshot(file) : undefined
  if (!bytes?.length || bytes.at(-1) !== 10) return
  const head = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'))
  if (head.type !== 'session_meta' || head.payload?.id !== id || head.payload.session_id !== id ||
      head.payload.cli_version !== version || !samePath(head.payload.cwd, cwd)) return
  return mark(bytes)
}

// Archiving is accepted only if the entire archived log matches the
// immutable completion watermark of this exact managed Codex turn.
export function codexArchived(id: string, expected: Watermark, ref: string) {
  const name = /^codex-log\/(rollout-[0-9T-]+-([a-f0-9-]{36})\.jsonl)\/[a-f0-9-]{36}#[a-f0-9]{64}$/.exec(ref)
  if (!externalUuid.test(id) || name?.[2] !== id || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1) return false
  const dir = join(dirname(defaultCodexLog()),'archived_sessions')
  if (!exactDirectory(dir)) return false
  const bytes = snapshot(join(dir,name[1]))
  return !!bytes && bytes.length === expected.bytes && hash(bytes) === expected.sha256
}

const grokFolder = (cwd: string) => encodeURIComponent(cwd).replace(/[!'()*]/g,
  chr => '%'+chr.charCodeAt(0).toString(16).toUpperCase())
export function grokHead(id: string, cwd: string) {
  if (!externalUuid.test(id)) return
  const root = join(homedir(), '.grok', 'sessions')
  const workspace = join(root, grokFolder(cwd))
  const session = join(workspace, id)
  if (![root, workspace, session].every(exactDirectory)) return
  const summary = snapshot(join(session, 'summary.json'))
  if (!summary) return
  const s = JSON.parse(summary.toString('utf8'))
  if (s.info?.id !== id || !samePath(s.info?.cwd, cwd) || s.session_kind !== 'headless' ||
      !externalUuid.test(s.request_id ?? '') || (!Number.isSafeInteger(s.next_trace_turn) || s.next_trace_turn < 1)) return
  return { requestId: s.request_id as string, turnCount: s.next_trace_turn as number }
}

export function grokConclusion(id: string, cwd: string, requestId: string, startedAt: number, expectedTurn: number): Basis | undefined {
  if (!externalUuid.test(id) || !externalUuid.test(requestId)) return
  const before = grokHead(id,cwd)
  if (before?.requestId !== requestId || before.turnCount !== expectedTurn) return
  const path = join(homedir(),'.grok','sessions',grokFolder(cwd),id,'updates.jsonl')
  const bytes = snapshot(path)
  if (!bytes?.length) return
  const { rows, lines, incomplete } = delta(bytes)
  if (incomplete) return
  const after = grokHead(id,cwd)
  if (after?.requestId !== requestId || after.turnCount !== expectedTurn) return
  const current = rows.map((r,i)=>({ r, i, p:r.params, u:r.params?.update, m:r.params?._meta }))
  const ends = current.filter(x=>x.u?.sessionUpdate === 'turn_completed' && x.u.prompt_id === requestId)
  if (ends.length !== 1) return
  const e = ends[0]
  if (e.p.sessionId !== id || e.r.method !== '_x.ai/session/update' || e.u.stop_reason !== 'end_turn') return
  const isTime = (t: unknown): t is number => Number.isSafeInteger(t) && (t as number) >= 0
  const inWindow = (t: unknown): t is number => isTime(t) && t >= startedAt-1000 && t <= Math.min(startedAt+windowMs,Date.now()+1000)
  const end = e.m?.agentTimestampMs, time = e.u.elapsed_ms
  const beginning = inWindow(end) && isTime(time) && time <= windowMs && inWindow(end-time) ? end-time : null
  const chunks = current.filter(x=>x.u?.sessionUpdate === 'agent_message_chunk' && x.m?.promptId === requestId)
  let prior = -1, lastAt = -1
  const ids = new Set<string>()
  const valid = chunks.every(x => {
    const n = x.m.chunkId, t = x.m.agentTimestampMs, uid = x.m.eventId
    if (x.i >= e.i || x.p.sessionId !== id || x.r.method !== 'session/update' ||
        typeof uid !== 'string' || !uid.startsWith(id+'-') || ids.has(uid) ||
        !isTime(n) || n <= prior || !inWindow(t) || t < lastAt || inWindow(end) && t > end ||
        x.u.content?.type !== 'text' || typeof x.u.content.text !== 'string') return false
    ids.add(uid); prior = n; lastAt = t
    return true
  })
  const summary = valid ? chunks.map(x=>x.u.content.text).join('') : ''
  const total = e.u.usage?.totalTokens
  return { ref:'grok-log/'+id+'/'+requestId+'#'+hash(lines[e.i]), summary:summary.trim() && summary.length<=2000 ? summary : null,
    startedAt:beginning, endedAt:beginning === null ? null : end, tokens:isTime(total) ? total : null,
    source:'Grok turn update', tokenSource:isTime(total) ? 'Grok turn completion' : null, archived:false }
}
