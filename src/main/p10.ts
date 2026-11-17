import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { attachTaskAnchor, scanDelegation } from '../shared/delegation-markdown'
import { taskIdPattern } from '../shared/task-anchor'
import type { ActionResult, Basis, Candidate, EditorProof, Review, RunCard, RunKey, RunState, WriteState } from '../shared/p10'
import type { DelegationService, DispatchRecord } from './delegation'
import type { DelegationLaunch } from './delegation-launch'
import type { NoteStore } from './notes'
import type { AgentStore } from './agents'
import { codexArchived } from './delegation-provider'
import { planWriteback, type Authority, type Round, type VerifiedConclusion } from './writeback'

const uuid = (v: unknown): v is string => typeof v === 'string' && taskIdPattern.test(v)
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex')
const equal = (a: RunKey, b: RunKey) => a.runId === b.runId && a.noteId === b.noteId && a.blockId === b.blockId
const elapsed = (a: number | null, b: number | null) => a !== null && b !== null && Number.isSafeInteger(a) &&
  Number.isSafeInteger(b) && a >= 0 && b >= a ? b - a : null
const textIssue: Record<string, string> = {
  'anchor-missing': '未找到原任务标记。请人工定位。',
  'anchor-ambiguous': '有重复的任务或笔记标记。请先在正文中保留唯一原标记。',
  'wrong-note': '标记归属其他笔记。请核对原始标记。',
  'task-ambiguous': '标记不在可核对的任务上。请检查任务与委派指令。',
  'damaged-region': '生成区边界有损坏。请先检查原文。',
  'unowned-region': '附近有未获授权的生成区。请先检查原文。',
  'region-moved': '旧结论离开了原任务的安全区间。',
  'fingerprint-mismatch': '结论已被编辑；保留原文，请人工复核。',
  'owned-region-missing': '已登记的结论区缺失。请核对原文。',
  'unverified-conclusion': '本轮结论无法安全写成普通 Markdown。',
  'source-changed': '磁盘修订已变化。请读取磁盘版本后重新核对。',
  'draft': '当前编辑有未保存内容或草稿；保存后再核对。',
  'source-unverified': '无法核对工作区内所有 Markdown 或笔记归属。',
  'recheck': '内容或轮次已变，请重新核对。',
  'write-failed': '无法安全提交文件。原文及待写记录仍可核对。'
}
const describe = (s: string) => textIssue[s] ?? (s ? '无法验证安全落点：'+s : '')
type Row = Round & { phase: string; session: string | null; completion: string | null; dispatch: string | null; receipt: string | null; agent: string; binding: string | null }
type Job = Round & { state: WriteState; issue: string; conclusion: string; beforeRevision: string | null; afterSha: string | null;
  fingerprint: string | null; staged: string | null; path: string | null }
type Source = ReturnType<NoteStore['delegationSources']>
type File = NonNullable<ReturnType<Source['files']['get']>>
type Ticket = { row: Row; editor: EditorProof; revision: string; kind: 'write' | 'locate'; line?: number; raw?: string; changeSha: string; expires: number }

export class P10 {
  private readonly tickets = new Map<string, Ticket>()
  constructor(private db: Database.Database, private notes: NoteStore, private delegation: DelegationService, private launch: DelegationLaunch) {
    db.exec(`CREATE TABLE IF NOT EXISTS p10_write (
      runId TEXT PRIMARY KEY REFERENCES delegation_run(id), noteId TEXT NOT NULL, blockId TEXT NOT NULL, ordinal INTEGER NOT NULL,
      conclusion TEXT NOT NULL CHECK(json_valid(conclusion)), state TEXT NOT NULL CHECK(state IN ('pending','written','conflict','failed')),
      issue TEXT NOT NULL DEFAULT '', beforeRevision TEXT, afterSha TEXT, fingerprint TEXT, staged TEXT, path TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS p10_confirm (
      runId TEXT PRIMARY KEY REFERENCES delegation_run(id), dispatch TEXT NOT NULL, completion TEXT NOT NULL,
      session TEXT NOT NULL, approvedAt INTEGER NOT NULL
    ) STRICT;`)
  }

