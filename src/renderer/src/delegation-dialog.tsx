import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentProfile } from '../../shared/agents'
import { matchAgent, type DelegationTask } from '../../shared/delegation-markdown'
import type { DelegationAnchorResult, DelegationContext, DelegationRequest, DelegationSource as Source, HandoffMatches, LaunchView, LaunchReview } from '../../shared/delegation'

export type DelegationSource = Omit<Source, 'line' | 'rawLine' | 'blockId'>
type Stage = 'palette' | 'confirm'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
import { DiagnosticPanel } from './delegation-diagnostic'

const launchLabel: Record<LaunchView['state'], string> = {
  starting: '正在启动', running: '发车中', stopping: '正在核对退出', completed: '本轮已结束', failed: '运行失败',
  stopped: '受管进程已停止', 'timed-out': '运行超时', 'not-started': '未启动', unresolved: '待核对',
  'handoff-ready': '手动交接', 'handoff-copied': '已复制文本', 'handoff-linked': '已核对会话'
}
const live = (view?: LaunchView) => view && ['starting', 'running', 'stopping'].includes(view.state)

const resolveWorkdir = (cwd: string, ctx: DelegationContext) => {
  const value = cwd.trim()
  if (!/^~(?:[\\/]|$)/.test(value)) return value
  const sep = ctx.platform === 'win32' ? '\\' : '/'
  return ctx.home.replace(/[\\/]+$/, '') + (value.length > 1 ? sep + value.slice(2).replace(/[\\/]/g, sep) : '')
}

