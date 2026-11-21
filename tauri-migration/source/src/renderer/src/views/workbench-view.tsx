import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { BrainSkill } from '../../../shared/brain'
import type { NoteSummary } from '../../../shared/ipc'
import type {
  BackendKind, HarnessEvent, HarnessRun, PermissionManifest, ProviderConfig, RunStatus, StagedDiff,
} from '../../../shared/harness'
import { useWorkbench } from '../store'

const statusLabel: Record<RunStatus, string> = {
  running: '运行中', review_ready: '待审阅', completed: '已完成', failed: '失败', cancelled: '已取消',
}
const issue = (error: unknown) => error instanceof Error ? error.message : String(error)
const api = () => window.workbench.harness

function Timeline({ events }: { events: HarnessEvent[] }) {
  const output = events.flatMap(event => event.kind === 'token_delta' ? [event.delta] : []).join('')
  return <div className="s10-timeline">
    {events.map((event, i) => {
      if (event.kind === 'run_started') return <p key={i} className="s10-user-message">{event.prompt}</p>
      if (event.kind === 'context_activated' && (event.wave || event.attachedLogCount)) {
        return <p key={i} className="s10-context">已激活 {event.wave?.activatedNoteIds.length ?? 0} 篇关联笔记
          {event.attachedLogCount > 0 && `，引用 ${event.attachedLogCount} 个会话`}</p>
      }
      if (event.kind === 'run_status_changed' && event.error) return <p key={i} role="alert" className="s10-error">{event.error}</p>
      return null
    })}
    {output && <pre aria-label="Agent 输出">{output}</pre>}
    {events.some(event => event.kind === 'tool_call') && <details>
      <summary>工具调用</summary>
      <ul>{events.flatMap((event, i) => event.kind === 'tool_call'
        ? [<li key={i}>{event.toolName} · {event.summary}</li>] : [])}</ul>
    </details>}
  </div>
}