  private rows(noteId: string, blockId?: string): Row[] {
    // delegation_run is never deleted; rowid is the durable reservation order.
    return this.db.prepare(`SELECT b.note_id noteId, b.id blockId, r.id runId, r.rowid ordinal, r.phase,
      r.session_id session, r.completion_ref completion, r.dispatch_id dispatch, r.receipt_ref receipt,
      r.agent_id agent, bind.session_id binding FROM delegation_block b
      JOIN delegation_run r ON r.rowid=(SELECT max(rowid) FROM delegation_run WHERE block_id=b.id)
      LEFT JOIN delegation_binding bind ON bind.block_id=b.id WHERE b.note_id=? AND (? IS NULL OR b.id=?)
      ORDER BY r.rowid`).all(noteId, blockId ?? null, blockId ?? null) as Row[]
  }
  private current(k: RunKey) {
    const row = this.rows(k.noteId, k.blockId)[0]
    return row && equal(k, row) ? row : undefined
  }
  diagnostic(key: RunKey) {
    if (!uuid(key.noteId) || !uuid(key.blockId) || !uuid(key.runId)) return null
    const row = this.current(key)
    return row ? this.launch.diagnostic(row) : null
  }
  private resumeSubject(row: Row, agents: AgentStore) {
    if (!row.session || row.binding !== row.session || !row.dispatch || !row.receipt) return null
    const fact = this.delegation.identity(row.runId)
    const profile = agents.delegationProfile(row.agent)
    if (!fact?.externalId || this.delegation.sessionRemoved(row.agent,fact.externalId) || !profile?.enabled || fact.run.session_id !== row.session ||
        fact.run.agent_id !== row.agent || fact.run.block_id !== row.blockId ||
        this.delegation.readLaunchEvidence(row.runId,'cli-conflict')) return null
    const dispatch = this.delegation.readLaunchEvidence<DispatchRecord>(row.runId,'dispatch')
    const observed = this.delegation.readLaunchEvidence<{dispatchId:string;id:string;ref:string}>(row.runId,'cli-observed')
    const manual = this.delegation.readLaunchEvidence<{externalId:string;evidenceRef:string;cwd?:string;
      profileRevision?:string; logPath?:string}>(row.runId,'manual-link')
    const cli = dispatch?.mode === 'cli' && dispatch.dispatchId === row.dispatch && dispatch.blockId === row.blockId &&
      dispatch.noteId === row.noteId && dispatch.profileId === row.agent && dispatch.kind === profile.type &&
      dispatch.sourceRevision === fact.run.source_revision && dispatch.profileRevision === profile.revision &&
      dispatch.target === fact.targetExternalId && (!dispatch.target || dispatch.target === fact.externalId) &&
      observed?.dispatchId === row.dispatch && observed.id === fact.externalId && observed.ref === row.receipt &&
      new RegExp('^cli/'+row.dispatch+'/stdout/[1-9][0-9]*#[a-f0-9]{64}$').test(row.receipt)
    const handoff = !dispatch && profile.type === 'codex' && manual?.externalId === fact.externalId &&
      manual.evidenceRef === row.receipt && row.receipt.startsWith('manual/'+row.dispatch+'/') &&
      (!manual.profileRevision || manual.profileRevision === profile.revision && manual.logPath === profile.logPath)
    if (!cli && !handoff) return null
    const cwd = cli ? dispatch.cwd : manual?.cwd ?? null
    const revision = createHash('sha256').update(JSON.stringify([row.noteId,row.blockId,row.runId,row.dispatch,row.receipt,
      row.session,row.completion,row.phase,profile.id,profile.revision,profile.logPath,profile.type,cwd,fact.externalId])).digest('hex')
    return { agent:profile.type, id:fact.externalId, cwd, revision, profile, legacyHandoff:handoff && !manual?.profileRevision }
  }
  resumeRecord(k: RunKey, agents: AgentStore) {
    const row = this.current(k)
    return row ? this.resumeSubject(row,agents) : null
  }
  private readJob(runId: string) { return this.db.prepare('SELECT * FROM p10_write WHERE runId=?').get(runId) as Job | undefined }
  private updateJob(runId: string, state: WriteState, issue: string) {
    this.db.prepare("UPDATE p10_write SET state=?,issue=? WHERE runId=? AND state!='written'").run(state,issue,runId)
  }
  private prior(row: Row): Authority['lastWritten'] {
    return this.db.prepare("SELECT noteId,blockId,runId,ordinal,fingerprint FROM p10_write WHERE blockId=? AND state='written' AND ordinal<? ORDER BY ordinal DESC LIMIT 1")
      .get(row.blockId,row.ordinal) as Authority['lastWritten'] ?? null
  }
  private source(row: Row, src: Source | undefined) {
    const files = src ? [...src.files.values()] : []
    const own = files.filter(f => f.noteId === row.noteId)
    const file = own.length === 1 ? own[0] : undefined
    const scan = file && scanDelegation(file.disk.content)
    const matches = files.flatMap(f => f.disk.content.includes(row.blockId)
      ? (f === file ? scan! : scanDelegation(f.disk.content)).anchors.filter(a => a.blockId === row.blockId).map(a => ({ ...a, file: f })) : [])
    const misplaced = files.some(f => f !== file && f.disk.content.includes(row.blockId))
    const anchor = matches[0], task = anchor && scan?.taskAt(anchor.line)
    const issue = !src || !own.length ? 'source-unverified' : own.length > 1 || matches.length > 1 ? 'anchor-ambiguous' :
      misplaced ? 'wrong-note' : !anchor ? 'anchor-missing' :
      anchor.file !== file || anchor.claimedNoteId !== row.noteId ? 'wrong-note' :
      task?.blockId !== row.blockId || !task.marker || task.issue ? 'task-ambiguous' : ''
    return { file, scan, issue, task }
  }
  private evidence(row: Row) {
    const read = <T>(kind: string) => this.delegation.readLaunchEvidence<T>(row.runId,kind)
    const record = read<DispatchRecord>('dispatch')
    const dispatch = record && record.dispatchId === row.dispatch && record.noteId === row.noteId &&
      record.blockId === row.blockId && record.profileId === row.agent ? record : undefined
    const id = this.delegation.identity(row.runId)
    const observed = read<{ dispatchId: string; id: string; ref: string }>('cli-observed')
    const terminal = read<{ dispatchId: string; ref: string; watermark?: DispatchRecord['watermark'] }>('terminal')
    const completed = !!(row.phase === 'finished' && row.session && id?.externalId &&
      row.completion && row.receipt && dispatch && observed?.dispatchId === row.dispatch && observed.id === id.externalId &&
      observed.ref === row.receipt && terminal?.ref === row.completion && terminal.dispatchId === row.dispatch &&
      !read('cli-conflict') && !read('cli-failure') && !read('cli-stop'))
    const fact = completed ? read<Basis & { completionRef: string; dispatchId: string; externalId: string }>('p10-basis') : undefined
    const basis = fact && fact.completionRef === row.completion && fact.dispatchId === row.dispatch && fact.externalId === id?.externalId
      ? { ref: fact.ref, summary: fact.summary, startedAt: fact.startedAt, endedAt: fact.endedAt, tokens: fact.tokens,
        source: fact.source, tokenSource: fact.tokenSource, archived: false } : undefined
    if (basis && dispatch?.kind === 'codex' && terminal?.watermark && id?.externalId) {
      const archived = read<{ dispatchId: string; completionRef: string; ref: string }>('p10-archive')
      if (archived && archived.dispatchId === row.dispatch && archived.completionRef === row.completion && archived.ref === basis.ref) {
        basis.archived = true
      } else if (!archived) {
        try {
          if (codexArchived(id.externalId,terminal.watermark,basis.ref)) {
            this.delegation.saveLaunchEvidence(row.runId,'p10-archive',JSON.stringify({dispatchId:row.dispatch,completionRef:row.completion,ref:basis.ref}))
            basis.archived=true
          }
        } catch { /* An unavailable archive is not evidence. */ }
      }
    }
    const confirmed = completed && !!this.db.prepare('SELECT 1 FROM p10_confirm WHERE runId=? AND dispatch=? AND completion=? AND session=?')
      .get(row.runId,row.dispatch,row.completion,row.session)
    return { dispatch, id, completed, basis, confirmed, stop: read<{ why: string }>('cli-stop'),
      exit: read<{ dispatchId: string; observedEnd?: number; stop?: string; exitCode: number | null; declaredFailure?: boolean }>('cli-exit') }
  }

