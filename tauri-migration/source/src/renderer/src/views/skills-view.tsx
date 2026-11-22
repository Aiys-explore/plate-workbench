import { useEffect, useRef, useState, type FormEvent } from 'react'
import { parseDocument } from 'yaml'
import type { ModelProfile } from '../../../shared/harness'
import type { BrainSkill, BrainSpace } from '../../../shared/brain'
import { IconAction } from '../icon-action'
import { IconEdit, IconMore, IconNew, IconSkills, IconUpload, IconWorkbench } from '../components/icons'
import { useWorkbench } from '../store'
import { SkillGovernance } from './skill-governance'

const api = () => window.workbench.brain
const newDraft = () => ({ id: '', title: '', tags: '', prompt: '', preferred: '', allowShell: false, allowNetwork: false, spaceId: 'work', defaultProfileId: '' })
const issue = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function SkillsView() {
  const [skills, setSkills] = useState<BrainSkill[]>([])
  const [agents, setAgents] = useState<Awaited<ReturnType<typeof window.workbench.agentPlugins.active>>>([])
  const [tab, setTab] = useState<'versions' | 'evals' | 'basic'>('basic')
  const [spaces, setSpaces] = useState<BrainSpace[]>([])
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [draft, setDraft] = useState(newDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const titleField = useRef<HTMLInputElement>(null)
  const trySkill = useWorkbench(state => state.trySkill)

  useEffect(() => {
    let live = true
    const refresh = () => void api().skills().then(items => { if (live) setSkills(items) })
      .catch(cause => { if (live) setError(issue(cause)) })
    refresh()
    void window.workbench.agentPlugins.active().then(items => { if (live) setAgents(items) })
      .catch(cause => { if (live) setError(issue(cause)) })
    void Promise.all([api().spaces(), window.workbench.harness.profiles()])
      .then(([areas, models]) => { if (live) { setSpaces(areas); setProfiles(models) } })
      .catch(cause => { if (live) setError(issue(cause)) })
    const off = api().onChanged(refresh)
    return () => { live = false; off() }
  }, [])

  function choose(skill?: BrainSkill) {
    setDraft(skill ? {
      id: skill.id, title: skill.title, tags: skill.tags.join('、'), prompt: skill.systemPrompt,
      preferred: skill.preferredAgentId ?? '', allowShell: skill.allowShell, allowNetwork: skill.allowNetwork,
      spaceId: skill.spaceId, defaultProfileId: skill.defaultProfileId ?? '',
    } : newDraft())
    setTab(skill ? 'versions' : 'basic')
    setStatus('')
    setError('')
    titleField.current?.focus()
  }

  async function load(file: File | undefined) {
    if (!file) return
    setError('')
    try {
      if (file.size > 48_000) throw new Error('请选择不超过 48 KB 的 Markdown 技能文件')
      const text = (await file.text()).replace(/^\uFEFF/, '')
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
      const header = match ? parseDocument(match[1]) : undefined
      if (header?.errors.length) throw new Error('SKILL.md 的 YAML 首部无效')
      const parsed = header?.toJS({ maxAliasCount: 0 }) as { name?: unknown; title?: unknown; tags?: unknown } | undefined
      const body = text.slice(match?.[0].length ?? 0).trim()
      const label = parsed?.title ?? parsed?.name
      setDraft({
        ...newDraft(),
        title: typeof label === 'string' ? label : body.match(/^# +(.+)$/m)?.[1] ?? file.name.replace(/\.md$/i, ''),
        tags: Array.isArray(parsed?.tags) ? parsed.tags.filter(value => typeof value === 'string').join('、') : '',
        prompt: body,
      })
      setStatus('已读取技能文件，请核对名称和任务指令后保存。')
      titleField.current?.focus()
    } catch (cause) { setError(issue(cause)) }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setStatus('')
    void api().saveWorkbenchSkill({
      skillId: draft.id || undefined, input: { title: draft.title,
        tags: draft.tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean), system_prompt: draft.prompt },
      spaceId:draft.spaceId, defaultProfileId:draft.defaultProfileId,
      preferredAgentId: draft.preferred || undefined, allowShell: draft.allowShell, allowNetwork: draft.allowNetwork,
    }).then(id => {
      setDraft(current => ({ ...current, id }))
      setStatus('技能已保存。')
    }).catch(cause => setError(issue(cause))).finally(() => setBusy(false))
  }

  const current = skills.find(skill => skill.id === draft.id)
  return <section className="s10-content s10-skills" aria-label="技能库">
    <div className="s10-section-header">
      <h1>技能库</h1>
      <div className="s10-actions">
        <IconAction icon={IconNew} label="新增技能" onClick={() => choose()}/>
        <IconAction icon={IconMore} label="技能更多操作" aria-expanded={menu} onClick={() => setMenu(!menu)}/>
      </div>
    </div>
    {menu && <div className="s10-actions">
      <button type="button" onClick={() => { setMenu(false); file.current?.click() }}>
        <IconUpload size={14} strokeWidth={1.65} aria-hidden="true"/> 导入 SKILL.md
      </button>
    </div>}
    <input ref={file} type="file" aria-label="技能 Markdown 文件" accept=".md,.markdown,text/markdown" hidden
      onChange={event => { void load(event.currentTarget.files?.[0]); event.currentTarget.value = '' }}/>
    <div className="s10-settings-grid">
      <ul className="s10-provider-list" aria-label="已保存技能">
        {skills.map(item => <li className="s10-row" key={item.id}>
          <button type="button" className="s10-row-label" aria-pressed={draft.id === item.id} onClick={() => choose(item)}>
            <IconSkills size={14} strokeWidth={1.65} aria-hidden="true"/><span className="s10-row-title">
              <strong>{item.title}</strong><span>调用 {item.usageCount} · 采纳 {item.successCount}</span>
            </span>
          </button>
          <div className="s10-row-actions">
            <IconAction icon={IconEdit} label={'编辑 ' + item.title} onClick={() => choose(item)}/>
            <IconAction icon={IconWorkbench} label={'试用 ' + item.title} onClick={() => trySkill(item.id)}/>
          </div>
        </li>)}
      </ul>
      <section className="s11-skill-detail">
        {current && <div className="s11-segments" role="group" aria-label="技能详情">
          {([['versions','提示词版本'],['evals','回归评测'],['basic','基础配置']] as const).map(([id,label]) =>
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </div>}
        {current && tab !== 'basic' ? <SkillGovernance key={current.id} skill={current} tab={tab}/> :
      <form onSubmit={save} className="s10-run-form" aria-label="技能编辑器">
        <label>技能名称<input ref={titleField} value={draft.title} required maxLength={100}
          onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
        <label>触发标签<input value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })}/></label>
        <label>优先本机 Agent<select value={draft.preferred} onChange={e => setDraft({ ...draft, preferred: e.target.value })}>
          <option value="">由任务选择</option>
          {draft.preferred && !agents.some(agent => agent.id === draft.preferred) && <option value={draft.preferred}>{draft.preferred}</option>}
          {agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
        </select></label>
        <label>所属脑区<select value={draft.spaceId} onChange={event => setDraft({ ...draft,spaceId:event.target.value })}>
          {spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select></label>
        <label>默认 Profile<select value={draft.defaultProfileId} onChange={event => setDraft({ ...draft,defaultProfileId:event.target.value })}>
          <option value="">由任务选择</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        {!current && <label>任务指令<textarea rows={8} value={draft.prompt} required maxLength={4000}
          onChange={e => setDraft({ ...draft, prompt: e.target.value })}/></label>}
        <label className="s10-check"><input type="checkbox" checked={draft.allowNetwork}
          onChange={e => setDraft({ ...draft, allowNetwork: e.target.checked })}/>可使用已获任务授权的模型连接</label>
        <label className="s10-check"><input type="checkbox" checked={draft.allowShell}
          onChange={e => setDraft({ ...draft, allowShell: e.target.checked })}/>可使用已获任务授权的子进程</label>
        <div className="s10-actions">
          <button type="submit" disabled={busy}>保存技能</button>
          {current && <IconAction icon={IconWorkbench} label="在工作台试用" onClick={() => trySkill(current.id)}/>}
        </div>
        <p role="status">{status}</p>
        {error && <p role="alert" className="s10-error">{error}</p>}
      </form>}
      </section>
    </div>
  </section>
}
