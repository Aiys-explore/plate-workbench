import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { BrainActivationWave, BrainHistory, BrainNoteMetadata, BrainSkill, EpisodicEvent } from '../../shared/brain'
import type { RelationshipNote } from '../../shared/ipc'
import { EditorDialog } from './note-editor'
import { IconAction } from './icon-action'
import { IconDream, IconHeat, IconNew, IconZones } from './components/icons'
import './styles/brain-dynamics.css'

const api = () => window.workbench.brain
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const date = (time: number) => new Date(time).toLocaleString('zh-CN')

export function useBrainWorkbench(project: string | undefined, visible: boolean) {
  const [notes, setNotes] = useState<Record<string, BrainNoteMetadata>>({})
  const [events, setEvents] = useState<EpisodicEvent[]>([])
  const [skills, setSkills] = useState<BrainSkill[]>([])
  const [status, setStatus] = useState<Awaited<ReturnType<ReturnType<typeof api>['status']>>>()
  const [wave, setWave] = useState<BrainActivationWave>()
  const [error, setError] = useState('')
  const refreshSequence = useRef(0)
  useEffect(() => {
    let timer: number | undefined
    const unsubscribe = api().onActivation(activation => {
      window.clearTimeout(timer)
      setWave(activation)
      timer = window.setTimeout(() => setWave(undefined), 4_000)
    })
    return () => { unsubscribe(); window.clearTimeout(timer) }
  }, [])
  const refresh = useCallback(async () => {
    const request = ++refreshSequence.current
    try {
      const [metadata, captures, library, preferences] = await Promise.all([
        api().metadata(), api().events(project), api().skills(), api().status(),
      ])
      if (request !== refreshSequence.current) return
      setNotes(metadata)
      setEvents(captures)
      setSkills(library)
      setStatus(preferences)
      setError('')
    } catch (issue) { if (request === refreshSequence.current) setError(message(issue)) }
  }, [project])
  useEffect(() => {
    if (!visible) return
    const off = api().onChanged(refresh)
    void refresh()
    return () => { refreshSequence.current++; off() }
  }, [refresh, visible])
  return { notes, events, skills, status, wave, error, refresh }
}

export function BrainHudBar({ wave, notes, events, zones, vitality, toggleZones, toggleVitality, dream }: {
  wave?: BrainActivationWave; notes: number; events: number; zones: boolean; vitality: boolean
  toggleZones: () => void; toggleVitality: () => void; dream: () => void
}) {
  return <div className="brain-hud">
    <output role="status" className="brain-run-status" data-active={!!wave}>
      {wave ? <>调度中 · 已唤醒 {wave.activatedNoteIds.length} 条记忆 · {wave.activatedSkillIds.length} 个技能</> :
        <>全脑就绪 · {events} 条闪念 · {notes} 个长期节点</>}
    </output>
    <div className="brain-hud-actions">
      <IconAction icon={IconZones} label="分区视图" active={zones} aria-pressed={zones} onClick={toggleZones}/>
      <IconAction icon={IconHeat} label="活力热力" active={vitality} aria-pressed={vitality} onClick={toggleVitality}/>
      <IconAction icon={IconDream} label="做梦整理" onClick={dream}/>
    </div>
  </div>
}

export function CorticalZonesLayer() {
  return <div className="brain-zones" aria-hidden="true">
    <div className="brain-zone-hippocampus"/>
    <span className="brain-zone-neocortex">新皮层 · 长期语义图谱</span>
  </div>
}

export function QuickCaptureBar({ project, projectLabel, close, captured }: {
  project: string; projectLabel: string; close: () => void; captured: (id: string, text: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    try { captured(await api().capture(project, text), text); close() }
    catch (issue) { setError(message(issue)); setBusy(false) }
  }
  return <EditorDialog title="捕获闪念" close={close} kind="brain">
    <form className="brain-form" onSubmit={save}>
      <label>保存至 {projectLabel}
        <textarea aria-label="闪念内容" rows={4} value={text} placeholder="写下刚想到的事…"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              void save()
            }
          }}/>
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="button-primary" disabled={busy || !text.trim()}>保存闪念</button>
    </form>
  </EditorDialog>
}