  private queue(row: Row, basis?: Basis) {
    if (basis?.summary) {
      const conclusion: VerifiedConclusion = { noteId: row.noteId, blockId: row.blockId, runId: row.runId, ordinal: row.ordinal,
        evidence: 'verified-for-display', summary: basis.summary, durationMs: elapsed(basis.startedAt,basis.endedAt), tokens: basis.tokens }
      this.db.prepare(`INSERT INTO p10_write(runId,noteId,blockId,ordinal,conclusion,state)
        VALUES(?,?,?,?,?,'pending') ON CONFLICT(runId) DO NOTHING`).run(row.runId,row.noteId,row.blockId,row.ordinal,JSON.stringify(conclusion))
    }
    return this.readJob(row.runId)
  }
  private plan(row: Row, job: Job, file: File, lastWritten = this.prior(row)) {
    return planWriteback({ source: file.disk.bytes, target: row, conclusion: JSON.parse(job.conclusion),
      authority: { current: row, lastWritten } }, scanDelegation)
  }

  private recover(row: Row, job: Job | undefined, file: File | undefined, issue: string, src: Source | undefined) {
    if (!job || job.state === 'written' || !job.afterSha || !job.fingerprint || !job.staged || !file ||
        issue || file.path !== job.path || !src) return job
    if (file.disk.revision === job.beforeRevision) return job  // Staged, never renamed.
    const recognized = file.disk.identity === job.staged && sha(file.disk.bytes) === job.afterSha &&
      this.plan(row,job,file,{ ...row, fingerprint: job.fingerprint }).kind === 'noop'
    if (recognized && src.stable() && this.current(row)) {
      this.db.prepare("UPDATE p10_write SET state='written',issue='' WHERE runId=?").run(row.runId)
      return this.readJob(row.runId)
    }
    this.updateJob(row.runId,'conflict','source-changed')
    return this.readJob(row.runId)
  }

