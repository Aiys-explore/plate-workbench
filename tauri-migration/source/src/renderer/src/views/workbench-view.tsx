import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { BrainSkill } from '../../../shared/brain'
import type { NoteSummary } from '../../../shared/ipc'
import type {
  BackendKind, HarnessEvent, HarnessRun, PermissionManifest, ProviderConfig, RunStatus, StagedDiff,
} from '../../../shared/harness'
import { useWorkbench } from '../store'
import { readPreferences } from '../s10-preferences'
import { IconAction } from '../icon-action'
import { IconAccept, IconAttachLog, IconAttachNote, IconChevronUp, IconDiff, IconDream, IconModel, IconNew, IconPermission,
  IconReject, IconSend, IconStop } from '../components/icons'
import type { ExternalAgentSession } from '../../../shared/harness'

const statusLabel: Record<RunStatus, string> = {
  running: '运行中', review_ready: '待审阅', completed: '已完成', failed: '失败', cancelled: '已取消',
}
const issue = (error: unknown) => error instanceof Error ? error.message : String(error)
const api = () => window.workbench.harness
const panelLabels = { notes: '引用笔记', logs: '引用记录', permissions: '任务权限', models: '模型与引擎' } as const
const starters = [
  ['整理本机排错记录并沉淀笔记', '整理我挂载的本机排错记录，提取问题、修复步骤和可复用经验，生成一条待审阅的笔记。'],
  ['基于大脑笔记审查权限策略', '结合我挂载的笔记，检查当前任务的权限范围，列出需要补充或收紧的地方。'],
  ['从闪念提炼可复用技能', '根据我提供的闪念找出可以复用的流程，整理为一份技能草稿。'],
] as const
export type WorkbenchHeader = { title?: string; activated: number }

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

