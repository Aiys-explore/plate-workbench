import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { HandoffMatches, LaunchResult, LaunchView, DelegationRequest, LaunchExpectation, LaunchReview } from '../shared/delegation'
import type { Basis, Wait } from '../shared/p10'
import { taskIdPattern } from '../shared/task-anchor'
import type { AgentStore } from './agents'
import type { DelegationService, DispatchRecord, LaunchConfirmation } from './delegation'
import { argv, defaultCodexLog, externalUuid, hash, launchEnvironment, prepareCli, preflightReason, realCwd, verifyPlan, type Plan } from './delegation-cli'
import { codexTurn, codexWatermark, grokHead, grokConclusion } from './delegation-provider'
import { closeFact, delegationDiagnostic } from './delegation-diagnostic'
import { handoffWindow, matchRollouts, rolloutFiles } from './delegation-handoff'

const runKey = (s: unknown): s is string => typeof s === 'string' && taskIdPattern.test(s)
const deadline = 180_000
const authError = /\b(?:401 unauthorized|403 forbidden|not authenticated|not logged in|authentication (?:failed|required)|please (?:log in|login|sign in)|invalid_grant|token has expired)\b/i
const ioError = /\b(?:permission denied|access is denied)\b/i
const modelError = /\b(?:model .*?(?:not supported|not available|does not exist)|unsupported model)\b/i
const isSpawnRefusal = (s?: string) => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC'].includes(s ?? '')

type Manual = { request: DelegationRequest; revision: string; text: string; cwd: string; canMatch: boolean;
  copied?: { at: number; before: Set<string> }; candidates: Map<string, { externalId: string; at: string; ref: string }> }
type Observation = { dispatchId: string; id: string; ref: string; requestId?: string }
type Terminal = { dispatchId: string; ref: string; watermark?: DispatchRecord['watermark'];
  turnId?: string; providerRequestId?: string; turnCount?: number }
const observationValid = (o: Observation, dispatchId: string) => o.dispatchId === dispatchId && externalUuid.test(o.id) &&
  new RegExp('^cli/'+dispatchId+'/stdout/[1-9][0-9]*#[a-f0-9]{64}$').test(o.ref)
const expectationValid = (x: unknown): x is LaunchExpectation => !!x && typeof x === 'object' &&
  Object.keys(x).length === 2 && 'kind' in x && (x.kind === 'reserved' || x.kind === 'resume') &&
  'runId' in x && runKey(x.runId)
type Active = { child: ChildProcess; spawned: boolean; stop?: 'user' | 'timeout' | 'output'; exited: boolean }

export class DelegationLaunch {
  private readonly views = new Map<string, LaunchView>()
  private readonly preparing = new Set<string>()
  private readonly active = new Map<string, Active>()
  private readonly manual = new Map<string, Manual>()
  private closing = false
  get noProgressAfter() {
    const configured = Number(process.env.NOTES_WORKBENCH_NO_PROGRESS_MS)
    return Number.isSafeInteger(configured) && configured >= 1000 ? configured : 60_000
  }
  private readonly telemetry = new Map<string, { at: number; last: number; waits: Wait[]; stale: boolean }>()

  constructor(private readonly delegation: DelegationService, private readonly agents: AgentStore,
    private readonly writeClipboard: (text: string) => void, private readonly startProcess = spawn,
    private readonly deadlineMs = deadline) {}

  close() {
    this.closing = true
    for (const [run, entry] of this.active) this.stop(run, entry, 'user')
    this.manual.clear()
  }

  diagnostic(key: { noteId: string; blockId: string; runId: string }) {
    return this.active.has(key.runId) || this.preparing.has(key.runId)
      ? null : delegationDiagnostic(this.delegation, key)
  }

  private hasDiagnostic(runId: string) {
    try {
      const dispatch = this.delegation.readLaunchEvidence<DispatchRecord>(runId, 'dispatch')
      return !!dispatch && !!this.diagnostic({ runId, noteId: dispatch.noteId, blockId: dispatch.blockId })
    } catch { return false }
  }

  private update(runId: string, state: LaunchView['state'], reason: string, fields: Partial<LaunchView> = {}) {
    const view = { ...this.views.get(runId), runId, state, reason, cancellable: false, ...fields }
    this.views.set(runId, view)
    while (this.views.size > 256) {
      const old = [...this.views.keys()].find(key => !this.active.has(key) && !this.preparing.has(key) && !this.manual.has(key))
      if (!old || old === runId) break
      this.views.delete(old)
    }
    return view
  }

  status(runId: unknown): LaunchView | null {
    if (!runKey(runId)) return null
    const current = this.views.get(runId)
    if (current) return { ...current, hasDiagnostic: this.hasDiagnostic(runId) }
    try {
      const stored = this.delegation.outcome(runId)
      if (!stored) return null
      const id = this.delegation.identity(runId)!
      const reason = id.run.phase === 'reserved'
        ? this.delegation.readLaunchEvidence(runId, 'manual-copy')
          ? '交接文本可能已复制或发送。请在客户端查找原会话，不能重新发车。'
          : '只记录了本地确认，尚未领取发车许可。'
        : id.run.phase === 'bound'
          ? '已保留原会话 ID；未核实当轮终态，不能续接。'
          : '许可已领取；缺少可核对的当轮会话证据。不能重新发车。'
      if (stored.phase === 'finished') return { runId, state: 'completed', reason: '已记录同一会话的技术回合结束。', cancellable: false, externalId: stored.externalId }
      if (stored.phase === 'dispatching' || stored.phase === 'bound') return {
        runId, state: 'unresolved', reason, cancellable: false, externalId: stored.externalId ?? id.targetExternalId, hasDiagnostic: this.hasDiagnostic(runId) }
      return { runId, state: stored.phase === 'cancelled' ? 'not-started' : 'unresolved',
        reason: stored.phase === 'cancelled' ? '该次确认已关闭；如需发送，请重新确认。' : reason,
        cancellable: false, externalId: id.targetExternalId, hasDiagnostic: this.hasDiagnostic(runId) }
    } catch { return null }
  }