  private view(row: Row, src: Source | undefined, agents?: AgentStore): RunCard {
    const { dispatch, id, completed, basis, confirmed, stop, exit } = this.evidence(row)
    const { file, issue } = this.source(row,src)
    const job = this.recover(row,this.queue(row,basis),file,issue,src)
    const verifiedRegion = job?.state === 'written' && file && !issue && job.fingerprint ?
      this.plan(row,job,file,{ ...row, fingerprint:job.fingerprint }) : undefined
    const region = verifiedRegion?.kind === 'noop' ? row.runId : undefined
    const launch = this.launch.status(row.runId)
    const observation = dispatch && this.launch.p10Observation(row.runId, dispatch)
    const cancelled = exit?.dispatchId === row.dispatch && exit?.stop === 'user' && exit?.observedEnd !== undefined
    const state: RunState = confirmed || basis?.archived ? 'DONE' : completed ? 'REVIEW' :
      launch?.state === 'starting' ? 'STARTING' :
      launch?.state === 'running' ? observation?.waits.length ? 'PENDING' : 'DOING' :
      launch?.state === 'stopping' ? (observation?.waits.length ? 'PENDING' : 'DOING') :
      ['failed','timed-out','not-started'].includes(launch?.state ?? '') && row.phase !== 'cancelled' ||
        (exit && (exit.declaredFailure || typeof exit.exitCode === 'number' && exit.exitCode !== 0) && !cancelled) ? 'ERROR' :
      (cancelled || row.phase === 'cancelled' || row.phase === 'bound' || row.phase === 'dispatching' || launch?.state === 'stopped') ? 'PAUSED' : 'UNKNOWN'
    const active = state === 'STARTING' || state === 'DOING' || state === 'PENDING'
    const start = basis?.startedAt ?? dispatch?.startedAt ?? null
    const observedAt = observation?.at ?? (active && dispatch ? dispatch.startedAt : null)
    const end = active ? observedAt : basis?.endedAt ?? (cancelled ? exit?.observedEnd ?? null : null)
    const resume = agents && this.resumeSubject(row,agents)
    return { noteId: row.noteId, blockId: row.blockId, runId: row.runId, located: !issue,
      state, reason: cancelled ? '已取消受管运行。' : state === 'DONE' ? confirmed ? '已明确确认本轮。' : '有本轮可信归档。' :
        launch?.reason ?? '暂缺可核对的运行证据。', write: verifiedRegion?.kind === 'review' || job?.state==='pending' && row.binding!==row.session ? 'conflict' : job?.state ?? 'none',
      issue: [describe(issue), describe(verifiedRegion?.kind === 'review' ? verifiedRegion.reason : job?.issue ?? ''), job?.state==='pending' && row.binding!==row.session ? '原轮结论保留，请在原锚点人工核对。' : ''].filter(Boolean).join(' '), cancellable: launch?.cancellable === true,
      externalId: id?.externalId, client: dispatch?.kind, cwd: dispatch?.cwd, basis, region, lastAt: observation?.last,
      durationMs: elapsed(start,end), startedAt: start, observedAt, active,
      clockSource: basis?.source ?? (dispatch ? '受管启动记录' : null), stale: observation?.stale ?? false,
      noProgress: state === 'DOING' && !!observation && observation.at - observation.last >= this.launch.noProgressAfter,
      waits: state === 'PENDING' ? observation?.waits ?? [] : [],
      hasDiagnostic: launch?.hasDiagnostic === true,
      ...(resume && {resumeRevision:resume.revision}),
      ...(stop?.why === 'user' && launch?.state === 'stopping' ? { reason: launch.reason } : {}) }
  }