export function WorkbenchView() {
  const [runs, setRuns] = useState<HarnessRun[]>([])
  const [events, setEvents] = useState<HarnessEvent[]>([])
  const [diffs, setDiffs] = useState<StagedDiff[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [agents, setAgents] = useState<Awaited<ReturnType<typeof window.workbench.agentPlugins.active>>>([])
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [skills, setSkills] = useState<BrainSkill[]>([])
  const [runId, setRunId] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<BackendKind>('api_key')
  const [backend, setBackend] = useState('')
  const [model, setModel] = useState('')
  const [seed, setSeed] = useState('')
  const [skill, setSkill] = useState('')
  const [dirs, setDirs] = useState('')
  const [allowNetwork, setAllowNetwork] = useState(false)
  const [allowShell, setAllowShell] = useState(false)
  const [allNotes, setAllNotes] = useState(false)
  const [allowNoteDraft, setAllowNoteDraft] = useState(true)
  const [steps, setSteps] = useState(12)
  const [budget, setBudget] = useState(0.5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const draft = useWorkbench(state => state.draftAttachedLogs)
  const detach = useWorkbench(state => state.detachLogFromWorkbench)
  const navigate = useWorkbench(state => state.setActiveView)
  const setPendingDiffCount = useWorkbench(state => state.setPendingDiffCount)
  const refreshId = useRef(0)
  const detailsId = useRef(0)
  const selectedRef = useRef(runId)
  selectedRef.current = runId
  const selected = runs.find(run => run.id === runId)

  const refreshRuns = useCallback(async () => {
    const version = ++refreshId.current
    const items = await api().list()
    if (version === refreshId.current) setRuns(items)
  }, [])

  const refreshDetail = useCallback(async (id: string) => {
    const version = ++detailsId.current
    if (!id) { setEvents([]); setDiffs([]); return }
    const [items, proposals] = await Promise.all([api().events(id), api().diffs(id)])
    if (selectedRef.current !== id || version !== detailsId.current) return
    setEvents(items)
    setDiffs(proposals)
    setPendingDiffCount(proposals.filter(diff => diff.status === 'pending').length)
  }, [setPendingDiffCount])

  useEffect(() => {
    let live = true
    void refreshRuns().catch(cause => { if (live) setError(issue(cause)) })
    void Promise.all([
      window.workbench.providers.list(), window.workbench.agentPlugins.active(),
      window.workbench.notes.list(), window.workbench.brain.skills(),
    ]).then(([modelServices, plugins, localNotes, localSkills]) => {
      if (!live) return
      setProviders(modelServices.filter(service => service.enabled))
      setAgents(plugins.filter(item => /\.exe$/i.test(item.executable)))
      setNotes(localNotes)
      setSkills(localSkills)
    }).catch(cause => { if (live) setError(issue(cause)) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api().onEvent(event => {
      if (event.kind === 'run_status_changed') void refreshRuns().catch(cause => setError(issue(cause)))
      if (event.runId !== selectedRef.current || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void refreshDetail(selectedRef.current).catch(cause => setError(issue(cause)))
      }, 110)
    })
    return () => { live = false; off(); clearTimeout(timer); refreshId.current++; detailsId.current++ }
  }, [refreshDetail, refreshRuns])

  useEffect(() => {
    setEvents([])
    setDiffs([])
    void refreshDetail(runId).catch(cause => setError(issue(cause)))
  }, [runId, refreshDetail])

  async function action(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await work() }
    catch (cause) { setError(issue(cause)) }
    finally { setBusy(false) }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const logIds = draft.map(log => log.id)
    const permissions: PermissionManifest = {
      readableNoteIds: seed ? [seed] : [], allowAllNotesRead: allNotes, readableLogSessionIds: logIds,
      writableDirs: dirs.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      allowNetwork, allowShell: kind === 'local_cli' && allowShell, allowBrainNotePropose: allowNoteDraft,
      maxSteps: steps, maxBudgetUsd: budget,
    }
    void action(async () => {
      const id = await api().start({ title, prompt, backendKind: kind, backendId: backend,
        modelOverride: model.trim() || undefined, seedNoteId: seed || undefined,
        skillId: skill || undefined, attachedLogSessionIds: logIds, permissions })
      setRunId(id)
      await refreshRuns()
    })
  }

  return <section className="s10-workbench" aria-label="工作台">
    <aside aria-label="任务历史">
      <h1>工作台</h1>
      <button type="button" onClick={() => { setRunId(''); setError('') }}>新建任务</button>
      <ul className="s10-provider-list">
        {runs.map(run => <li key={run.id}><button type="button" onClick={() => setRunId(run.id)}
          aria-pressed={runId === run.id}><strong>{run.title}</strong>
          <span>{statusLabel[run.status]}</span>
        </button></li>)}
      </ul>
    </aside>
    <div className="s10-run-main">
      {error && <p role="alert" className="s10-error">{error}</p>}
      {selected ? <>
        <h2>{selected.title}</h2>
        <p role="status">{statusLabel[selected.status]} · {selected.modelName || selected.backendId}
          {selected.backendKind === 'api_key' && ` · ${selected.tokenIn} 输入 / ${selected.tokenOut} 输出 · $${selected.costUsd.toFixed(4)}`}</p>
        {selected.status === 'running' && <button type="button" disabled={busy}
          onClick={() => void action(() => api().cancel(selected.id))}>停止任务</button>}
        <Timeline events={events}/>
      </> : <form onSubmit={submit} className="s10-run-form">
        <h2>新建任务</h2>
        <label>任务标题<input value={title} maxLength={130} required onChange={e => setTitle(e.target.value)}/></label>
        <label>任务内容<textarea value={prompt} rows={5} maxLength={8000} required onChange={e => setPrompt(e.target.value)}/></label>
        <div className="s10-price-inputs">
          <label>执行引擎<select value={kind} onChange={e => { setKind(e.target.value as BackendKind); setBackend(''); setModel('') }}>
            <option value="api_key">API Key</option>
            <option value="local_cli">本机 CLI</option>
          </select></label>
          <label>{kind === 'api_key' ? '模型服务商' : '本机 Agent'}<select value={backend}
            required={kind === 'local_cli'} onChange={e => setBackend(e.target.value)}>
            <option value="">{kind === 'api_key' ? '使用工作台角色配置' : '请选择已启用 Agent'}</option>
            {kind === 'api_key'
              ? providers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)
              : agents.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select></label>
        </div>
        {kind === 'api_key' && <label>模型覆盖<input value={model} onChange={e => setModel(e.target.value)}/></label>}
        <label>种子笔记<select value={seed} onChange={e => setSeed(e.target.value)}>
          <option value="">不引用笔记</option>
          {notes.map(note => <option key={note.id} value={note.id}>{note.title}</option>)}
        </select></label>
        <label>任务技能<select value={skill} onChange={e => setSkill(e.target.value)}>
          <option value="">不使用技能</option>
          {skills.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        {draft.length > 0 && <ul aria-label="已引用的本机会话">
          {draft.map(log => <li key={log.id}><span>{log.title}</span>{' '}
            <button type="button" onClick={() => detach(log.id)}>移除引用</button></li>)}
        </ul>}
        <details open>
          <summary>任务权限</summary>
          <label>授权文件目录（每行一个绝对路径）<textarea value={dirs} rows={2} onChange={e => setDirs(e.target.value)}/></label>
          <label className="s10-check"><input type="checkbox" checked={allNotes} onChange={e => setAllNotes(e.target.checked)}/>允许读取全部笔记</label>
          <label className="s10-check"><input type="checkbox" checked={allowNoteDraft} onChange={e => setAllowNoteDraft(e.target.checked)}/>允许提议笔记修改</label>
          <label className="s10-check"><input type="checkbox" checked={allowNetwork} onChange={e => setAllowNetwork(e.target.checked)}/>
            {kind === 'api_key' ? '允许连接所选模型服务并提交任务上下文' : '允许隔离 CLI 连接互联网'}
          </label>
          {kind === 'local_cli' && <label className="s10-check"><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)}/>允许隔离 CLI 启动子进程</label>}
          <div className="s10-price-inputs">
            <label>步数上限<input type="number" min="1" max="40" step="1" required value={steps} onChange={e => setSteps(Number(e.target.value))}/></label>
            {kind === 'api_key' && <label>预算上限（美元）<input type="number" min="0" max="1000" step="any" required value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>}
          </div>
        </details>
        <div className="s10-actions">
          <button type="submit" disabled={busy}>开始任务</button>
          <button type="button" onClick={() => navigate('settings')}>模型与权限</button>
        </div>
      </form>}
    </div>
    <aside className="s10-diff-panel" aria-label="暂存审阅">
      <h2>暂存审阅</h2>
      {diffs.length === 0 && <p>当前没有暂存变更。</p>}
      {diffs.map(diff => <details key={diff.id}>
        <summary>{diff.targetRef} · {{ pending: '待审阅', accepted: '已应用', rejected: '已驳回' }[diff.status]}</summary>
        {diff.rationale && <p>{diff.rationale}</p>}
        <pre aria-label="变更对比">{diff.unifiedDiff}</pre>
        {diff.status === 'pending' && selected?.status !== 'running' && <div className="s10-actions">
          {diff.targetKind === 'workspace_file' && <button type="button" disabled={busy} onClick={() => void action(async () => {
            await api().resolve(diff.id, true)
            await Promise.all([refreshRuns(), refreshDetail(runId)])
          })}>审阅并应用</button>}
          <button type="button" disabled={busy} onClick={() => void action(async () => {
            await api().resolve(diff.id, false)
            await Promise.all([refreshRuns(), refreshDetail(runId)])
          })}>驳回</button>
        </div>}
      </details>)}
    </aside>
  </section>
}