  review(source: unknown): LaunchReview {
    try {
      const checked = this.delegation.inspectAnchor(source)
      if ('code' in checked) return { kind: 'blocked', reason: '无法核对任务锚或笔记（'+checked.code+'）。' }
      const { active, current, prior } = checked
      if (active) {
        const view = this.status(active.id)
        if (!view) throw new Error()
        const confirmed = this.delegation.readLaunchEvidence<LaunchConfirmation>(active.id, 'confirmation')
        const canDiscard = active.phase === 'reserved' && !this.preparing.has(active.id) &&
          !this.delegation.readLaunchEvidence(active.id, 'manual-copy')
        return { kind: 'pending', phase: active.phase, view, canDiscard,
          canContinue: canDiscard && !!confirmed, confirmedMode: confirmed?.mode }
      }
      if (!current) return { kind: 'new' }
      const record = prior && this.delegation.readLaunchEvidence<DispatchRecord>(prior.id, 'dispatch')
      const profile = this.agents.delegationProfile(current.agent_id)
      if (prior && record && prior.session_id === current.id && profile?.enabled &&
          profile.revision === record.profileRevision && this.resumeProof(prior.id, current.external_id)) {
        return { kind: 'resume', runId: prior.id, externalId: current.external_id, profileId: current.agent_id }
      }
      return { kind: 'blocked', reason: '已有会话 '+current.external_id+'；档案或客户端的上一轮证据无法核对。请在原客户端查看会话。' }
    } catch { return { kind: 'blocked', reason: '无法核对本地委派记录。' } }
  }

  discardReservation(source: unknown, runId: unknown): LaunchReview {
    if (!runKey(runId) || this.preparing.has(runId)) return this.review(source)
    try {
      if (this.delegation.discardReservation(source, runId)) {
        this.manual.delete(runId)
        this.update(runId, 'not-started', '已关闭未发车的确认。')
      }
    } catch { /* leave the original record available */ }
    return this.review(source)
  }

  reconcile(source: unknown, runId: unknown): LaunchReview {
    try {
      const checked = this.delegation.inspectAnchor(source)
      if (!('code' in checked) && checked.active?.id === runId && runKey(runId) &&
          !this.active.has(runId) && !this.preparing.has(runId) && !this.manual.has(runId)) {
        this.recoverDispatch(runId, checked.noteId)
      }
    } catch { /* diagnostics remain available; no launch */ }
    return this.review(source)
  }

  private resumeProof(runId: string, target: string) {
    const id = this.delegation.identity(runId)
    const record = this.delegation.readLaunchEvidence<DispatchRecord>(runId, 'dispatch')
    const terminal = this.delegation.readLaunchEvidence<Terminal>(runId, 'terminal')
    if (this.delegation.readLaunchEvidence(runId, 'cli-conflict') || id?.run.phase !== 'finished' || id.externalId !== target || this.delegation.sessionRemoved(id.run.agent_id,target) || !record ||
        record.dispatchId !== id.run.dispatch_id || terminal?.dispatchId !== record.dispatchId ||
        terminal.ref !== id.run.completion_ref) return
    if (record.kind === 'codex') {
      const createdNear = this.createdNear(target)
      const current = createdNear ? codexWatermark(target, record.cwd, record.version, createdNear) : undefined
      if (!current || !terminal.watermark || current.bytes !== terminal.watermark.bytes ||
          current.sha256 !== terminal.watermark.sha256) return
      return { record, watermark: current }
    }
    const head = grokHead(target, record.cwd)
    if (!head || terminal.providerRequestId !== head.requestId || terminal.turnCount !== head.turnCount) return
    return { record, previousRequestId: head.requestId, previousTurnCount: head.turnCount }
  }

  private createdNear(id: string) {
    // From the v7 UUID, locate the precise session's date neighborhood.
    if (!externalUuid.test(id) || id[14] !== '7') return
    const stamped = Number.parseInt(id.slice(0, 13).replace('-', ''), 16)
    return Number.isSafeInteger(stamped) && stamped > 0 ? stamped : undefined
  }