export function WorkbenchView({ onHeaderChange }: { onHeaderChange: (header: WorkbenchHeader) => void }) {
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
  const extraNotes = useWorkbench(state => state.draftNoteIds)
  const setExtraNotes = useWorkbench(state => state.setDraftNoteIds)
  const [localLogs, setLocalLogs] = useState<ExternalAgentSession[]>([])
  const [panel, setPanel] = useState<keyof typeof panelLabels>()
  const composer = useRef<HTMLFormElement>(null)
  const promptInput = useRef<HTMLTextAreaElement>(null)
  const panelTrigger = useRef<HTMLButtonElement>(null)
  const panelElement = useRef<HTMLElement>(null)
  const enterPanel = useRef(false)
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
  const activated = events.reduce((count, event) => event.kind === 'context_activated'
    ? event.wave?.activatedNoteIds.length ?? 0 : count, 0)

  useEffect(() => {
    onHeaderChange({ title: selected?.title, activated })
  }, [selected?.title, activated, onHeaderChange])

  useEffect(() => {
    const count = diffs.filter(diff => diff.runId === runId && diff.status === 'pending').length
    setPendingDiffCount(count || (runs.some(run => run.status === 'review_ready') ? 1 : 0))
  }, [diffs, runId, runs, setPendingDiffCount])

  useEffect(() => {
    if (!panel) return
    const form = composer.current
    const surface = form?.parentElement
    const popover = panelElement.current
    const fit = () => {
      if (!form || !surface || !popover) return
      const space = form.getBoundingClientRect().top - surface.getBoundingClientRect().top - 18
      popover.style.setProperty('--s10-panel-space', Math.max(52, space) + 'px')
    }
    fit()
    const resize = new ResizeObserver(fit)
    if (form && surface) {
      resize.observe(form)
      resize.observe(surface)
    }
    if (enterPanel.current) {
      panelElement.current?.querySelector<HTMLElement>('button:not([disabled]), input, select, textarea')?.focus({ preventScroll: true })
    }
    enterPanel.current = false
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !composer.current?.contains(event.target)) setPanel(undefined)
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
        || document.querySelector('dialog[open]')) return
      event.preventDefault()
      setPanel(undefined)
      if (composer.current?.contains(document.activeElement)) panelTrigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      resize.disconnect()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [panel])

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
  }, [])

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
    if (busy || !prompt.trim()) return
    setPanel(undefined)
    const logIds = draft.map(log => log.id)
    const permissions: PermissionManifest = {
      readableNoteIds: [seed, ...chosenExtras.map(note => note.id)].filter(Boolean),
      allowAllNotesRead: allNotes, readableLogSessionIds: logIds,
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
  const chosenExtras = notes.filter(note => note.id !== seed && extraNotes.includes(note.id))
  const selectedBackend = (kind === 'api_key' ? providers : agents).find(item => item.id === backend)?.name
    ?? (kind === 'api_key' ? 'API Key' : '本机 CLI')
  const backendChoices = [
    { engine: 'api_key' as const, id: '', label: '使用工作台角色配置', detail: 'API Key · 使用默认模型' },
    ...providers.map(service => ({ engine: 'api_key' as const, id: service.id, label: service.name,
      detail: 'API Key · ' + service.defaultModel })),
    ...agents.map(agent => ({ engine: 'local_cli' as const, id: agent.id, label: agent.name,
      detail: '本机 CLI' + (agent.model ? ' · ' + agent.model : '') })),
    ...(agents.length ? [] : [{ engine: 'local_cli' as const, id: '', label: '本机 CLI', detail: '尚无已启用的本机 Agent' }]),
  ]
  const selectPanel = (name: keyof typeof panelLabels, trigger: HTMLButtonElement, keyboard: boolean) => {
    panelTrigger.current = trigger
    enterPanel.current = keyboard && panel !== name
    setPanel(current => current === name ? undefined : name)
    if (name === 'logs' && panel !== name) {
      void window.workbench.agentLogs.list(0).then(setLocalLogs).catch(cause => setError(issue(cause)))
    }
  }

  return <section className="s10-workbench" data-inspector={inspector} aria-label="工作台">
    <aside aria-label="任务历史">
      <div className="s10-section-header"><h2>工作台任务</h2>
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
        <div className="s10-run-transcript">
        <p role="status" className="s10-run-status">{statusLabel[selected.status]} · {selected.modelName || selected.backendId}
          {selected.backendKind === 'api_key' && <> · {selected.tokenIn} 输入 / {selected.tokenOut} 输出 · 估计 ${selected.costUsd.toFixed(4)}</>}</p>
        <Timeline events={events} notes={notes}/>
        </div>
        {selected.status === 'running' && <div className="s10-running-composer">
          <IconAction icon={IconStop} label="停止任务" disabled={busy} className="s10-send"
            onClick={() => void action(() => api().cancel(selected.id))}/>
        </div>}
      </> : <>
      <section className="s10-workbench-empty" aria-labelledby="s10-empty-title">
        <span className="s10-empty-icon"><IconDream size={18} strokeWidth={1.65} aria-hidden="true"/></span>
        <h2 id="s10-empty-title">从一个任务或一份资料开始</h2>
        <p>输入目标即可调度本机 CLI 或 API 模型。笔记与文件修改先进入暂存审阅。</p>
        <div className="s10-starters">
          {starters.map(([label, text]) => <button key={label} type="button" onClick={() => {
            setPrompt(text)
            setPanel(undefined)
            promptInput.current?.focus()
          }}>{label}</button>)}
        </div>
      </section>
      <form ref={composer} onSubmit={submit} className="s10-run-form s10-composer composer-island" aria-label="任务输入"
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229
            && (event.target === promptInput.current || event.ctrlKey) && !busy) {
            event.preventDefault()
            event.currentTarget.requestSubmit()
          }
        }}>
        <label className="s10-visually-hidden" htmlFor="s10-prompt">任务内容</label>
        {(chosenNote || chosenExtras.length > 0 || chosenSkill || draft.length > 0) && <ul className="s10-composer-chips" aria-label="任务引用">
          {chosenNote && <li>{chosenNote.title}<IconAction icon={IconReject} size={14} label="移除种子笔记" onClick={() => setSeed('')}/></li>}
          {chosenExtras.map(note => <li key={note.id}>{note.title}<IconAction icon={IconReject} size={14}
            label={'移除引用 ' + note.title} onClick={() => setExtraNotes(extraNotes.filter(id => id !== note.id))}/></li>)}
          {chosenSkill && <li>{chosenSkill.title}<IconAction icon={IconReject} size={14} label="移除技能" onClick={() => trySkill('')}/></li>}
          {draft.map(log => <li key={log.id}>{log.title}
            <IconAction icon={IconReject} size={14} label={'移除引用 ' + log.title} onClick={() => detach(log.id)}/>
          </li>)}
        </ul>}
        <textarea ref={promptInput} className="composer-textarea" id="s10-prompt" value={prompt} rows={2} maxLength={8000} required
          placeholder="输入任务目标，或点击下方图标挂载笔记、本机 Agent 记录与权限边界…"
          onChange={event => setPrompt(event.target.value)}/>
        {panel && <section ref={panelElement} className="s10-composer-panel floating-popover" id="s10-composer-panel"
          aria-label={panelLabels[panel]} data-panel={panel}>
          <h3>{panelLabels[panel]}</h3>
          {panel === 'notes' && <>
            <label>种子笔记<select aria-label="种子笔记" value={seed} onChange={e => {
              const id = e.target.value
              setSeed(id)
              setExtraNotes(extraNotes.filter(note => note !== id))
            }}>
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
              attach(item); setPanel(undefined); promptInput.current?.focus()
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
            <div className="s10-backend-list" role="group" aria-label="执行引擎与模型">
              {backendChoices.map(choice => {
                const current = choice.engine === kind && choice.id === backend
                return <button type="button" aria-pressed={current} key={choice.engine + ':' + choice.id} onClick={() => {
                  if (choice.engine !== kind) setModel('')
                  setKind(choice.engine)
                  setBackend(choice.id)
                }}>
                  <span>{choice.label}<small>{choice.detail}</small></span>
                  {current && <IconAccept size={14} strokeWidth={1.65} aria-hidden="true"/>}
                </button>
              })}
            </div>
            <details className="s10-model-options">
              <summary>任务设置</summary>
              <label>任务标题<input value={title} maxLength={130} onChange={e => setTitle(e.target.value)}/></label>
              {kind === 'api_key' && <label>模型覆盖<input value={model} onChange={e => setModel(e.target.value)}/></label>}
              <label>任务技能<select value={skill} onChange={e => trySkill(e.target.value)}>
                <option value="">不使用技能</option>
                {skills.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select></label>
            </details>
          </>}
        </section>}
        <div className="s10-composer-footer">
          <div className="s10-actions">
            <IconAction icon={IconAttachNote} label={panelLabels.notes} aria-expanded={panel === 'notes'}
              aria-controls={panel === 'notes' ? 's10-composer-panel' : undefined}
              active={panel === 'notes' || !!seed || chosenExtras.length > 0} onClick={event => selectPanel('notes', event.currentTarget, event.detail === 0)}/>
            <IconAction icon={IconAttachLog} label={panelLabels.logs} aria-expanded={panel === 'logs'}
              aria-controls={panel === 'logs' ? 's10-composer-panel' : undefined}
              active={panel === 'logs'} badge={draft.length} onClick={event => selectPanel('logs', event.currentTarget, event.detail === 0)}/>
            <IconAction icon={IconPermission} label={panelLabels.permissions} aria-expanded={panel === 'permissions'}
              aria-controls={panel === 'permissions' ? 's10-composer-panel' : undefined}
              active={panel === 'permissions' || allowNetwork || !!dirs}
              onClick={event => selectPanel('permissions', event.currentTarget, event.detail === 0)}/>
            <IconAction icon={IconModel} label={panelLabels.models} aria-expanded={panel === 'models'} active={panel === 'models'}
              aria-controls={panel === 'models' ? 's10-composer-panel' : undefined}
              size={14} className="s10-model-trigger" onClick={event => selectPanel('models', event.currentTarget, event.detail === 0)}>
              <span>{selectedBackend}</span><IconChevronUp size={14} strokeWidth={1.65} aria-hidden="true"/>
            </IconAction>
          </div>
          <IconAction type="submit" icon={IconSend} label="开始任务" shortcut="Enter" size={16}
            className="s10-send" disabled={busy || !prompt.trim()}/>
        </div>
      </form></>}
    </div>
    {inspector && <aside className="s10-diff-panel" aria-label="暂存审阅">
      <div className="s10-section-header"><h2>暂存审阅</h2>
        <IconAction icon={IconReject} label="收起审阅" onClick={toggleInspector}/>
      </div>
      {diffs.length === 0 && <p className="s10-quiet-empty">当前没有暂存变更。</p>}
      {diffs.map(diff => <article key={diff.id} className="s10-diff-card">
        <header className="s10-diff-card-header">
          <strong data-tip={diff.targetRef}>{diff.targetKind === 'brain_note'
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
