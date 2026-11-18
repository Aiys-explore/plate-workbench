import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { attachTaskAnchor, matchAgent, scanDelegation } from '../shared/delegation-markdown'
import { taskIdPattern } from '../shared/task-anchor'
import type { DelegationAnchorResult, DelegationReceipt, DelegationRejection, DelegationRequest, DelegationResult, DelegationSource } from '../shared/delegation'
import type { AgentStore } from './agents'
import type { NoteStore } from './notes'
import { makeCore, openDb, type AdapterEvidence, type ConfirmedDelegation, type SourceSnapshot } from './delegation-store'

const reasons: Record<DelegationRejection, string> = {
  'invalid-request': '委派请求格式无效。请关闭后重新打开确认。',
  'source-changed': '笔记修订已变化或存在未保存草稿。请先保存或读取磁盘版本，再重新确认。',
  'source-unverified': '无法核对工作区中的全部 Markdown 来源。请检查文件状态后重试。',
  'anchor-missing': '登记过的任务标记已找不到。请核对原文并恢复原标记后重试。',
  'anchor-ambiguous': '笔记身份或任务标记有重复。请保留原任务的标记，清除复制件中的标记后再确认。',
  'anchor-mismatch': '任务标记与已核对的源行不符。请读取磁盘版本并重新定位。',
  'anchor-owner-mismatch': '任务标记已归属另一笔记，不能自动迁移或继承绑定。',
  'intent-mismatch': '同一次确认不能改用不同的请求。请返回并重新确认。',
  'bound-to-other-agent': '此任务已绑定其他 Agent，须人工核对绑定。',
  'invalid-task': '已保存的源行没有可安全确认的委派指令。请检查标记或源文。',
  'invalid-profile': '已保存的标记或选定的 Agent 档案当前不可用。请重新选择。',
  'storage-error': '暂时无法确认本地记录。请求未发送；先核对磁盘，或用同一次确认重试。'
}
const reject = (code: DelegationRejection) => ({ status: 'rejected' as const, code, reason: reasons[code] })
const receiptResult = (receipt: DelegationReceipt): DelegationResult => ({
  status: 'not-executed', receipt,
  reason: (receipt.phase === 'reserved'
    ? receipt.code === 'active-conflict' ? '已有不同内容的本地确认；本次未创建新轮次。'
      : receipt.replay || receipt.code === 'coalesced' ? '沿用已有本地确认。' : '已在本地记录确认。'
    : '已找到历史记录；本次未创建新轮次。') + ' 本次未发送给 Agent，未创建会话。'
})

const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
const uuid = (value: unknown): value is string => typeof value === 'string' && taskIdPattern.test(value)
const controls = /[\x00-\x1f\x7f-\x9f]/
const singleLine = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() &&
  value === value.trim() && value.length <= max && !controls.test(value)
const prompt = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
  value.length <= 2_000_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)