export function DelegationDialog({ stage, task, source, validate, adoptAnchor, close, preferred }: {
  preferred?: string; stage: Stage; task?: DelegationTask; source: DelegationSource; validate: () => boolean
  adoptAnchor: (anchor: Extract<DelegationAnchorResult, { status: 'saved' }>) => void; close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const paletteCommand = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const frozen = useRef<DelegationRequest | undefined>(undefined)
  const [step, setStep] = useState<Stage>(stage)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [context, setContext] = useState<DelegationContext>()
  const [profileId, setProfileId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [cwd, setCwd] = useState('')
  const [text, setText] = useState(task?.text ?? '')
  const editedText = useRef<HTMLTextAreaElement>(null)
  const textToggle = useRef<HTMLButtonElement>(null)
  const textPosition = useRef({start:0,end:0,scroll:0,direction:'none' as 'none'|'forward'|'backward'})
  const composition = useRef(false)
  const [editText, setEditText] = useState(false)
  const [submitError,setSubmitError]=useState('')
  const submitNotice=useRef<HTMLParagraphElement>(null)
  const [issue, setIssue] = useState('')
  const [result, setResult] = useState('')
  const [run, setRun] = useState<LaunchView>()
  const [mode, setMode] = useState<'cli'|'manual'>('cli')
  const [matches, setMatches] = useState<HandoffMatches>()
  const [picked, setPicked] = useState('')
  const [review, setReview] = useState<LaunchReview>()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const [sending, setSending] = useState(false)
  const [rejected, setRejected] = useState(false)
  const api = window.workbench.delegation
  const marker = task?.marker

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { element.close() }
  }, [])

  useLayoutEffect(() => {
    if (step === 'palette') (task ? paletteCommand : closeButton).current?.focus()
    else title.current?.focus()
  }, [step, task])
  useLayoutEffect(() => { if (result) closeButton.current?.focus() }, [result])
  useLayoutEffect(() => { if (confirmStop) dialog.current?.querySelector<HTMLButtonElement>('[data-stop-back]')?.focus() }, [confirmStop])
  useEffect(() => {
    if (!run || !live(run)) return
    const id = run.runId
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const next = await api.status(id)
        if (!current) return
        if (next) setRun(next)
        else setRun({ runId:id, state:'unresolved', cancellable:false, reason:'无法读取运行状态。请核对原运行。' })
        if (live(next ?? undefined)) timer = setTimeout(check, 400)
      } catch {
        if (current) setRun({ runId:id, state:'unresolved', cancellable:false, reason:'无法读取运行状态。请核对原运行。' })
      }
    }
    timer = setTimeout(check, 400)
    return () => { current = false; clearTimeout(timer) }
  }, [api, run?.runId, run?.state])
  useLayoutEffect(() => {if (submitError) submitNotice.current?.focus()},[submitError])
  useLayoutEffect(() => {
    if (!editText || !editedText.current) return
    const { start,end,scroll,direction } = textPosition.current
    editedText.current.focus()
    editedText.current.setSelectionRange(start,end,direction)
    editedText.current.scrollTop=scroll
  }, [editText])

  useLayoutEffect(() => {
    if (step !== 'confirm' || !marker || task?.issue) return
    let active = true
    const selected = task?.blockId && !source.draft ? api.review({
      ...source, line: task.line, rawLine: task.rawLine, blockId: task.blockId
    }) : Promise.resolve({ kind: 'new' } as const)
    void Promise.all([window.workbench.agents.list(), api.context(source.noteId), selected]).then(([list, ctx, plan]) => {
      if (!active) return
      setProfiles(list.filter((profile) => profile.enabled))
      setContext(ctx)
      setReview(plan)
      if (plan.kind === 'pending' && plan.confirmedMode) setMode(plan.confirmedMode)
      const matched = plan.kind === 'resume' && list.find(item => item.id === plan.profileId && item.enabled)
      const match = matchAgent(list, marker.agent)
      const picked=list.find(p=>p.id===preferred && p.enabled && [p.id,p.type].includes(marker.agent.toLowerCase()))
      if (matched || picked || match.status === 'matched') {
        const profile = matched || picked || (match.status === 'matched' ? match.profile : undefined)
        if (!profile) return
        setProfileId(profile.id)
        setModel(marker.model ?? profile.model)
        setEffort(marker.effort ?? profile.effort)
        setCwd(resolveWorkdir(marker.workdir ?? (profile.workdir || ctx.noteDirectory), ctx))
      } else if (match.status === 'ambiguous') {
        setIssue('有多个启用档案使用这个类型。请为本次请求选择 Agent；也可在笔记中使用档案 ID。')
      } else {
        setIssue(match.status === 'disabled' ? '标记对应的 Agent 档案已停用。' : '未找到标记对应的 Agent 档案。')
      }
    }, (error) => { if (active) setIssue('无法读取委派配置：'+errorText(error)) })
    return () => { active = false }
  }, [api, marker, preferred, source, step, task])

  const matchStatus = marker && context ? matchAgent(profiles, marker.agent).status : null
  const canChoose = matchStatus === 'matched' || matchStatus === 'ambiguous'
  const workdir = context ? resolveWorkdir(cwd, context) : ''
  const pathOk = context?.platform === 'win32' ? /^[a-z]:[\\/]/i.test(workdir) : workdir.startsWith('/')
  const oneLine = (s: string) => !/[\x00-\x1f\x7f-\x9f]/.test(s)
  const sourceError = !canChoose || !profiles.some(item=>item.id===profileId)
  const selectedProfile = profiles.find(item => item.id === profileId)
  const profileCwd = context ? resolveWorkdir(selectedProfile?.workdir || context.noteDirectory, context) : ''
  const samePath = cwd.trim().replace(/[\\/]+$/, '') === profileCwd.replace(/[\\/]+$/, '')
  const overrideCount = selectedProfile ? [!samePath, model.trim() !== selectedProfile.model,
    effort.trim() !== selectedProfile.effort].filter(Boolean).length : 0
  const pathError = !pathOk || !oneLine(workdir)
  const modelError = !oneLine(model), effortError = !oneLine(effort)
  // Newlines and tabs are part of the Markdown sent for review.
  const textError = !text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)
  const canAnchor = !!task?.marker && !task.issue && !task.blockId && !source.draft && !rejected
  const reviewError = !review ? '正在核对原运行' : review.kind === 'blocked' ? review.reason :
    review.kind === 'pending' && !review.canContinue ? '本轮须先核对运行。' :
    review.kind === 'resume' && (profileId !== review.profileId || mode !== 'cli') ? '续接须使用原档案和 CLI。' : ''
  const valid = !reviewError && !!task?.blockId && !source.draft && !rejected && !sourceError && !pathError && !modelError && !effortError && !textError
  const blocked = sending ? '正在确认' : source.draft ? '请先保存笔记，再重新打开委派。' : task?.issue ? '委派标记有误' : rejected ? '请关闭后重新核对。' : !context ? (issue || '等待档案与目录')
    : reviewError ? reviewError : sourceError ? '请选择有效档案' : pathError ? '工作目录无效'
      : modelError || effortError ? '模型与强度须为单行' : textError ? '发送文本无效' : ''


  function choose(id: string) {
    const profile = profiles.find((item) => item.id === id)
    if (!profile || !context) return
    const sameSelector = marker && [profile.id, profile.type].includes(marker.agent.toLowerCase())
    setProfileId(id)
    setModel((sameSelector && marker.model) || profile.model)
    setEffort((sameSelector && marker.effort) || profile.effort)
    setCwd(resolveWorkdir((sameSelector && marker.workdir) || profile.workdir || context.noteDirectory, context))
    setIssue('')
  }

  async function submit() {
    if (!valid || !task || result || submitting.current || composition.current) return
    if (!frozen.current && !validate()) { setIssue('选区已变化，请重新选择'); return }
    submitting.current = true
    setSending(true)
    setSubmitError('')
    try {
      const request: DelegationRequest = frozen.current ??= {
        version: 2, intentId: crypto.randomUUID(), source: { ...source, line: task.line, rawLine: task.rawLine, blockId: task.blockId! }, profileId,
        model: model.trim() || null, effort: effort.trim() || null, cwd: workdir,
        ...(text === task.text ? {} : { textOverride: text })
      }
      const profile = profiles.find(p => p.id === profileId)!
      const expected = review?.kind === 'resume' ? { kind: 'resume' as const, runId: review.runId } :
        review?.kind === 'pending' ? { kind: 'reserved' as const, runId: review.view.runId } : undefined
      const outcome = expected ? await api.start(request, profile.delegationRevision, mode, expected) :
        await api.start(request, profile.delegationRevision, mode)
      if (outcome.status === 'run') { setRun(outcome.view); setResult('已取得运行记录') }
      else { setSubmitError(outcome.reason); setRejected(true) }
    } catch {
      setResult('未能确认请求结果。请核对原运行，避免重复发送。')
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  async function action(which: 'cancel'|'copy'|'find'|'link') {
    if (!run || submitting.current || composition.current) return
    submitting.current = true
    setSending(true)
    setActionNote('')
    try {
      if (which === 'find') { setPicked(''); setMatches(await api.findHandoff(run.runId)); return }
      const next = await (which === 'cancel' ? api.cancel(run.runId) :
        which === 'copy' ? api.copyHandoff(run.runId) : api.linkHandoff(run.runId, picked))
      if (next) setRun(next)
      else setActionNote('无法核对该运行。')
      if (which === 'link') { setPicked(''); setMatches(undefined) }
    } catch { setActionNote('动作结果未知，请核对当前记录。') }
    finally {
      if (which === 'cancel') { setConfirmStop(false); closeButton.current?.focus() }
      submitting.current = false
      setSending(false)
    }
  }

  async function recover(discard: boolean) {
    if (!task?.blockId || review?.kind !== 'pending' || submitting.current || composition.current || !validate()) return
    submitting.current = true
    setSending(true)
    setActionNote('')
    try {
      const selection = { ...source, line: task.line, rawLine: task.rawLine, blockId: task.blockId }
      const next = await (discard ? api.discardReservation : api.reconcile)(selection, review.view.runId)
      setReview(next)
      setActionNote(next.kind === 'resume' ? '已核实原轮终态。可另行确认续接。' :
        next.kind === 'pending' ? next.view.reason : discard ? '已关闭原本地确认。' : '')
    } catch { setActionNote('无法核对原运行，请重新打开确认。') }
    finally {
      setConfirmDiscard(false)
      submitting.current = false
      setSending(false)
      title.current?.focus()
    }
  }

  async function addAnchor() {
    if (!canAnchor || !task || submitting.current || composition.current) return
    if (!validate()) { setIssue('选区已变化，请重新选择'); return }
    submitting.current = true
    setSending(true)
    setSubmitError('')
    try {
      const outcome = await api.addAnchor({ ...source, line: task.line, rawLine: task.rawLine })
      if (outcome.status === 'saved') adoptAnchor(outcome)
      else { setSubmitError(outcome.reason); setRejected(true) }
    } catch (error) {
      setSubmitError('无法核对标记保存结果，请读取磁盘版本：' + errorText(error))
      setRejected(true)
    } finally { submitting.current = false; setSending(false) }
  }

  return <dialog ref={dialog} className="delegation-dialog" aria-labelledby="delegation-title" onCancel={(event) => {
    event.preventDefault()
    if (!composition.current && !submitting.current) {
      if (confirmDiscard) { setConfirmDiscard(false); closeButton.current?.focus() }
      else if (confirmStop) { setConfirmStop(false); closeButton.current?.focus() }
      else close()
    }
  }} onCompositionStart={()=>{composition.current=true}}
    onCompositionEnd={()=>{setTimeout(()=>{composition.current=false},0)}}
    onKeyDown={(event) => {
      event.stopPropagation()
      const composing = event.nativeEvent.isComposing || composition.current || event.keyCode===229
      if ((composing && event.key === 'Escape') ||
          ((event.repeat || composing) && (event.key === 'Enter' || event.key === ' ') &&
           event.target instanceof HTMLButtonElement) ||
          (event.repeat && event.key === 'Escape')) event.preventDefault()
    }}>
    <header>
      <h2 ref={title} tabIndex={-1} id="delegation-title">{result ? '委派结果 · '+(run ? launchLabel[run.state] : '待核对') : step === 'palette' ? '命令面板' : '确认委派'}</h2>
    </header>
    {step === 'palette' ? <section className="delegation-content">
      <button type="button" ref={paletteCommand} disabled={!task} onClick={() => setStep('confirm')}>{task?.issue?'查看指令问题':'委派此行'}</button>
      <p>{task ? '第 ' + task.line + ' 行' : '光标行没有可委派的标记。'}</p>
    </section> : task && <section className="delegation-content">
      <p>第 {task.line} 行{source.draft ? ' · 当前正文未保存' : ''} · 包含 {task.includedLines.length} 行
        {task.excludedRoots.length ? ' · 已排除独立子项（第 ' + task.excludedRoots.join('、') + ' 行）及其下级' : ''}</p>
      <details><summary>来源详情</summary><p>笔记 {source.noteId} · 源行 {task.includedLines.join('、')}</p><pre>{task.rawLine}</pre></details>
      {(task.issue || issue) && <p role="alert">{task.issue || issue}</p>}
      {submitError && <p ref={submitNotice} tabIndex={-1} role="alert">{submitError}</p>}
      {!context && marker && !task.issue && !issue && <p role="status">正在读取 Agent 档案…</p>}
      {!task.blockId && !source.draft && !task.issue && <p>先在本行保存隐藏的 Markdown 任务标记，再确认委派。保存后会清除当前笔记的撤销记录。</p>}
      {!result && review?.kind === 'resume' && <div className="delegation-action">
        <p>续接原会话 <code>{review.externalId}</code></p><p>上一轮 <code>{review.runId}</code> 已结束。确认后在同一会话开启新轮。</p>
      </div>}
      {!result && review?.kind === 'pending' && <div className="delegation-action">
        <p>原运行 <code>{review.view.runId}</code> · {launchLabel[review.view.state]}</p>
        {review.view.externalId && <p>外部会话 <code>{review.view.externalId}</code></p>}
        <p>{review.view.reason}</p>
        {review.canContinue && <p>本地只保存确认摘要。恢复发车前，请重现原文本和参数。</p>}
        {review.phase !== 'reserved' && <button type="button" disabled={sending} onClick={() => void recover(false)}>核对原运行</button>}
        {review.canDiscard && (confirmDiscard ? <>
          <p>关闭这条未发车的确认？</p>
          <button type="button" disabled={sending} onClick={() => {setConfirmDiscard(false); title.current?.focus()}}>返回</button>
          <button type="button" disabled={sending} onClick={() => void recover(true)}>确认关闭原预占</button>
        </> : <button type="button" disabled={sending} onClick={() => setConfirmDiscard(true)}>关闭原预占</button>)}
        {review.view.hasDiagnostic && <DiagnosticEntry key={review.view.runId} runId={review.view.runId}
          source={{...source, blockId: task?.blockId, line: task!.line, rawLine: task!.rawLine}} />}
      </div>}
      {!result && actionNote && <p role="status">{actionNote}</p>}
      {task.blockId && canChoose && !result && <fieldset className="delegation-fields" disabled={sending || rejected}>
        <small id="delegation-select-help" className="delegation-visually-hidden">更换档案会重设目录、模型和强度，保留实际发送文本。</small>
        <div className="delegation-profile"><label htmlFor="delegation-profile">Agent</label>
        <select id="delegation-profile" aria-describedby="delegation-select-help" aria-invalid={sourceError} value={profileId} onChange={(event) => choose(event.target.value)}>
          <option value="" disabled>选择 Agent</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>
            {profile.name} · {profile.type} · {profile.id.slice(0, 8)}
          </option>)}
        </select></div>
        <details className="delegation-overrides" ref={node=>{
          if(node && profileId && (pathError||modelError||effortError))node.open=true
        }}><summary>本次覆盖{overrideCount > 0 &&
          <span className="delegation-override-badge" aria-label={`${overrideCount} 项覆盖`}>{overrideCount}</span>}</summary>
          <div className="delegation-overrides-fields">
        {profileId && <p>档案 ID <code>{profileId}</code></p>}
        <label>工作目录<input aria-invalid={pathError && !!profileId} aria-describedby="delegation-cwd-help" value={cwd} title={workdir} onChange={(event) => setCwd(event.target.value)} /></label>
        <label>模型<input value={model} aria-invalid={modelError} aria-describedby={modelError?"delegation-model-error":undefined} placeholder="使用 Agent 默认"
          onChange={(event) => setModel(event.target.value)} /></label>
        <label>强度<input value={effort} aria-invalid={effortError} aria-describedby={effortError?"delegation-effort-error":undefined} placeholder="使用 Agent 默认"
          onChange={(event) => setEffort(event.target.value)} /></label>
        {modelError && <small id="delegation-model-error">模型不能包含控制字符。</small>}
        {effortError && <small id="delegation-effort-error">强度不能包含控制字符。</small>}
        {profileId && <p id="delegation-cwd-help" className="delegation-cwd">{!pathError
          ? <>实际工作目录：<code>{workdir}</code></> : '请输入本机绝对路径。'}</p>}
        </div></details>
        <fieldset className="delegation-mode">
          <legend>委派方式</legend>
          <div className="delegation-segments">
            <label><input type="radio" name="delegation-mode" value="cli" checked={mode === 'cli'}
              onChange={() => setMode('cli')} /><span>后台执行</span></label>
            <label><input type="radio" name="delegation-mode" value="manual" checked={mode === 'manual'}
              onChange={() => setMode('manual')} /><span>发到原桌面会话</span></label>
          </div>
        </fieldset>
        <p className="delegation-cwd">{mode === 'cli' ? (review?.kind === 'resume' ? '确认后按同样的最小权限续接。' : '确认后在后台运行，中途不需要切窗或粘贴。') : '确认后复制交接文本；在目标原会话完成接收后，回来核对会话。'}</p>
      </fieldset>}
      <div className="delegation-preview-heading">
        <h3 id="delegation-text">实际发送文本</h3>
        {task.blockId && canChoose && !result && <button type="button" ref={textToggle} disabled={sending || rejected} onClick={() => {
          const input=editedText.current
          if (input) textPosition.current={ start:input.selectionStart,end:input.selectionEnd,
            scroll:input.scrollTop,direction:input.selectionDirection }
          setEditText(!editText)
          if (editText) textToggle.current?.focus()
        }}>
          {editText ? '查看文本' : '修改文本'}
        </button>}
      </div>
      {editText && !result
        ? <textarea ref={editedText} aria-invalid={textError} aria-describedby={textError?"delegation-blocked":undefined} aria-labelledby="delegation-text" disabled={sending || rejected} value={text.replace(/\r\n?/g, '\n')} onChange={(event) => {
          setText(previous => preserveLineEndings(previous, event.target.value))
        }} />
        : <pre aria-labelledby="delegation-text" tabIndex={0}>{text}</pre>}
      {result && <><p>本次档案 <code>{profileId}</code> · {model || '默认模型'} · {effort || '默认强度'}</p>
        <p>工作目录 <code>{workdir}</code></p><p role="status">{run?.reason ?? result}</p>
        {run?.externalId && <p>外部会话 <code>{run.externalId}</code></p>}
        {run?.state === 'handoff-ready' && <>
          <p>交接文本已准备好。复制到目标原会话并完成接收后，回来核对会话。</p>
          <button type="button" disabled={sending} onClick={() => void action('copy')}>复制交接文本</button>
        </>}
        {run?.state === 'handoff-copied' && (run.canMatch ?
          <button type="button" disabled={sending} onClick={() => void action('find')}>查找手动发送的会话</button> :
          <p>请自行打开对应客户端。目前无法验证该档案的会话归属。</p>)}
        {matches && <fieldset className="delegation-action" disabled={sending}>
          <legend>交接候选</legend><p role="status">{matches.reason}</p>
          {matches.candidates.map(candidate => <label key={candidate.token}>
            <input type="radio" name="handoff-match" checked={picked === candidate.token} onChange={() => setPicked(candidate.token)} />
            <code>{candidate.externalId}</code> · {new Date(candidate.at).toLocaleString()}
          </label>)}
          {!!matches.candidates.length && <button type="button" disabled={!picked} onClick={() => void action('link')}>确认绑定所选会话</button>}
        </fieldset>}
        {confirmStop && run && <div className="delegation-action">
          <p>仅停止应用为运行 <code>{run.runId}</code> 启动的进程。请核对后确认。</p>
          <button type="button" data-stop-back disabled={sending} onClick={() => {setConfirmStop(false); closeButton.current?.focus()}}>返回</button>
          <button type="button" className="button-danger" disabled={sending || !run.cancellable} onClick={() => void action('cancel')}>确认取消</button>
        </div>}
        {run?.cancellable && !confirmStop && <button type="button" disabled={sending} onClick={() => setConfirmStop(true)}>取消运行</button>}
        {run?.hasDiagnostic && frozen.current && <DiagnosticEntry key={run.runId} runId={run.runId} source={frozen.current.source} />}
        {actionNote && <p role="status">{actionNote}</p>}
        </>}
    </section>}
    <footer>
      <button type="button" ref={closeButton} disabled={sending} onClick={close}>{result ? '关闭' : '取消'}</button>
      {step === 'confirm' && !result && blocked && <small id="delegation-blocked" role="status">{blocked}</small>}
      {step === 'confirm' && !result && <button type="button" className="button-primary" aria-disabled={(task?.blockId ? !valid : !canAnchor) || sending}
        aria-describedby={blocked?'delegation-blocked':undefined} onClick={() => void (task?.blockId ? submit() : addAnchor())}>
        {sending ? '正在确认…' : task?.blockId ? (review?.kind === 'resume' ? '确认续接' : review?.kind === 'pending' && review.canContinue
          ? '确认继续原预占' : mode === 'cli' ? '确认发车' : '确认交接') : '写入任务标记'}
      </button>}
    </footer>
  </dialog>
}

function preserveLineEndings(previous: string, next: string) {
  const normalized = previous.replace(/\r\n?/g, '\n')
  let start = 0, from = normalized.length, to = next.length
  while (start < from && start < to && normalized[start] === next[start]) start++
  while (from > start && to > start && normalized[from - 1] === next[to - 1]) { from--; to-- }
  const points = [0]
  for (let i = 0; i < previous.length;) {
    if (previous[i++] === '\r' && previous[i] === '\n') i++
    points.push(i)
  }
  return previous.slice(0, points[start]) + next.slice(start, to).replaceAll('\n', previous.match(/\r\n|\r|\n/)?.[0] ?? '\n') + previous.slice(points[from])
}

function DiagnosticEntry({ runId, source }: { runId: string; source: Source }) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  return <>
    <button type="button" ref={opener} aria-expanded={open} onClick={() => setOpen(!open)}>查看诊断</button>
    {open && <DiagnosticPanel target={{kind:'p09',source,runId}} close={() => {
      setOpen(false)
      opener.current?.focus()
    }}/>}
  </>
}