export function EpisodicLane({ events, fresh, openCapture, consolidate }: {
  events: EpisodicEvent[]; fresh?: string; openCapture: () => void; consolidate: (events: EpisodicEvent[]) => void
}) {
  return <aside className="brain-episodic" aria-label="海马体 · 短期闪念">
    <div className="brain-lane-header">
      <span><small>海马体</small><strong>短期闪念</strong></span>
      <IconAction icon={IconNew} label="捕获闪念" shortcut="Ctrl+Shift+Space" onClick={openCapture}/>
    </div>
    <div className="brain-event-list">
      {events.length === 0 && <p className="brain-muted">按 Ctrl+Shift+Space 捕获闪念。</p>}
      {events.map(event => <article key={event.id} className="brain-episodic-card" data-event-id={event.id} data-new={fresh === event.id}>
        <p>{event.rawText}</p>
        <footer><time dateTime={new Date(event.createdAt).toISOString()}>{date(event.createdAt)}</time>
          <button type="button" onClick={() => consolidate([event])}>固化</button></footer>
      </article>)}
    </div>
  </aside>
}

export function ConsolidationDialog({ events, nodes, close, consolidate }: {
  events: EpisodicEvent[]; nodes: RelationshipNote[]; close: () => void
  consolidate: (ids: string[], title: string, target?: string, synthesis?: string) => Promise<void>
}) {
  const [selected, setSelected] = useState<string[]>(events.length === 1 ? [events[0].id] : [])
  const [title, setTitle] = useState(events.length === 1 ? events[0].rawText.split(/\r?\n/)[0].slice(0, 60) : '')
  const [target, setTarget] = useState('')
  const [synthesis, setSynthesis] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = events.find(event => event.id === selected[0])?.projectId
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try { await consolidate(selected, title, target || undefined, synthesis || undefined); close() }
    catch (issue) { setError(message(issue)); setBusy(false) }
  }
  return <EditorDialog title="固化闪念" close={close} kind="brain">
    <form className="brain-form" onSubmit={save}>
      <div className="brain-choice-list">
        {events.map(event => <label key={event.id}>
          <input type="checkbox" checked={selected.includes(event.id)}
            disabled={!!project && project !== event.projectId || !selected.includes(event.id) && selected.length >= 20}
            onChange={change => {
              setSelected(old => change.target.checked ? [...old, event.id] : old.filter(id => id !== event.id))
              setSynthesis('')
              if (!change.target.checked && selected.length === 1) setTarget('')
            }}/>{event.rawText}
        </label>)}
      </div>
      <label>保存位置
        <select value={target} onChange={event => setTarget(event.target.value)}>
          <option value="">新建笔记</option>
          {nodes.filter(note => note.projectId === project).map(note => <option key={note.id} value={note.id}>{note.title}</option>)}
        </select>
      </label>
      {!target && <label>笔记标题<input value={title} onChange={event => setTitle(event.target.value)} required/></label>}
      {error && <p role="alert">{error}</p>}
      <div className="s10-actions">
        <button type="button" disabled={busy || !selected.length} onClick={() => {
          setBusy(true); setError('')
          void api().dreamSuggestion(selected).then(draft => {
            setTitle(draft.title)
            setSynthesis(draft.summary)
          }).catch(cause => setError(message(cause))).finally(() => setBusy(false))
        }}>用模型整理所选闪念</button>
        <button type="submit" className="button-primary" disabled={busy || !selected.length || !target && !title.trim()}>确认固化</button>
      </div>
      {synthesis && <label>审阅排版和正文<textarea rows={5} value={synthesis} onChange={event => setSynthesis(event.target.value)}/></label>}
    </form>
  </EditorDialog>
}