function sourceValid(s: unknown): s is DelegationSource {
  return keys(s, ['noteId', 'baseRevision', 'draft', 'line', 'rawLine', 'blockId']) && uuid(s.noteId) &&
    singleLine(s.baseRevision, 256) && typeof s.draft === 'boolean' && typeof s.line === 'number' &&
    Number.isSafeInteger(s.line) && s.line > 0 && typeof s.rawLine === 'string' && s.rawLine.length <= 2_000_000 &&
    !/[\r\n\0]/.test(s.rawLine) && (s.blockId === undefined || uuid(s.blockId))
}
function requestValid(r: unknown): r is DelegationRequest {
  return keys(r, ['version', 'intentId', 'source', 'profileId', 'model', 'effort', 'cwd', 'textOverride']) &&
    r.version === 2 && uuid(r.intentId) && sourceValid(r.source) && uuid(r.source.blockId) && uuid(r.profileId) &&
    singleLine(r.cwd, 32768) && (process.platform === 'win32' ? /^[a-z]:[\\/]/i : /^\//).test(r.cwd) &&
    (r.model === null || singleLine(r.model, 2048)) && (r.effort === null || singleLine(r.effort, 2048)) &&
    (r.textOverride === undefined || prompt(r.textOverride))
}
// Frozen transport identity for side-effect-free lost-response replay, independent of later
// filesystem or profile edits. The authoritative request hash is calculated separately.
const sourceHash = (r: DelegationRequest) => createHash('sha256').update(JSON.stringify([
  r.version, r.source.noteId, r.source.baseRevision, r.source.blockId, r.source.rawLine,
  r.profileId, r.cwd, r.model, r.effort, r.textOverride ?? null
])).digest('hex')

export type LaunchConfirmation = { profileRevision: string; mode: 'cli' | 'manual'; previousRunId?: string }
export type DispatchRecord = LaunchConfirmation & {
  dispatchId: string; profileId: string; blockId: string; noteId: string; sourceRevision: string;
  startedAt: number; digest: string; kind: 'codex' | 'grok-cli'; cwd: string;
  model: string; effort: string | null; version: string; binarySha: string; target?: string;
  watermark?: { bytes: number; sha256: string }; previousRequestId?: string; previousTurnCount?: number
}

export class DelegationService {
  private readonly db
  private readonly store

  constructor(root: string, private readonly notes: NoteStore, private readonly agents: Pick<AgentStore, 'delegationProfiles'>, private readonly held=()=>false) {
    const file = join(root, 'delegation.sqlite')
    for (const path of [file, file + '-wal', file + '-shm', file + '-journal']) {
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('委派记录必须在工作区普通文件中')
    }
    this.db = openDb(file)
    this.store = makeCore(this.db)
    this.db.exec('CREATE TABLE IF NOT EXISTS m43_removed_anchor(block_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS m43_removed_session(agent_id TEXT NOT NULL, external_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(agent_id,external_id))')
    this.db.exec(`CREATE TABLE IF NOT EXISTS delegation_launch_evidence (
      run_id TEXT NOT NULL REFERENCES delegation_run(id), kind TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
      PRIMARY KEY(run_id, kind)) STRICT`)
  }

  close() { this.db.close() }

  sessionRemoved(agent:string,id:string){
    return !!this.db.prepare('SELECT 1 FROM m43_removed_session WHERE agent_id=? AND external_id=?').get(agent,id)
  }
  p10Database() { return this.db }

  private inspect(s: DelegationSource) {
    const fail = (code: DelegationRejection) => ({ code })
    if (this.held() || s.draft || s.blockId && this.db.prepare('SELECT 1 FROM m43_removed_anchor WHERE block_id=?').get(s.blockId)) return fail('source-changed')
    try {
      const scan = this.notes.delegationSources()
      const candidates = [...scan.files.values()].filter(file => file.noteId === s.noteId)
      if (candidates.length > 1) return fail('anchor-ambiguous')
      const file = candidates[0]
      if (!file || file.disk.revision !== s.baseRevision || !this.notes.delegationEditable(s.noteId, file.path, s.baseRevision)) {
        return fail('source-changed')
      }
      const current = scanDelegation(file.disk.content)
      const task = current.taskAt(s.line)
      const locations = []
      if (s.blockId) {
        for (const other of scan.files.values()) {
          if (other !== file && !other.disk.content.includes(s.blockId)) continue
          for (const anchor of (other === file ? current : scanDelegation(other.disk.content)).anchors) {
            if (anchor.blockId === s.blockId) locations.push({ ...anchor, noteId: other.noteId ?? '', path: other.path })
          }
        }
        if (!locations.length) return fail('anchor-missing')
        if (locations.length > 1) return fail('anchor-ambiguous')
        const owner = this.store.owner(s.blockId)
        if (locations[0].claimedNoteId !== s.noteId || (owner && owner !== s.noteId)) return fail('anchor-owner-mismatch')
        if (locations[0].path !== file.path || locations[0].line !== s.line || task?.blockId !== s.blockId) return fail('anchor-mismatch')
      }
      if (!task?.marker || task.issue) return fail('invalid-task')
      if (task.rawLine !== s.rawLine || task.blockId !== s.blockId) return fail('anchor-mismatch')
      if (!s.blockId || !this.store.owner(s.blockId)) {
        const local = new Set(current.lines.flatMap(line => {
          const task = current.taskAt(line)
          return task?.blockId && !task.issue ? [task.blockId] : []
        }))
        if (this.store.ownedBy(s.noteId).some(id => !local.has(id))) return fail('anchor-missing')
      }
      const snapshot: SourceSnapshot = { noteId: s.noteId, revision: file.disk.revision, dirty: false,
        scanComplete: true, locations: locations.map(({ noteId, blockId, line }) => ({ noteId, blockId, line })) }
      return { file, task: { ...task, marker: task.marker }, snapshot, stable: scan.stable, files: scan.files }
    } catch { return fail('source-unverified') }
  }

  addAnchor(source: unknown): DelegationAnchorResult {
    if (!sourceValid(source) || source.blockId) return reject('invalid-request')
    try {
      const proof = this.inspect(source)
      if ('code' in proof) return reject(proof.code)
      // Also protects against collisions in stray notes, independently of parser scope.
      let id: string
      do { id = randomUUID() } while (this.store.owner(id) || [...proof.files.values()].some(f => f.disk.content.includes(id)))
      const change = attachTaskAnchor(proof.file.disk.content, proof.task, id, source.noteId)
      if (!change) return reject('invalid-task')
      const note = this.notes.writeTaskAnchor(source.noteId, proof.file.path, source.baseRevision, change.next, proof.stable)
      if (!note) return reject('source-changed')
      try { this.store.registerBlock(id, source.noteId) }
      catch { return { ...reject('storage-error'), reason: '任务标记已写入 Markdown，但未能登记本地记录。请读取磁盘版本，再重新打开委派。' } }
      return { status: 'saved', note, at: change.at, insert: change.insert }
    } catch { return reject('storage-error') }
  }

  private prepare(request: DelegationRequest) {
    const proof = this.inspect(request.source)
    if ('code' in proof) return proof
    const profiles = this.agents.delegationProfiles()
    const match = matchAgent(profiles, proof.task.marker.agent)
    if ((match.status !== 'matched' && match.status !== 'ambiguous') ||
        !profiles.some(p => p.id === request.profileId && p.enabled)) return { code: 'invalid-profile' as const }
    const text = request.textOverride ?? proof.task.text
    if (!prompt(text)) return { code: 'invalid-task' as const }
    const confirmed: ConfirmedDelegation = { intentId: request.intentId, blockId: request.source.blockId,
      noteId: proof.snapshot.noteId, revision: proof.snapshot.revision, agentId: request.profileId,
      text, cwd: request.cwd, model: request.model, effort: request.effort }
    const recheck = () => {
      try {
        if (!proof.stable() || !this.notes.delegationEditable(confirmed.noteId, proof.file.path, confirmed.revision)) {
          return { code: 'source-changed' as const }
        }
      } catch { return { code: 'source-unverified' as const } }
    }
    return { confirmed, snapshot: proof.snapshot, recheck }
  }

  replay(request: unknown) {
    if (!requestValid(request)) return
    const receipt = this.store.replay(request.intentId, sourceHash(request))
    return receipt && 'runId' in receipt ? receipt : undefined
  }

  submit(request: unknown): DelegationResult { return this.reserveForLaunch(request) }

  reserveForLaunch(request: unknown, confirmation?: LaunchConfirmation): DelegationResult {
    if (!requestValid(request)) return reject('invalid-request')
    if (request.source.draft) return reject('source-changed')
    try {
      const hash = sourceHash(request)
      const replay = this.store.replay(request.intentId, hash)
      if (replay) return 'runId' in replay ? receiptResult(replay) : reject(replay.code)
      const ready = this.prepare(request)
      if ('code' in ready) return reject(ready.code)
      const outcome = this.store.reserve(ready.confirmed, ready.snapshot, hash, ready.recheck, confirmation ?
        runId => this.saveLaunchEvidence(runId, 'confirmation', JSON.stringify(confirmation)) : undefined)
      return 'runId' in outcome ? receiptResult(outcome) : reject(outcome.code)
    } catch { return reject('storage-error') }
  }

  // M3.2 seam. Main must first verify the exact adapter plan and current profile.
  // Call synchronously immediately before dispatch; no IPC endpoint exposes this.
  claimForNewDispatch(request: DelegationRequest, record?: Omit<DispatchRecord, 'dispatchId'>) {
    return this.claim(request, null, record)
  }

  claimForResume(request: DelegationRequest, record: Omit<DispatchRecord, 'dispatchId'> & { target: string }) {
    return this.claim(request, record.target, record)
  }

  private claim(request: DelegationRequest, target: string | null, record?: Omit<DispatchRecord, 'dispatchId'>) {
    if (!requestValid(request)) return { code: 'invalid-request' as const }
    const ready = this.prepare(request)
    if ('code' in ready) return ready
    const previous = this.store.replay(request.intentId, sourceHash(request))
    if (!previous || !('runId' in previous)) return { code: 'intent-mismatch' as const }
    const result = this.store.claim(ready.confirmed, ready.snapshot, target, () => {
      const changed = ready.recheck()
      if (changed || !record) return changed
      const stored = this.readLaunchEvidence<LaunchConfirmation>(previous.runId, 'confirmation')
      const { current, prior, active } = this.store.blockRuns(ready.confirmed.blockId)
      if (!stored || stored.mode !== 'cli' || record.mode !== 'cli' || stored.profileRevision !== record.profileRevision ||
          stored.previousRunId !== record.previousRunId || active?.id !== previous.runId ||
          (current?.external_id ?? null) !== target || this.readLaunchEvidence(previous.runId, 'manual-copy') ||
          (target !== null && (prior?.id !== stored.previousRunId || prior?.session_id !== current?.id))) {
        return { code: 'intent-mismatch' as const }
      }
    }, record ? (runId, dispatchId) => this.saveLaunchEvidence(runId, 'dispatch', JSON.stringify({ ...record, dispatchId })) : undefined)
    return result.code === 'claimed' ? { ...result, confirmed: ready.confirmed } : result
  }

  inspectAnchor(source: unknown) {
    if (!sourceValid(source) || !source.blockId) return { code: 'invalid-request' as const }
    const proof = this.inspect(source)
    if ('code' in proof) return proof
    try {
      if (!proof.stable() || !this.notes.delegationEditable(source.noteId, proof.file.path, source.baseRevision)) {
        return { code: 'source-changed' as const }
      }
      return { blockId: source.blockId, noteId: source.noteId, ...this.store.blockRuns(source.blockId) }
    } catch { return { code: 'source-unverified' as const } }
  }

  sameReservation(request: DelegationRequest, runId: string) {
    if (!requestValid(request)) return undefined
    const intentId = this.store.ownerIntent(runId)
    if (!intentId) return undefined
    const owner = { ...request, intentId }
    const lookup = this.store.replay(intentId, sourceHash(owner))
    return lookup && 'runId' in lookup && lookup.runId === runId && lookup.phase === 'reserved' ? owner : undefined
  }

  discardReservation(source: unknown, runId: string) {
    return this.db.transaction(() => {
      const checked = this.inspectAnchor(source)
      if ('code' in checked || checked.active?.id !== runId || checked.active.phase !== 'reserved' ||
          this.readLaunchEvidence(runId, 'manual-copy')) return false
      const owner = this.store.ownerIntent(runId)
      return !!owner && this.db.prepare("UPDATE delegation_run SET phase='cancelled' WHERE id=? AND phase='reserved'").run(runId).changes === 1
    }).immediate()
  }

  identity(runId: string) { return this.store.identity(runId) }

  // A launch configuration can be prepared before taking the durable permit.
  // M3.2 must validate cwd/adapter/executable and pass the exact frozen request back to claim.
  inspectForDispatch(request: DelegationRequest) {
    if (!requestValid(request)) return { code: 'invalid-request' as const }
    const ready = this.prepare(request)
    return 'code' in ready ? ready : { confirmed: ready.confirmed }
  }

  recover() { return this.store.recover() }
  cancelBeforeDispatch(intentId: string) { return this.store.cancelBeforeDispatch(intentId) }
  abortUnstarted(runId: string, dispatchId: string) { return this.store.abortUnstarted(runId, dispatchId) }
  outcome(runId: string) { return this.store.outcome(runId) }
  recordReceipt(runId: string, dispatchId: string, evidence: AdapterEvidence) { if(this.held()||this.sessionRemoved(evidence.agentId,evidence.externalId))throw new Error('会话已移除或工作区待核对'); return this.store.recordReceipt(runId, dispatchId, evidence) }
  finish(runId: string, dispatchId: string, evidence: AdapterEvidence) { return this.store.finish(runId, dispatchId, evidence) }

  // Store only controlled metadata and event hashes. The CLI keeps its own transcript.
  saveLaunchEvidence(runId: string, kind: string, record: string) {
    this.db.prepare('INSERT INTO delegation_launch_evidence VALUES (?, ?, ?)').run(runId, kind, record)
  }

  readLaunchEvidence<T>(runId: string, kind: string): T | undefined {
    const row = this.db.prepare<[string, string], { record: string }>(
      'SELECT record FROM delegation_launch_evidence WHERE run_id=? AND kind=?').get(runId, kind)
    return row ? JSON.parse(row.record) as T : undefined
  }

  markManualCopy(runId: string, record: string) {
    return this.db.prepare(`INSERT INTO delegation_launch_evidence
      SELECT id, 'manual-copy', ? FROM delegation_run WHERE id=? AND phase='reserved'`).run(record, runId).changes === 1
  }

  hasOtherProviderRequest(runId: string, externalId: string, providerRequestId: string) {
    return !!this.db.prepare(`SELECT 1 FROM delegation_launch_evidence
      WHERE run_id<>? AND kind='cli-observed' AND json_extract(record,'$.id')=?
      AND json_extract(record,'$.requestId')=? LIMIT 1`).get(runId, externalId, providerRequestId)
  }

  launchEvidence(runId: string) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='delegation_launch_evidence'").get()) return []
    return this.db.prepare<[string], { kind: string; record: string }>(
      'SELECT kind,record FROM delegation_launch_evidence WHERE run_id=? ORDER BY rowid').all(runId)
  }
}
