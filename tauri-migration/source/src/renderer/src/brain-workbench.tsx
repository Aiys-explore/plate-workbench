import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { BrainActivationWave, BrainHistory, BrainNoteMetadata, BrainSkill, BrainSpace, EpisodicEvent, StaleMemory } from '../../shared/brain'
import type { RelationshipNote } from '../../shared/ipc'
import { EditorDialog } from './note-editor'
import { IconAction } from './icon-action'
import { IconDream, IconHeat, IconNew, IconSend, IconZones } from './components/icons'
import { Check, Pencil, ShieldAlert, Trash2 } from 'lucide-react'
import './styles/brain-dynamics.css'

const api = () => window.workbench.brain
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const date = (time: number) => new Date(time).toLocaleString('zh-CN')

export function useBrainWorkbench(project: string | undefined, visible: boolean) {
  const [spaceId, setSpaceId] = useState('learning')
  const [spaces, setSpaces] = useState<BrainSpace[]>([])
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
      const [metadata, captures, library, preferences, availableSpaces] = await Promise.all([
        api().metadata(), api().events(project, spaceId), api().skills(), api().status(), api().spaces(),
      ])
      if (request !== refreshSequence.current) return
      setNotes(metadata)
      setEvents(captures)
      setSkills(library)
      setStatus(preferences)
      setSpaces(availableSpaces)
      setError('')
    } catch (issue) { if (request === refreshSequence.current) setError(message(issue)) }
  }, [project, spaceId])
  useEffect(() => {
    if (!visible) return
    const off = api().onChanged(refresh)
    void refresh()
    return () => { refreshSequence.current++; off() }
  }, [refresh, visible])
  return { notes, events: events.filter(event => event.spaceId === spaceId),
    skills: skills.filter(skill => skill.spaceId === spaceId), spaces, spaceId, setSpaceId, status, wave, error, refresh }
}

export function BrainHudBar({ wave, notes, events, zones, vitality, toggleZones, toggleVitality, dream, scan }: {
  wave?: BrainActivationWave; notes: number; events: number; zones: boolean; vitality: boolean
  toggleZones: () => void; toggleVitality: () => void; dream: () => void; scan: () => void
}) {
  return <div className="brain-hud">
    <output role="status" className="brain-run-status" data-active={!!wave}>
      {wave ? <>调度中 · 已唤醒 {wave.activatedNoteIds.length} 条记忆 · {wave.activatedSkillIds.length} 个技能</> :
        <>全脑就绪 · {events} 条闪念 · {notes} 个长期节点</>}
    </output>
    <div className="brain-hud-actions">
      <IconAction icon={IconZones} label="分区视图" active={zones} aria-pressed={zones} onClick={toggleZones}/>
      <IconAction icon={IconHeat} label="活力热力" active={vitality} aria-pressed={vitality} onClick={toggleVitality}/>
      <IconAction icon={ShieldAlert} label="巡检工作记忆" onClick={scan}/>
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

type CaptureProps = { project: string; projectLabel: string; spaceId: string; captured: (id: string, text: string) => void }

export function QuickCaptureBar({ close, ...props }: CaptureProps & { close: () => void }) {
  return <EditorDialog title="捕获闪念" close={close} kind="brain">
    <CaptureForm {...props} onSaved={close}/>
  </EditorDialog>
}

export function CaptureForm({ project, projectLabel, spaceId, captured, onSaved }: CaptureProps & { onSaved?: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      captured(await api().capture(project, text, spaceId), text)
      setText('')
      onSaved?.()
    } catch (issue) { setError(message(issue)) }
    finally { setBusy(false) }
  }
  return <form className={onSaved ? 'brain-form' : 'brain-form brain-capture-inline'} onSubmit={save}>
      <label>{onSaved && <>保存至 {projectLabel}</>}
        <textarea aria-label={onSaved ? '闪念内容' : '输入海马体闪念'} rows={onSaved ? 4 : 2} value={text} disabled={busy}
          placeholder="输入闪念，按 Enter 保存…"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              void save()
            }
          }}/>
      </label>
      {error && <p role="alert">{error}</p>}
      {onSaved ? <button type="submit" className="button-primary" disabled={busy || !text.trim()}>保存闪念</button>
        : <IconAction type="submit" icon={IconSend} label={'保存闪念至 ' + projectLabel} shortcut="Enter" disabled={busy || !text.trim()}/>}
    </form>
}