  async start(request: DelegationRequest, revision: unknown, mode: unknown, expected: unknown = undefined): Promise<LaunchResult> {
    const rejected = (reason: string): LaunchResult => ({ status: 'rejected', reason })
    const result = (view: LaunchView): LaunchResult => ({ status: 'run', view })
    if (this.closing || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) ||
        (mode !== 'cli' && mode !== 'manual') || (expected !== undefined && !expectationValid(expected))) return rejected('请重新核对档案与委派方式。')
    const readProfile = () => {
      const p = this.agents.delegationProfile(request.profileId)
      if (!p?.enabled || p.revision !== revision) throw new Error('档案已停用或配置已变化。请重新打开确认。')
      return p
    }
    // Clone the IPC inputs before any async preflight; callers cannot mutate
    // the confirmed plan while a binary is being hashed.
    request = structuredClone(request)
    // Use service validation before reading renderer-controlled fields.
    const inspected = this.delegation.inspectForDispatch(request)
    if (!('confirmed' in inspected)) return rejected('无法核对确认内容（'+inspected.code+'）。请重新读取笔记。')
    let c = inspected.confirmed
    let profile
    try { profile = readProfile() } catch (error) { return rejected(preflightReason(error)) }
    const previous = this.delegation.inspectAnchor(request.source)
    if ('code' in previous) return rejected('任务锚已变化。请重新核对。')
    const { active, current, prior } = previous
    const replay = this.delegation.replay(request)
    if (replay && replay.phase !== 'reserved') {
      const old = this.status(replay.runId)
      if (old) return result(old)
    }
    if (active?.phase === 'reserved' && expected?.kind === 'reserved' && expected.runId === active.id) {
      const owner = this.delegation.sameReservation(request, active.id)
      if (!owner) return rejected('本次文字或参数与原确认不同。请关闭未发车的确认后重新确认。')
      request = owner
      c = { ...c, intentId: owner.intentId }
    } else if (expected?.kind === 'reserved') {
      if (active && active.id === expected.runId) return result(this.status(active.id)!)
      return rejected('原预占已变化。请重新核对。')
    }
    if (active && (active.phase !== 'reserved' || this.preparing.has(active.id) || this.manual.has(active.id))) {
      const existing = this.delegation.submit(request)
      if (existing.status === 'rejected') return rejected(existing.reason)
      return result(this.status(active.id)!)
    }
    if (active && this.delegation.readLaunchEvidence(active.id, 'manual-copy')) return result(this.status(active.id)!)
    const saved = active && this.delegation.readLaunchEvidence<LaunchConfirmation>(active.id, 'confirmation')
    let previousRunId: string | undefined
    let resumeTarget: string | undefined
    let resumeProof: ReturnType<DelegationLaunch['resumeProof']>
    if (current && (expected?.kind === 'resume' || expected?.kind === 'reserved')) {
      previousRunId = expected.kind === 'resume' ? expected.runId : saved?.previousRunId
      try {
        if (prior?.id !== previousRunId || !previousRunId || current.agent_id !== profile.id || mode !== 'cli') throw new Error()
        resumeTarget = current.external_id
        resumeProof = this.resumeProof(previousRunId, resumeTarget)
        if (!resumeProof || resumeProof.record.profileRevision !== revision) throw new Error()
      } catch { return rejected('不能核对同档案、同会话的上一轮。请在原客户端核对。') }
    } else if (current && !active) return rejected('任务已绑定会话。请打开确认续接，核对原会话 ID。')
    else if (expected?.kind === 'resume') return rejected('原会话或轮次已变化。请重新核对。')
    const confirmation: LaunchConfirmation = { profileRevision: revision, mode, previousRunId }
    if (saved && (saved.profileRevision !== revision || saved.mode !== mode || saved.previousRunId !== previousRunId)) {
      return rejected('已存确认的档案或委派方式不同。请先核对该记录。')
    }
    const reservation = this.delegation.reserveForLaunch(request, confirmation)
    if (reservation.status === 'rejected') return rejected(reservation.reason)
    const { runId, phase, code } = reservation.receipt
    if (phase !== 'reserved' || code !== 'owner' || this.preparing.has(runId) || this.manual.has(runId)) {
      return result(this.status(runId) ?? this.update(runId, 'unresolved', '该次确认无法再次发车。'))
    }
    if (!this.delegation.readLaunchEvidence(runId, 'confirmation')) {
      return result(this.update(runId, 'unresolved', '旧预占缺少可核对的档案和委派方式。请关闭未发车的确认后重新确认。'))
    }
    const doneBeforeSpawn = (reason: string) => {
      try {
        if (this.delegation.cancelBeforeDispatch(request.intentId).code === 'cancelled') {
          return result(this.update(runId, 'not-started', reason + ' 本次未启动。请关闭并重新确认。'))
        }
      } catch { /* durable state unknown */ }
      return result(this.update(runId, 'unresolved', '无法核对本地状态；不要重新发车。'))
    }