export function EvolutionBadge({ version, x, y, open }: {
  version: number; x: number; y: number; open: () => void
}) {
  const previous = useRef(version)
  const [pulse, setPulse] = useState<number>()
  useLayoutEffect(() => {
    const changed = version > previous.current
    previous.current = version
    if (!changed) return
    setPulse(version)
    const timeout = window.setTimeout(() => setPulse(undefined), 780)
    return () => window.clearTimeout(timeout)
  }, [version])

  if (version <= 1) return null
  return <g className="brain-evolution-badge" role="button" tabIndex={0} aria-label={'认知年轮 v' + version}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); open() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
    }}>
    {pulse === version && <ellipse key={version} className="brain-evolution-pulse" aria-hidden="true"
      cx={x} cy={y} rx="18" ry="13"/>}
    <rect x={x - 14} y={y - 8.5} width="28" height="17" rx="8"/>
    <text x={x} y={y + 3.5} textAnchor="middle">v{version}</text>
  </g>
}

export function SkillDock({ skills, wave, inspect, create }: {
  skills: BrainSkill[]; wave?: BrainActivationWave; inspect: (skill: BrainSkill) => void; create: () => void
}) {
  return <div className="brain-skill-dock" role="group" aria-label="小脑 · 程序性技能库">
    <span>小脑 · 技能</span>
    <div className="brain-skill-list">
      {skills.map(skill => <button type="button" key={skill.id} data-attached={wave?.activatedSkillIds.includes(skill.id) || undefined}
        onClick={() => inspect(skill)}>{skill.title} <small>调用 {skill.usageCount} 次</small></button>)}
    </div>
    <IconAction icon={IconNew} label="新技能" onClick={create}/>
  </div>
}

export function SkillDialog({ skill, close }: { skill?: BrainSkill; close: () => void }) {
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try { await api().saveSkill({ title, tags: tags.split(/[，,]/), system_prompt: prompt }); close() }
    catch (issue) { setError(message(issue)); setBusy(false) }
  }
  return <EditorDialog title={skill?.title ?? '新增技能'} close={close} kind="brain" cancelLabel={skill ? '关闭' : '取消'}>
    {skill ? <div className="brain-timeline">
      <p>{skill.tags.map(tag => '#' + tag).join(' · ')}</p>
      <p>调用 {skill.usageCount} 次 · 已采纳任务 {skill.successCount} 次{skill.preferredAgentId && ' · 优先 ' + skill.preferredAgentId}</p>
      <pre>{skill.systemPrompt}</pre>
    </div> : <form className="brain-form" onSubmit={save}>
      <label>技能名称<input value={title} onChange={event => setTitle(event.target.value)} required/></label>
      <label>触发标签，以逗号分隔<input value={tags} onChange={event => setTags(event.target.value)} required/></label>
      <label>任务指令<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={5} required/></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="button-primary" disabled={busy || !title.trim() || !tags.trim() || !prompt.trim()}>保存技能</button>
    </form>}
  </EditorDialog>
}

export function EvolutionTimelineModal({ id, title, close }: { id: string; title: string; close: () => void }) {
  const [history, setHistory] = useState<BrainHistory>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void api().history(id).then(value => { if (live) setHistory(value) }, issue => { if (live) setError(message(issue)) })
    return () => { live = false }
  }, [id])
  return <EditorDialog title={'认知年轮 · ' + title} close={close} kind="brain" cancelLabel="关闭">
    <div className="brain-timeline">
      {error ? <p role="alert">{error}</p> : !history ? <p role="status">正在读取认知年轮…</p> : <>
        {history.assertions.length > 0 && <section aria-label="事实断言">
          <h3>事实断言</h3>
          {history.assertions.map(claim => <article key={claim.id} data-historical={claim.validTo !== null}>
            <strong>{claim.validTo === null ? '当前有效' : '历史断言'}</strong>
            <p>{claim.claim}</p>
            <small>记录于 {date(claim.observedAt)} · 生效于 {date(claim.validFrom)}
              {claim.validTo !== null && ' · 截止于 ' + date(claim.validTo)}</small>
          </article>)}
        </section>}
        <section aria-label="版本历史">
          <h3>版本历史</h3>
          {history.evolutions.length ? history.evolutions.map(entry => <article key={entry.version}>
            <strong>v{entry.version} · {date(entry.createdAt)}</strong><p>{entry.summary}</p>
            <details><summary>修订前的笔记片段</summary><pre>{entry.previousExcerpt}</pre></details>
          </article>) : <p>这篇笔记还没有记忆修订。</p>}
        </section>
      </>}
    </div>
  </EditorDialog>
}