export function EpisodicLane({ events, spaces, spaceId, selectSpace, fresh, openCapture, promote, composer }: {
  events: EpisodicEvent[]; spaces: BrainSpace[]; spaceId: string; selectSpace: (id: string) => void
  fresh?: string; openCapture: () => void; promote: (event: EpisodicEvent) => Promise<void>; composer: ReactNode
}) {
  return <aside className="brain-episodic" aria-label="海马体 · 短期闪念">
    <div className="brain-lane-header">
      <span><small>海马体</small><strong>短期闪念</strong></span>
      <IconAction icon={IconNew} label="捕获闪念" shortcut="Ctrl+Shift+Space" onClick={openCapture}/>
    </div>
    <div className="s11-segments" role="group" aria-label="脑区">
      {spaces.map(space => <button type="button" key={space.id} aria-pressed={spaceId === space.id}
        onClick={() => selectSpace(space.id)}>{space.name}</button>)}
    </div>
    {composer}
    <div className="brain-event-list">
      {events.length === 0 && <p className="brain-muted">还没有闪念。</p>}
      {events.map(event => <CandidateCard key={event.id} event={event} spaces={spaces}
        fresh={fresh === event.id} promote={() => promote(event)}/>)}
    </div>
  </aside>
}

function CandidateCard({ event, spaces, fresh, promote }: {
  event: EpisodicEvent; spaces: BrainSpace[]; fresh: boolean; promote: () => Promise<void>
}) {
  const [editing, edit] = useState(false)
  const [text, setText] = useState(event.rawText)
  const [space, setSpace] = useState(event.spaceId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try { await action(); edit(false) }
    catch (issue) { setError(message(issue)) }
    finally { setBusy(false) }
  }
  function openEdit() { setText(event.rawText); setSpace(event.spaceId); edit(true) }
  return <article className="brain-episodic-card" data-event-id={event.id} data-new={fresh}>
    {editing ? <form className="brain-form" onSubmit={eventForm => {
      eventForm.preventDefault()
      void act(() => api().updateCandidate(event.id, text, space))
    }}>
      <textarea aria-label="编辑候选记忆" rows={4} value={text} onChange={e => setText(e.target.value)}/>
      <label>脑区<select value={space} onChange={e => setSpace(e.target.value)}>
        {spaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <div className="s10-actions">
        <button type="button" disabled={busy} onClick={() => edit(false)}>取消</button>
        <button type="submit" disabled={busy || !text.trim()}>保存</button>
      </div>
    </form> : <>
      <button type="button" className="s11-candidate-text" onClick={openEdit}>{event.rawText}</button>
      <footer><time dateTime={new Date(event.createdAt).toISOString()}>{date(event.createdAt)}</time>
        <div className="s11-candidate-actions">
          <IconAction icon={Pencil} label="编辑候选记忆" onClick={openEdit} disabled={busy}/>
          <IconAction icon={Check} label="升格为笔记" onClick={() => void act(promote)} disabled={busy}/>
          <IconAction icon={Trash2} label="丢弃候选记忆" onClick={() => void act(() => api().discard(event.id))} disabled={busy}/>
        </div>
      </footer>
    </>}
    {error && <p role="alert">{error}</p>}
  </article>
}

export function ContextRotDialog({ items, close, propose }: {
  items: StaleMemory[]; close: () => void; propose: (id: string) => void
}) {
  return <EditorDialog title="工作记忆巡检" close={close} kind="brain" cancelLabel="关闭">
    <div className="brain-timeline">
      {!items.length && <p className="brain-muted">暂无休眠或超过 90 天未更新的工作记忆。</p>}
      {items.map(item => <article key={item.id}>
        <strong>{item.title}</strong>
        <p>{item.dormant ? '休眠' : '待复核'} · {date(item.updatedAt)}</p>
        <button type="button" onClick={() => propose(item.id)}>发起更新提案</button>
      </article>)}
    </div>
  </EditorDialog>
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
  return <EditorDialog title="做梦整理" close={close} kind="brain">
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
        <button type="submit" className="button-primary" disabled={busy || !selected.length || !target && !title.trim()}>加入影子审阅</button>
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