  list(noteId: unknown, agents?: AgentStore): RunCard[] {
    if (!uuid(noteId)) return []
    const rows = this.rows(noteId)
    if (!rows.length) return []
    let source: Source | undefined
    try { source = this.notes.delegationSources() } catch { /* retain known note ownership in diagnostics */ }
    return rows.map(row => this.view(row,source,agents))
  }

  private ticket(t: Omit<Ticket,'expires'>) {
    const now = Date.now()
    for (const [key, v] of this.tickets) if (v.expires < now || equal(v.row,t.row)) this.tickets.delete(key)
    if (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!)
    const key = randomUUID()
    this.tickets.set(key,{ ...t, expires: now + 120_000 })
    return key
  }
  private candidates(file: File, scan: ReturnType<typeof scanDelegation>): Candidate[] {
    const lines = file.disk.content.split(/\r\n|\r|\n/)
    return scan.lines.flatMap(line => {
      const task = scan.taskAt(line)
      return task?.marker && !task.issue && !task.blockId && !scan.anchors.some(a => a.line === line)
        ? [{ line, rawLine: task.rawLine, context: lines.slice(Math.max(0,line-3),line+2).join('\n').slice(0,4000) }] : []
    }).slice(0,100)
  }

  act(key: unknown, action: unknown, editor: EditorProof, token?: unknown, line?: unknown): ActionResult {
    const message = (message: string): ActionResult => ({ message })
    if (!key || typeof key !== 'object' || !('noteId' in key) || !uuid(key.noteId) || !('blockId' in key) || !uuid(key.blockId) ||
        !('runId' in key) || !uuid(key.runId) || !editor || typeof editor.revision !== 'string' || editor.revision.length > 256 ||
        !Number.isSafeInteger(editor.generation) || editor.generation < 0 || typeof editor.clean !== 'boolean') return message('无效操作。')
    const row = this.current({ noteId: key.noteId, blockId: key.blockId, runId: key.runId })
    if (!row) return message('当前轮次已变化，请重新核对。')
    if (action === 'cancel') return message(this.launch.cancel(row.runId)?.reason ?? '未找到有效运行。')
    try {
      const facts = this.evidence(row)
      if (action === 'auto' && row.binding !== row.session) return message('原轮结论需要人工核对；不会随绑定迁移。')
      const src = this.notes.delegationSources()
      const { file, issue, scan, task } = this.source(row,src)
      const persisted = this.notes.delegationDraft(row.noteId)
      const editable = !!file && editor.clean && !persisted && editor.revision === file.disk.revision &&
        this.notes.delegationEditable(row.noteId,file.path,editor.revision)
      const stable = () => !!this.current(row) && src.stable()
      if (action === 'done') {
        if (issue || !facts.completed || !stable()) return message('无法确认：当前轮次、绑定或锚点已变化。')
        this.db.prepare('INSERT OR IGNORE INTO p10_confirm VALUES(?,?,?,?,?)').run(row.runId,row.dispatch,row.completion,row.session,Date.now())
        return message('已记录本轮确认。')
      }
      if (action === 'reconcile') {
        if (!editable || issue || !task || !stable()) return message('先核对可写磁盘修订与原任务。')
        const review = this.launch.reconcile({ noteId: row.noteId, blockId: row.blockId, rawLine: task.rawLine,
          line: scan!.anchors.find(a=>a.blockId === row.blockId)!.line, baseRevision: editor.revision, draft: false }, row.runId)
        return message(review.kind === 'pending' ? review.view.reason : '已重新核对原运行。')
      }
      let job = this.recover(row,this.queue(row,facts.basis),file,issue,src)
      const candidate = file && scan && issue === 'anchor-missing' ? this.candidates(file,scan) : []
      const review: Review = { revision: file?.disk.revision ?? null, draft: !editor.clean || persisted,
        reason: describe(issue || (!editable ? !editor.clean || persisted ? 'draft' : 'source-changed' : job?.issue ?? '')),
        current: task ? (file?.disk.content ?? '').split(/\r\n|\r|\n/).slice(Math.max(0,scan!.anchors.find(a=>a.blockId === row.blockId)!.line-2),
          scan!.anchors.find(a=>a.blockId === row.blockId)!.line+4).join('\n') : '',
        proposed: job ? (JSON.parse(job.conclusion) as VerifiedConclusion).summary : '', candidates: candidate, action: null }
      const answer = (m: string) => ({ message: m, review })
      const checked = uuid(token) ? this.tickets.get(token) : undefined
      if (uuid(token)) this.tickets.delete(token)
      const ticketValid = (kind: Ticket['kind']) => checked && checked.expires >= Date.now() && checked.kind === kind &&
        equal(checked.row,row) && checked.revision === file?.disk.revision && checked.editor.revision === editor.revision &&
        checked.editor.generation === editor.generation
      if (action === 'locate' || action === 'inspect' && typeof line === 'number') {
        const chosen = candidate.find(a=>a.line === (action === 'locate' ? checked?.line : line))
        const target = chosen && scan?.taskAt(chosen.line)
        if (!file || !chosen || !target || !editable || !stable()) return answer('无法核对候选。请先保存、清除重复标记或重新选择。')
        const change = attachTaskAnchor(file.disk.content,target,row.blockId,row.noteId)
        if (!change) return answer('该行不能安全附加原任务标记。')
        const changeSha = sha(Buffer.from(change.next))
        review.current = chosen.context
        review.proposed = change.next.slice(change.at - Math.min(change.at,240),change.at + change.insert.length)
        if (action === 'inspect') {
          review.action = 'locate'
          review.token = this.ticket({ row,editor,revision:editor.revision,kind:'locate',line:chosen.line,raw:chosen.rawLine,changeSha })
          return answer('已核对候选。确认只恢复该运行的原任务标记。')
        }
        if (!ticketValid('locate') || checked?.raw !== chosen.rawLine || checked.changeSha !== changeSha) return answer('候选已失效，请重新核对。')
        const note = this.notes.writeTaskAnchor(row.noteId,file.path,editor.revision,change.next,stable)
        if (!note) return answer('修订已变化，未恢复标记。')
        if (job) this.updateJob(row.runId,'conflict','recheck')
        return { message:'已恢复任务标记。回写仍待核对。', patch:{ note,from:change.at,to:change.at,
          insert:change.insert,generation:editor.generation,revision:editor.revision } }
      }
      if (action !== 'auto' && action !== 'apply' && action !== 'inspect') return message('无效操作。')
      if (!job || job.state === 'written') return answer(job ? '本轮结论已有提交记录。' : '没有可写入的同轮结论。')
      if (action === 'auto' && job.state !== 'pending') return message('需要人工检查。')
      if (action === 'auto' && file && (!facts.dispatch || editor.revision !== facts.dispatch.sourceRevision ||
          job.beforeRevision && job.beforeRevision !== editor.revision)) {
        this.updateJob(row.runId,'conflict','source-changed')
        return answer(describe('source-changed'))
      }
      if (!file || issue || !editable || !stable()) {
        const why = issue || (!editor.clean || persisted ? 'draft' : 'source-changed')
        if (action !== 'inspect') this.updateJob(row.runId,'conflict',why)
        return answer(describe(why))
      }
      const plan = this.plan(row,job,file)
      if (plan.kind === 'review' || plan.kind === 'noop') {
        const why = plan.kind === 'review' ? plan.reason : 'recheck'
        if (action !== 'inspect') this.updateJob(row.runId,'conflict',why)
        return answer(describe(why))
      }
      const { startByte,endByte,replacement } = plan.edit
      const bytes = file.disk.bytes
      const next = Buffer.concat([bytes.subarray(0,startByte),replacement,bytes.subarray(endByte)])
      const nextSha = sha(next)
      const charsBefore = bytes.subarray(0,startByte).toString()
      const charsAfter = bytes.subarray(endByte).toString()
      review.current = charsBefore.slice(-360) + bytes.subarray(startByte,endByte).toString() + charsAfter.slice(0,360)
      review.proposed = Buffer.from(replacement).toString()
      if (action === 'inspect') {
        review.action = plan.kind
        review.token = this.ticket({ row,editor,revision:editor.revision,kind:'write',changeSha:nextSha })
        return answer('已核对修订及生成区。')
      }
      if (action === 'apply' && (!ticketValid('write') || checked?.changeSha !== nextSha)) return answer('拟写已失效，请重新核对。')
      this.db.prepare("UPDATE p10_write SET beforeRevision=?,afterSha=?,fingerprint=?,staged=NULL,path=? WHERE runId=?")
        .run(editor.revision,nextSha,plan.fingerprint,file.path,row.runId)
      try {
        const note = this.notes.writeDelegationResult(row.noteId,file.path,editor.revision,next,stable,
          staged => this.db.prepare('UPDATE p10_write SET staged=? WHERE runId=?').run(staged,row.runId))
        if (!note) {
          this.updateJob(row.runId,'conflict','source-changed')
          return answer(describe('source-changed'))
        }
        this.db.prepare("UPDATE p10_write SET state='written',issue='' WHERE runId=?").run(row.runId)
        const from = bytes.subarray(0,startByte).toString().length
        const to = from + bytes.subarray(startByte,endByte).toString().length
        return { message:'结论已写入原笔记。', patch:{ note,from,to,insert:Buffer.from(replacement).toString(),
          generation:editor.generation,revision:editor.revision } }
      } catch {
        this.updateJob(row.runId,'failed','write-failed')
        return answer(describe('write-failed'))
      }
    } catch { return message('暂时无法核对本地记录或磁盘。请稍后重试。') }
  }
}

