import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { BrainSkill } from '../../../shared/brain'
import type { NoteSummary } from '../../../shared/ipc'
import type {
  BackendKind, HarnessEvent, HarnessRun, PermissionManifest, ProviderConfig, RunStatus, StagedDiff,
} from '../../../shared/harness'
import { useWorkbench } from '../store'
import { readPreferences } from '../s10-preferences'
import { IconAction } from '../icon-action'
import { IconAccept, IconAttachLog, IconAttachNote, IconDiff, IconModel, IconNew, IconPermission,
  IconReject, IconSend, IconStop } from '../components/icons'
import type { ExternalAgentSession } from '../../../shared/harness'

const statusLabel: Record<RunStatus, string> = {
  running: '运行中', review_ready: '待审阅', completed: '已完成', failed: '失败', cancelled: '已取消',
}
const issue = (error: unknown) => error instanceof Error ? error.message : String(error)
const api = () => window.workbench.harness

function Timeline({ events, notes }: { events: HarnessEvent[]; notes: NoteSummary[] }) {
  const output = events.flatMap(event => event.kind === 'token_delta' ? [event.delta] : []).join('')
  return <div className="s10-timeline">
    {events.map((event, i) => {
      if (event.kind === 'run_started') return <p key={i} className="s10-user-message">{event.prompt}</p>
      if (event.kind === 'context_activated' && (event.wave || event.attachedLogCount)) {
        return <div key={i} className="s10-context" role="status">
          <span>已激活 {event.wave?.activatedNoteIds.length ?? 0} 篇关联笔记</span>
          {event.attachedLogCount > 0 && <span> · 引用 {event.attachedLogCount} 个会话</span>}
          {event.wave && <ul aria-label="激活的长期记忆">
            {[event.wave.seedNoteId, ...event.wave.activatedNoteIds].map(id => <li key={id}>
              {notes.find(note => note.id === id)?.title ?? id}
            </li>)}
          </ul>}
        </div>
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
  const runId = useWorkbench(state => state.activeRunId)
  const setRunId = useWorkbench(state => state.setActiveRunId)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<BackendKind>('api_key')
  const [backend, setBackend] = useState('')
  const [model, setModel] = useState('')
  const [seed, setSeed] = useState('')
  const skill = useWorkbench(state => state.draftSkillId)
  const trySkill = useWorkbench(state => state.trySkill)
  const inspector = useWorkbench(state => state.inspectorOpen)
  const toggleInspector = useWorkbench(state => state.toggleInspector)
  const attach = useWorkbench(state => state.attachLogToWorkbench)
  const [extraNotes, setExtraNotes] = useState<string[]>([])
  const [localLogs, setLocalLogs] = useState<ExternalAgentSession[]>([])
  const [panel, setPanel] = useState<'notes' | 'logs' | 'permissions' | 'models'>()
  const [dirs, setDirs] = useState('')
  const [allowNetwork, setAllowNetwork] = useState(false)
  const [allowShell, setAllowShell] = useState(false)
  const [allNotes, setAllNotes] = useState(false)
  const [allowNoteDraft, setAllowNoteDraft] = useState(true)
  const [steps, setSteps] = useState(() => readPreferences().maxSteps)
  const [budget, setBudget] = useState(() => readPreferences().maxBudgetUsd)
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
      readableNoteIds: [...new Set([seed, ...extraNotes].filter(Boolean))], allowAllNotesRead: allNotes, readableLogSessionIds: logIds,
      writableDirs: dirs.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      allowNetwork, allowShell: kind === 'local_cli' && allowShell, allowBrainNotePropose: allowNoteDraft,
      maxSteps: steps, maxBudgetUsd: budget,
    }
    if (kind === 'local_cli' && !backend) { setError('请选择本机 Agent'); return }
    const taskTitle = title.trim() || prompt.trim().split(/\r?\n/)[0].slice(0,100)
    void action(async () => {
      const id = await api().start({ title: taskTitle, prompt, backendKind: kind, backendId: backend,
        modelOverride: model.trim() || undefined, seedNoteId: seed || undefined,
        skillId: skill || undefined, attachedLogSessionIds: logIds, permissions })
      setRunId(id)
      await refreshRuns()
    })
  }

  const chosenNote = notes.find(note => note.id === seed)
  const chosenSkill = skills.find(item => item.id === skill)
  const selectPanel = (name: 'notes' | 'logs' | 'permissions' | 'models') => {
    setPanel(current => current === name ? undefined : name)
    if (name === 'logs') void window.workbench.agentLogs.list(0).then(setLocalLogs).catch(cause => setError(issue(cause)))
  }

  return <section className="s10-workbench" data-inspector={inspector} aria-label="工作台">
    <aside aria-label="任务历史">
      <div className="s10-section-header"><h2>任务</h2>
        <IconAction icon={IconNew} label="新建任务" onClick={() => { setRunId(''); setError('') }}/>
      </div>
      <ul className="s10-provider-list">
        {runs.map(run => <li className="s10-row" key={run.id}>
          <button className="s10-row-label" type="button" onClick={() => setRunId(run.id)} aria-pressed={runId === run.id}>
            {run.backendKind === 'local_cli' ? <IconAttachLog size={14} strokeWidth={1.65} aria-hidden="true"/>
              : <IconModel size={14} strokeWidth={1.65} aria-hidden="true"/>}
            <span className="s10-row-title"><strong>{run.title}</strong>
              <time dateTime={new Date(run.updatedAt).toISOString()}>{new Date(run.updatedAt).toLocaleString('zh-CN')}</time>
              <small>{statusLabel[run.status]}</small>
            </span>
          </button>
          <div className="s10-row-actions">
            <IconAction icon={IconDiff} label={'查看暂存 ' + run.title} onClick={() => {
              setRunId(run.id)
              if (!inspector) toggleInspector()
            }}/>
          </div>
        </li>)}
      </ul>
    </aside>
    <div className="s10-run-main">
      {error && <p role="alert" className="s10-error">{error}</p>}
      {selected ? <>
        <h2>{selected.title}</h2>
        <p role="status">{statusLabel[selected.status]} · {selected.modelName || selected.backendId}
          {selected.backendKind === 'api_key' && <> · {selected.tokenIn} 输入 / {selected.tokenOut} 输出 · 估计 ${selected.costUsd.toFixed(4)}</>}</p>
        <Timeline events={events} notes={notes}/>
        {selected.status === 'running' && <div className="s10-running-composer">
          <IconAction icon={IconStop} label="停止任务" disabled={busy} className="s10-send"
            onClick={() => void action(() => api().cancel(selected.id))}/>
        </div>}
      </> : <form onSubmit={submit} className="s10-run-form s10-composer" aria-label="任务输入"
        onKeyDown={event => {
          if (event.key === 'Escape' && panel) { event.stopPropagation(); setPanel(undefined) }
          if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing && !busy) {
            event.preventDefault()
            event.currentTarget.requestSubmit()
          }
        }}>
        <label className="s10-visually-hidden" htmlFor="s10-prompt">任务内容</label>
        <textarea id="s10-prompt" value={prompt} rows={4} maxLength={8000} required placeholder="要完成什么任务？"
          onChange={event => setPrompt(event.target.value)}/>
        {panel && <div className="s10-composer-panel" id="s10-composer-panel">
          {panel === 'notes' && <>
            <label>种子笔记<select aria-label="种子笔记" value={seed} onChange={e => setSeed(e.target.value)}>
              <option value="">不引用笔记</option>
              {notes.map(note => <option key={note.id} value={note.id}>{note.title}</option>)}
            </select></label>
            <label>其他授权笔记<select aria-label="其他授权笔记" multiple value={extraNotes} onChange={event =>
              setExtraNotes(Array.from(event.currentTarget.selectedOptions, item => item.value))}>
              {notes.filter(note => note.id !== seed).map(note => <option key={note.id} value={note.id}>{note.title}</option>)}
            </select></label>
          </>}
          {panel === 'logs' && <div className="s10-log-picker">
            {localLogs.length === 0 && <p>尚无导入的本机记录。</p>}
            {localLogs.map(item => <button type="button" key={item.id} onClick={() => {
              attach(item); setPanel(undefined)
            }}>{item.title}</button>)}
            <button type="button" onClick={() => navigate('library')}>打开资料与记录</button>
          </div>}
          {panel === 'permissions' && <>
            <label>授权文件目录（每行一个绝对路径）<textarea value={dirs} rows={2} onChange={e => setDirs(e.target.value)}/></label>
            <label className="s10-check"><input type="checkbox" checked={allNotes} onChange={e => setAllNotes(e.target.checked)}/>允许读取全部笔记</label>
            <label className="s10-check"><input type="checkbox" checked={allowNoteDraft} onChange={e => setAllowNoteDraft(e.target.checked)}/>允许提议笔记修改</label>
            <label className="s10-check"><input type="checkbox" checked={allowNetwork} onChange={e => setAllowNetwork(e.target.checked)}/>
              {kind === 'api_key' ? '允许连接所选模型服务并提交任务上下文' : '允许隔离 CLI 连接互联网'}
            </label>
            {kind === 'local_cli' && <label className="s10-check"><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)}/>允许隔离 CLI 启动子进程</label>}
            <div className="s10-price-inputs">
              <label>步数上限<input type="number" min="1" max="40" step="1" value={steps} onChange={e => setSteps(Number(e.target.value))}/></label>
              {kind === 'api_key' && <label>预算上限（美元）<input type="number" min="0" max="1000" step="any" value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>}
            </div>
          </>}
          {panel === 'models' && <>
            <label>任务标题<input value={title} maxLength={130} onChange={e => setTitle(e.target.value)}/></label>
            <div className="s10-price-inputs">
              <label>执行引擎<select value={kind} onChange={e => { setKind(e.target.value as BackendKind); setBackend(''); setModel('') }}>
                <option value="api_key">API Key</option><option value="local_cli">本机 CLI</option>
              </select></label>
              <label>{kind === 'api_key' ? '模型服务商' : '本机 Agent'}<select value={backend} onChange={e => setBackend(e.target.value)}>
                <option value="">{kind === 'api_key' ? '使用工作台角色配置' : '请选择已启用 Agent'}</option>
                {kind === 'api_key' ? providers.map(item => <option value={item.id} key={item.id}>{item.name}</option>)
                  : agents.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select></label>
            </div>
            {kind === 'api_key' && <label>模型覆盖<input value={model} onChange={e => setModel(e.target.value)}/></label>}
            <label>任务技能<select value={skill} onChange={e => trySkill(e.target.value)}>
              <option value="">不使用技能</option>
              {skills.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select></label>
          </>}
        </div>}
        {(chosenNote || chosenSkill || draft.length > 0) && <ul className="s10-composer-chips" aria-label="任务引用">
          {chosenNote && <li>{chosenNote.title}<IconAction icon={IconReject} size={14} label="移除种子笔记" onClick={() => setSeed('')}/></li>}
          {chosenSkill && <li>{chosenSkill.title}<IconAction icon={IconReject} size={14} label="移除技能" onClick={() => trySkill('')}/></li>}
          {draft.map(log => <li key={log.id}>{log.title}
            <IconAction icon={IconReject} size={14} label={'移除引用 ' + log.title} onClick={() => detach(log.id)}/>
          </li>)}
        </ul>}
        <div className="s10-composer-footer">
          <div className="s10-actions">
            <IconAction icon={IconAttachNote} label="引用笔记" aria-expanded={panel === 'notes'} active={!!seed} onClick={() => selectPanel('notes')}/>
            <IconAction icon={IconAttachLog} label="引用记录" aria-expanded={panel === 'logs'} badge={draft.length} onClick={() => selectPanel('logs')}/>
            <IconAction icon={IconPermission} label="任务权限" aria-expanded={panel === 'permissions'} active={allowNetwork || !!dirs} onClick={() => selectPanel('permissions')}/>
            <IconAction icon={IconModel} label="模型与引擎" aria-expanded={panel === 'models'} onClick={() => selectPanel('models')}/>
          </div>
          <IconAction type="submit" icon={IconSend} label="开始任务" shortcut="Ctrl+Enter" size={18} className="s10-send" disabled={busy}/>
        </div>
      </form>}
    </div>
    {inspector && <aside className="s10-diff-panel" aria-label="暂存审阅">
      <h2>暂存审阅</h2>
      {diffs.length === 0 && <p>当前没有暂存变更。</p>}
      {diffs.map(diff => <article key={diff.id} className="s10-diff-card">
        <header className="s10-diff-card-header">
          <strong title={diff.targetRef}>{diff.targetKind === 'brain_note'
            ? notes.find(note => note.id === diff.targetRef)?.title ?? diff.targetRef
            : diff.targetRef.startsWith("\\\\?\\") ? diff.targetRef.slice(4) : diff.targetRef} · {{ pending: '待审阅', accepted: '已应用', rejected: '已驳回' }[diff.status]}</strong>
        {diff.status === 'pending' && selected?.status !== 'running' && <div className="s10-actions">
          <IconAction icon={IconAccept} label="审阅并应用" disabled={busy} onClick={() => void action(async () => {
            await api().resolve(diff.id, true)
            await Promise.all([refreshRuns(), refreshDetail(runId)])
          })}/>
          <IconAction icon={IconReject} label="驳回" danger disabled={busy} onClick={() => void action(async () => {
            await api().resolve(diff.id, false)
            await Promise.all([refreshRuns(), refreshDetail(runId)])
          })}/>
        </div>}
        </header>
        {diff.rationale && <p>{diff.rationale}</p>}
        <pre aria-label="变更对比">{diff.unifiedDiff.split('\n').map((line, i) => <span key={i}
          className={line.startsWith('+') ? 's10-diff-add' : line.startsWith('-') ? 's10-diff-remove' : undefined}>{line}{'\n'}</span>)}</pre>
      </article>)}
    </aside>}
  </section>
}