    this.preparing.add(runId)
    let promptFile: string | undefined
    let promptDir: string | undefined
    let handedToChild = false
    let claimed = false
    const cleanup = () => {
      try { if (promptFile) unlinkSync(promptFile) } catch { /* file may already be closed/removed */ }
      try { if (promptDir) rmdirSync(promptDir) } catch { /* no recursive removal */ }
    }
    try {
      if (this.delegation.launchEvidence(runId).some(r => r.kind === 'manual-copy')) {
        return result(this.update(runId, 'unresolved', '交接文本可能已复制或发送，请核对客户端。不能重新发车。'))
      }
      if (this.delegation.outcome(runId)?.mode === 'resume' && !resumeTarget) {
        return result(this.update(runId, 'unresolved', '任务已有绑定，请核对原会话后确认续接。'))
      }
      if (mode === 'manual') {
        if (this.manual.size >= 16) return doneBeforeSpawn('当前待交接项过多。')
        const cwd = realCwd(c.cwd)
        const canMatch = process.platform === 'win32' && profile.type === 'codex' && !profile.logOverride &&
          profile.logPath.toLowerCase() === defaultCodexLog().toLowerCase() && this.uniqueCodexProfile(profile.id)
        this.manual.set(runId, { request: structuredClone(request), revision, text: c.text, cwd, canMatch, candidates: new Map() })
        const timer = setTimeout(() => {
          const manual = this.manual.get(runId)
          if (!manual || this.closing) return
          this.manual.delete(runId)
          if (!manual.copied) doneBeforeSpawn('未复制的交接确认已过期。')
          else this.update(runId, 'unresolved', '交接核对时间已结束。请在客户端核对原会话。', {canMatch:false})
        }, handoffWindow)
        timer.unref()
        return result(this.update(runId, 'handoff-ready', '请显式复制文本，再自行打开选定客户端。当前未发送。', { canMatch }))
      }
      if (this.active.size + this.preparing.size > 4) return doneBeforeSpawn('当前受管请求过多。')
      this.update(runId, 'starting', '正在核对 CLI 与工作目录。')
      const plan = await prepareCli(c, profile)
      if (this.closing) return doneBeforeSpawn('应用正在退出。')
      if (resumeProof && (resumeProof.record.kind !== plan.kind || resumeProof.record.binarySha !== plan.binarySha ||
          resumeProof.record.cwd !== plan.cwd || resumeProof.record.model !== plan.model ||
          resumeProof.record.effort !== plan.effort)) return doneBeforeSpawn('目录、模型或适配器与上一轮不同。')
      if (plan.kind === 'grok-cli') {
        promptDir = mkdtempSync(join(tmpdir(), 'naw-delegation-'))
        promptFile = join(promptDir, 'prompt.utf8')
        const bytes = Buffer.from(c.text, 'utf8')
        writeFileSync(promptFile, bytes, { flag: 'wx', mode: 0o600 })
        if (!readFileSync(promptFile).equals(bytes)) throw new Error('无法验证 UTF-8 文件原文。')
      }
      const args = argv(plan, promptFile, resumeTarget)
      readProfile()
      verifyPlan(plan)
      if (resumeTarget && (!previousRunId || !this.resumeProof(previousRunId, resumeTarget))) {
        return doneBeforeSpawn('原会话在核对期间已发生变化。')
      }
      const record = { ...confirmation, profileId: c.agentId, blockId: c.blockId, noteId: c.noteId,
        sourceRevision: c.revision, startedAt: Date.now(), digest: hash(c.text), kind: plan.kind, cwd: plan.cwd,
        version: plan.version, model: plan.model, effort: plan.effort, binarySha: plan.binarySha,
        watermark: resumeProof?.watermark, previousRequestId: resumeProof?.previousRequestId, previousTurnCount: resumeProof?.previousTurnCount }
      const claim = resumeTarget
        ? this.delegation.claimForResume(request, { ...record, target: resumeTarget })
        : this.delegation.claimForNewDispatch(request, record)
      if (claim.code !== 'claimed' || !('confirmed' in claim)) {
        if (claim.code === 'resume-unverified') return result(this.update(runId, 'unresolved', '任务已有绑定，无法核对当轮续接许可。'))
        return result(this.update(runId, 'unresolved', '未获得当轮发车许可（'+claim.code+'）。请核对原记录。'))
      }
      claimed = true
      if (claim.mode !== (resumeTarget ? 'resume' : 'new') || (claim.externalId ?? undefined) !== resumeTarget || claim.runId !== runId || JSON.stringify(claim.confirmed) !== JSON.stringify(c)) {
        return result(this.update(runId, 'unresolved', '发车许可与已核验计划不一致；未调用程序。'))
      }
      const child = this.startProcess(plan.executable, args, { cwd: plan.cwd, env: launchEnvironment(),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      handedToChild = true
      this.watch(runId, { ...record, dispatchId: claim.dispatchId, target: resumeTarget }, plan, args, c.text, child, cleanup)
      return result(this.status(runId)!)
    } catch (error) {
      if (claimed) return result(this.update(runId, 'unresolved', '进入派发后未能核对启动结果。请核对原运行。'))
      return doneBeforeSpawn(preflightReason(error))
    } finally {
      this.preparing.delete(runId)
      if (!handedToChild) cleanup()
    }
  }

  private inspectCodex(record: DispatchRecord, id: string) {
    const createdNear = record.watermark ? this.createdNear(id) : record.startedAt
    if (!createdNear) return
    return codexTurn({ id, cwd: record.cwd, model: record.model, effort: record.effort, version: record.version,
      createdNear, startedAt: record.startedAt, digest: record.digest, watermark: record.watermark })
  }

  // Status-only projection: use exactly the observed ID of this dispatch.
  // Poll only while the application owns the live process.
  p10Observation(runId: string, record: DispatchRecord) {
    const entry = this.active.get(runId)
    const old = this.telemetry.get(runId)
    if (!entry || entry.exited || !entry.spawned) return old
    if (old && Date.now() - old.at < 1000) return old
    const o = this.delegation.readLaunchEvidence<Observation>(runId, 'cli-observed')
    const now = Date.now()
    let obs = { at: now, last: old?.last ?? record.startedAt, waits: old?.waits ?? [], stale: false }
    if (o && record.kind === 'codex' && observationValid(o, record.dispatchId) &&
        (!record.target || record.target === o.id) && !this.delegation.readLaunchEvidence(runId, 'cli-conflict')) {
      try {
        const turn = this.inspectCodex(record, o.id)
        if (turn && 'eventAt' in turn && turn.eventAt !== undefined && turn.waits) {
          obs = { at: now, last: turn.eventAt, waits: turn.waits, stale: false }
        } else if (old) return { ...old, stale: true }
      } catch { return old ? { ...old, stale: true } : undefined }
    }
    this.telemetry.set(runId, obs)
    return obs
  }

  private bind(runId: string, record: DispatchRecord, o: Observation) {
    const receipt = this.delegation.recordReceipt(runId, record.dispatchId, { verified: true,
      dispatchId: record.dispatchId, agentId: record.profileId, externalId: o.id, evidenceRef: o.ref })
    return receipt.code === 'bound' || receipt.code === 'receipt-replay'
  }

  private finish(runId: string, record: DispatchRecord, o: Observation, terminal: Terminal, basis?: Basis) {
    const saved = this.delegation.readLaunchEvidence<Terminal>(runId, 'terminal')
    if (saved && JSON.stringify(saved) !== JSON.stringify(terminal)) return false
    if (!saved) this.delegation.saveLaunchEvidence(runId, 'terminal', JSON.stringify(terminal))
    // Persist the display proof before finalizing. Readers still require the
    // finalized run, live binding, receipt, terminal reference and dispatch.
    if (basis && !this.delegation.readLaunchEvidence(runId, 'p10-basis')) {
      this.delegation.saveLaunchEvidence(runId, 'p10-basis', JSON.stringify({ ...basis,
        completionRef: terminal.ref, dispatchId: record.dispatchId, externalId: o.id }))
    }
    const result = this.delegation.finish(runId, record.dispatchId, { verified: true, dispatchId: record.dispatchId,
      agentId: record.profileId, externalId: o.id, evidenceRef: terminal.ref })
    return result.code === 'finished' || result.code === 'finish-replay'
  }

  private recoverDispatch(runId: string, noteId: string) {
    const id = this.delegation.identity(runId)
    const record = this.delegation.readLaunchEvidence<DispatchRecord>(runId, 'dispatch')
    const o = this.delegation.readLaunchEvidence<Observation>(runId, 'cli-observed')
    const conflict = this.delegation.readLaunchEvidence(runId, 'cli-conflict')
    if (!id || (id.run.phase !== 'bound' && id.run.phase !== 'dispatching') || !record ||
        record.mode !== 'cli' || record.dispatchId !== id.run.dispatch_id || record.blockId !== id.run.block_id ||
        record.noteId !== noteId || record.profileId !== id.run.agent_id || record.sourceRevision !== id.run.source_revision ||
        record.target !== id.targetExternalId ||
        !this.agents.delegationProfile(record.profileId)?.enabled ||
        this.agents.delegationProfile(record.profileId)?.revision !== record.profileRevision) return
    if (conflict) {
      this.update(runId, 'unresolved', '原进程的会话或轮次证据冲突；请对照诊断核对。', { externalId: id.externalId })
      return
    }
    if (!o || !observationValid(o, record.dispatchId) || (record.target && record.target !== o.id)) return
    const terminal = this.delegation.readLaunchEvidence<Terminal>(runId, 'terminal')
    let resolved: Terminal | undefined
    let basis: Basis | undefined
    if (record.kind === 'codex') {
      let turn
      try { turn = this.inspectCodex(record, o.id) }
      catch {
        this.update(runId, 'unresolved', '原 ID 的日志暂时无法唯一核对。请稍后再查。', { externalId: id.externalId })
        return
      }
      if (turn && 'ambiguous' in turn) {
        this.update(runId, 'unresolved', '匹配到多个轮次证据，未补绑或续接。请在原客户端核对。', { externalId: id.externalId })
        return
      }
      if (!turn && id.run.phase === 'dispatching') return
      if (!this.delegation.readLaunchEvidence(runId, 'cli-failure') && turn?.ref && turn.watermark && (!terminal || (terminal.turnId === turn.turnId &&
          terminal.watermark?.sha256 === turn.watermark.sha256))) {
        resolved = terminal ?? { dispatchId: record.dispatchId, ref: turn.ref, turnId: turn.turnId, watermark: turn.watermark }
        basis = turn.basis
      }
    } else {
      if (!o.requestId || !externalUuid.test(o.requestId) || record.previousRequestId === o.requestId ||
          this.delegation.hasOtherProviderRequest(runId, o.id, o.requestId)) return
      const head = grokHead(o.id, record.cwd)
      if (!head || head.requestId !== o.requestId || head.turnCount !== (record.previousTurnCount ?? 0) + 1) return
      const end = this.delegation.readLaunchEvidence<{ dispatchId: string; ref: string }>(runId, 'grok-end')
      if (!this.delegation.readLaunchEvidence(runId, 'cli-stop') && end?.dispatchId === record.dispatchId && end.ref === o.ref) {
        resolved = terminal ?? { dispatchId: record.dispatchId, ref: o.ref, providerRequestId: o.requestId, turnCount: head.turnCount }
        try { basis = grokConclusion(o.id,record.cwd,o.requestId,record.startedAt,head.turnCount) } catch { /* display unknown */ }
      }
    }
    if (!this.bind(runId, record, o)) return
    if (resolved?.dispatchId === record.dispatchId && this.finish(runId, record, o, resolved, basis)) this.views.delete(runId)
    else this.update(runId, 'unresolved', '已核对原派发和外部会话。仍缺本轮终态，不能续接。', { externalId: o.id })
  }

  private watch(runId: string, record: DispatchRecord, plan: Plan, args: string[], text: string,
    child: ChildProcess, cleanup: () => void) {
    const { dispatchId } = record
    const entry: Active = { child, spawned: false, exited: false }
    this.active.set(runId, entry)
    this.update(runId, 'starting', '正在启动已核验的 CLI。')
    let externalId: string | undefined
    let receiptRef = '', completionRef = '', errorCode = '', requestId: string | undefined
    let errorAt: number | undefined
    let providerAuthCode: '401' | '403' | undefined
    let omittedDetail = false
    let bindSoon: ReturnType<typeof setTimeout> | undefined
    const observation = (): Observation | undefined => externalId && receiptRef
      ? { dispatchId, id: externalId, ref: receiptRef, requestId } : undefined
    const invalidate = (reason: string) => {
      bad = true
      if (!this.closing && !this.delegation.readLaunchEvidence(runId, 'cli-conflict')) {
        this.delegation.saveLaunchEvidence(runId, 'cli-conflict', JSON.stringify({ dispatchId, reason }))
      }
    }
    const bindEarly = () => {
      try {
        const o = observation()
        if (this.closing || !o || bad || !entry.spawned || entry.exited || !this.active.has(runId)) return
        let turn
        try { turn = this.inspectCodex(record, o.id) } catch { /* wait for an intact log */ }
        if (turn && 'ambiguous' in turn) { invalidate('multiple rounds in provider log'); return }
        if (!turn) { bindSoon = setTimeout(bindEarly, 200); bindSoon.unref(); return }
        if (this.bind(runId, record, o)) {
          const view = this.views.get(runId)
          if (view?.state === 'running') this.update(runId, 'running', '已收到本轮会话 ID，正在等待结束证据。',
            { externalId: o.id, cancellable: view.cancellable })
        }
      } catch { bad = true }
    }
    let bad = false, declaredFailure = false, auth = false, permission = false, unsupportedModel = false
    let stdoutBytes = 0, stderrBytes = 0, eventCount = 0
    let buffer = '', stderrPrefix = ''
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const decode = new StringDecoder('utf8')
    const safeArgs = args.map((arg, index) => args[index-1] === '--prompt-file' ? '<private UTF-8 file>' : arg)
    const technicalReceipt = (extra: object) => JSON.stringify({ adapter: plan.kind, version: plan.version,
      model: plan.model, effort: plan.effort, cwd: plan.cwd, argv: safeArgs, dispatchId, stdoutBytes, stderrBytes,
      eventCount, externalId, receiptRef:receiptRef || undefined, completionRef:completionRef || undefined, ...extra })
    const classify = (message: unknown) => {
      if (typeof message !== 'string') return
      auth ||= authError.test(message)
      permission ||= ioError.test(message)
      unsupportedModel ||= modelError.test(message)
    }
    const event = (line: string) => {
      if (!line.trim()) return
      eventCount++
      if (this.closing) return
      try {
        const e = JSON.parse(line)
        if (!e || typeof e.type !== 'string') { invalidate('invalid event shape'); return }
        const ref = 'cli/'+dispatchId+'/stdout/'+eventCount+'#'+hash(line)
        const isCodex = plan.kind === 'codex'
        if (e.type === (isCodex ? 'thread.started' : 'end')) {
          const id = isCodex ? e.thread_id : e.sessionId
          if (!entry.spawned || typeof id !== 'string' || !externalUuid.test(id) || externalId ||
              (record.target !== undefined && record.target !== id) || (!isCodex && (
            typeof e.cwd !== 'string' || realCwd(e.cwd) !== plan.cwd ||
            typeof e.requestId !== 'string' || !externalUuid.test(e.requestId) || e.requestId === record.previousRequestId ||
            this.delegation.hasOtherProviderRequest(runId, id, e.requestId)))) {
            invalidate('invalid or conflicting provider identity'); return
          }
          externalId = id; receiptRef = ref; requestId = isCodex ? undefined : e.requestId
          if (bad) return
          this.delegation.saveLaunchEvidence(runId, 'cli-observed', JSON.stringify(observation()))
          if (!isCodex && !entry.stop && e.stopReason === 'end_turn' && e.modelUsage?.[plan.model]?.modelCalls >= 1 && !declaredFailure) {
            completionRef = ref
            this.delegation.saveLaunchEvidence(runId, 'grok-end', JSON.stringify({ dispatchId, ref }))
          }
          if (isCodex && !bindSoon) { bindSoon = setTimeout(bindEarly, 0); bindSoon.unref() }
        }
        if (isCodex && e.type === 'turn.completed') {
          if (!externalId || completionRef) invalidate('invalid terminal ordering')
          completionRef = ref
        }
        if (e.type === 'error' || e.type === 'turn.failed' || e.type === 'max_turns_reached' ||
            (e.type === 'item.completed' && e.item?.type === 'error')) {
          if (!declaredFailure) this.delegation.saveLaunchEvidence(runId, 'cli-failure', JSON.stringify({ dispatchId, type: e.type }))
          declaredFailure = true
          const message = e.message ?? e.error?.message ?? e.item?.message
          if (typeof message === 'string' && message !== '') omittedDetail = true
          // Only a complete, exact provider error field can carry a diagnostic
          // code; substrings in stderr/logs are merely existing status hints.
          if (message === '401 Unauthorized') providerAuthCode = '401'
          if (message === '403 Forbidden') providerAuthCode = '403'
          classify(message)
        }
      } catch { try { invalidate('invalid JSON event or observation write') } catch { bad = true } }
    }
    const timer = setTimeout(() => this.stop(runId, entry, 'timeout'), this.deadlineMs)
    child.once('spawn', () => {
      entry.spawned = true
      if (this.closing || entry.stop) { entry.stop = undefined; this.stop(runId, entry, 'user'); return }
      this.update(runId, 'running', 'CLI 已启动，正在等待本轮证据。', { cancellable: true })
    })
    child.once('exit', () => {
      entry.exited = true
      this.update(runId, 'stopping', '进程已退出，正在核对本轮证据。')
      // A descendant can retain inherited pipes after the owned process exits.
      // End observation, without killing that descendant or trusting partial stdout.
      drainTimer = setTimeout(() => {
        bad = true
        child.stdout!.destroy()
        child.stderr!.destroy()
      }, 2500)
      drainTimer.unref()
    })
    child.on('error', (err: NodeJS.ErrnoException) => { errorCode = err.code ?? 'spawn-error'; errorAt = Date.now() })
    child.stdout!.on('data', (bytes: Buffer) => {
      stdoutBytes += bytes.length
      if (stdoutBytes > 8_000_000) { bad = true; this.stop(runId, entry, 'output'); return }
      const lines = (buffer + decode.write(bytes)).split('\n')
      buffer = lines.pop()!
      for (const line of lines) event(line.replace(/\r$/, ''))
    })
    child.stderr!.on('data', (bytes: Buffer) => {
      stderrBytes += bytes.length
      if (bytes.length) omittedDetail = true
      stderrPrefix = (stderrPrefix + bytes.toString('utf8')).slice(-16_384)
      classify(stderrPrefix)
      if (stderrBytes > 8_000_000) this.stop(runId, entry, 'output')
    })
    child.stdin!.on('error', () => { if (plan.kind === 'codex') bad = true })
    child.stdin!.end(plan.kind === 'codex' ? text : undefined, 'utf8')
    child.once('close', (exitCode, signal) => {
      const observedAt = Date.now()
      clearTimeout(timer)
      clearTimeout(drainTimer)
      clearTimeout(bindSoon)
      cleanup()
      this.active.delete(runId)
      this.telemetry.delete(runId)
      event((buffer + decode.end()).replace(/\r$/, ''))
      if (this.closing) return
      const receipt = technicalReceipt({ exitCode, signal,
        diagnosticV1: closeFact(runId, record, entry.spawned, errorCode, observedAt, errorAt, providerAuthCode, omittedDetail), stop: entry.stop, auth, permission, unsupportedModel, protocolInvalid: bad,
        declaredFailure, observedEnd: entry.stop === 'user' && entry.exited ? Date.now() : undefined, spawnRefused: isSpawnRefusal(errorCode) })
      try {
        this.delegation.saveLaunchEvidence(runId, 'cli-exit', receipt)
        if (!entry.spawned && isSpawnRefusal(errorCode) && this.delegation.abortUnstarted(runId, dispatchId)) {
          this.update(runId, 'not-started', '系统拒绝启动 CLI（'+errorCode+'）。请检查路径与权限，再重新确认。')
          return
        }
        const o = observation()
        let bound = this.delegation.identity(runId)?.externalId === externalId && !!externalId
        if (!bad && entry.spawned && o) {
          let turn
          let head
          try {
            if (plan.kind === 'codex') turn = this.inspectCodex(record, o.id)
            else head = grokHead(o.id, record.cwd)
          } catch { /* provider watermark unavailable; fail closed for continuation */ }
          if (turn && 'ambiguous' in turn) invalidate('multiple rounds in provider log')
          const grokProof = head?.requestId === o.requestId && head?.turnCount === (record.previousTurnCount ?? 0) + 1
          if (!bad && (!record.target || (plan.kind === 'codex' ? !!turn : grokProof))) {
            bound = this.bind(runId, record, o)
          }
          const terminal: Terminal = { dispatchId, ref: completionRef,
            watermark: turn && 'watermark' in turn ? turn.watermark : undefined,
            turnId: turn && 'turnId' in turn ? turn.turnId : undefined,
            providerRequestId: grokProof ? head?.requestId : undefined,
            turnCount: grokProof ? head?.turnCount : undefined }
          let basis = turn && 'basis' in turn ? turn.basis : undefined
          if (!bad && completionRef && grokProof && head && o.requestId && !entry.stop && exitCode === 0 && !declaredFailure) {
            try { basis = grokConclusion(o.id,record.cwd,o.requestId,record.startedAt,head.turnCount) } catch { /* display unknown */ }
          }
          if (!bad && bound && !entry.stop && exitCode === 0 && !declaredFailure && completionRef &&
              this.finish(runId, record, o, terminal, basis)) {
            this.update(runId, 'completed', '已绑定外部会话并观察到本轮结束。', { externalId })
            return
          }
        }
        const fields = { externalId: bound ? externalId : undefined }
        if (entry.stop === 'user') this.update(runId, 'stopped', '应用持有的进程已停止。请核对外部会话；不能直接重发。', fields)
        else if (entry.stop === 'timeout') this.update(runId, 'timed-out', '运行超过时间上限，受管进程已退出。请核对外部会话。', fields)
        else if (declaredFailure || exitCode !== 0 || entry.stop === 'output') this.update(runId, 'failed',
          (auth ? 'CLI 报告登录或认证失败。' : permission ? 'CLI 报告权限错误。' :
            unsupportedModel ? 'CLI 报告模型不可用。' : entry.stop === 'output' ? 'CLI 输出超过处理上限。' : 'CLI 回合失败。') +
          ' 已进入派发，须核对原运行后再处理。', fields)
        else this.update(runId, 'unresolved', '缺少唯一的会话或回合证据。不能重新发车。', fields)
      } catch {
        this.update(runId, 'unresolved', '无法保存或核对回执。请核对原运行。')
      }
    })
  }

  private stop(runId: string, entry: Active, why: Active['stop']) {
    if (this.active.get(runId) !== entry || entry.stop || entry.exited || !entry.spawned || entry.child.killed ||
        entry.child.exitCode !== null || entry.child.signalCode !== null) return
    try {
      if (!this.delegation.readLaunchEvidence(runId, 'cli-stop')) {
        this.delegation.saveLaunchEvidence(runId, 'cli-stop', JSON.stringify({ why, at: Date.now() }))
      }
      if (!entry.child.kill('SIGTERM')) throw new Error()
      entry.stop = why
      this.update(runId, 'stopping', '已请求停止，正在等待受管进程退出。')
    } catch { this.update(runId, 'unresolved', '无法确认停止请求。请核对原进程。') }
  }

  cancel(runId: unknown) {
    if (!runKey(runId)) return null
    const entry = this.active.get(runId)
    if (entry && this.views.get(runId)?.cancellable) this.stop(runId, entry, 'user')
    return this.status(runId)
  }

  private uniqueCodexProfile(id: string) {
    const writable = this.agents.delegationProfiles().filter(p => p.enabled && p.type === 'codex')
    return writable.length === 1 && writable[0].id === id
  }

  copyHandoff(runId: unknown) {
    if (!runKey(runId)) return null
    const ctx = this.manual.get(runId)
    if (!ctx || ctx.copied) return this.status(runId)
    const p = this.agents.delegationProfile(ctx.request.profileId)
    const checked = this.delegation.inspectForDispatch(ctx.request)
    if (!p?.enabled || p.revision !== ctx.revision || !('confirmed' in checked) || checked.confirmed.text !== ctx.text) {
      return this.update(runId, 'unresolved', '档案或笔记已变化。未复制，请重新核对。', {canMatch:false})
    }
    try {
      let before = new Set<string>()
      if (ctx.canMatch) {
        try { before = new Set(rolloutFiles(defaultCodexLog(), Date.now()).keys()) }
        catch { ctx.canMatch = false }
      }
      // Durable marker precedes clipboard. A crash thereafter cannot turn a
      // potentially sent manual request into an automatic retry.
      const at = Date.now()
      if (!this.delegation.markManualCopy(runId, JSON.stringify({ at, profileId: p.id, cwd: ctx.cwd, digest: hash(ctx.text) }))) throw new Error()
      ctx.copied = { at, before }
      this.writeClipboard(ctx.text)
      return this.update(runId, 'handoff-copied', '文本已复制。请在指定目录新开会话，自行粘贴并发送。复制不代表发送。', {canMatch:ctx.canMatch})
    } catch { return this.update(runId, 'unresolved', '无法核对复制结果，未绑定会话。', {canMatch:false}) }
  }

  findHandoff(runId: unknown): HandoffMatches {
    const none = (reason: string) => ({ candidates: [], reason })
    if (!runKey(runId)) return none('运行无效。')
    const ctx = this.manual.get(runId)
    if (!ctx?.copied || !ctx.canMatch || !this.uniqueCodexProfile(ctx.request.profileId)) {
      return none('该客户端日志或档案归属无法核对；请在客户端自行定位。')
    }
    ctx.candidates.clear()
    try {
      const matches = matchRollouts(defaultCodexLog(), ctx.copied.at, ctx.copied.before, ctx.text, ctx.cwd)
      const candidates = matches.filter(match=>!this.delegation.sessionRemoved(ctx.request.profileId,match.externalId)).map(match => {
        const token = randomUUID()
        ctx.candidates.set(token, match)
        return { token, externalId: match.externalId, at: match.at }
      })
      return { candidates, reason: candidates.length ? '请选择并核对你实际发送的会话。' : '未找到同目录、同首条消息的新会话；没有绑定。' }
    } catch { return none('日志暂时无法核对，或交接时间已结束；没有绑定。') }
  }

  linkHandoff(runId: unknown, token: unknown) {
    if (!runKey(runId) || !runKey(token)) return null
    const ctx = this.manual.get(runId)
    const candidate = ctx?.candidates.get(token)
    if (!ctx?.copied || !candidate || this.delegation.sessionRemoved(ctx.request.profileId,candidate.externalId) || !this.uniqueCodexProfile(ctx.request.profileId)) return this.status(runId)
    ctx.candidates.clear()
    try {
      const p = this.agents.delegationProfile(ctx.request.profileId)
      if (!p?.enabled || p.revision !== ctx.revision || p.logOverride ||
          p.logPath.toLowerCase() !== defaultCodexLog().toLowerCase()) throw new Error()
      const fresh = matchRollouts(defaultCodexLog(), ctx.copied.at, ctx.copied.before, ctx.text, ctx.cwd)
      if (!fresh.some(c => c.externalId === candidate.externalId && c.ref === candidate.ref)) throw new Error()
      const claim = this.delegation.claimForNewDispatch(ctx.request)
      if (claim.code !== 'claimed' || !('confirmed' in claim) || claim.runId !== runId || claim.mode !== 'new' ||
          claim.confirmed.text !== ctx.text) throw new Error()
      const evidenceRef = 'manual/'+claim.dispatchId+'/'+candidate.ref
      this.delegation.saveLaunchEvidence(runId, 'manual-link', JSON.stringify({ evidenceRef, externalId: candidate.externalId,
        cwd:ctx.cwd, profileRevision:p.revision, logPath:p.logPath }))
      const receipt = this.delegation.recordReceipt(runId, claim.dispatchId, { verified:true, dispatchId:claim.dispatchId,
        agentId:p.id, externalId:candidate.externalId, evidenceRef })
      if (receipt.code !== 'bound') throw new Error()
      this.manual.delete(runId)
      return this.update(runId, 'handoff-linked', '已绑定你选定并核对的外部会话。', { externalId:candidate.externalId, canMatch:false })
    } catch { return this.update(runId, 'unresolved', '会话或任务证据已变化，未建立绑定。请核对原运行。', {canMatch:false}) }
  }
}
