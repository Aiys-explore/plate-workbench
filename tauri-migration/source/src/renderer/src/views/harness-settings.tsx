import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import type { BrainSpace } from '../../../shared/brain'
import type { ModelProfile, ProviderConfig } from '../../../shared/harness'
import { IconAction } from '../icon-action'

const api = () => window.workbench.harness

function newProfile(): ModelProfile {
  return {
    id: '', name: '', backendKind: 'api_key', backendId: '', modelName: '', reasoningEffort: 'medium',
    temperature: 0.3, maxSteps: 12, maxBudgetUsd: 0.5, defaultSpaceId: 'work',
    defaultPermissions: {
      readableNoteIds: [], readableLogSessionIds: [], writableDirs: [], allowAllNotesRead: false,
      allowShell: false, allowNetwork: false, allowBrainNotePropose: true, maxSteps: 12, maxBudgetUsd: 0.5,
    },
  }
}

export function ProfileSettings({ providers }: { providers: ProviderConfig[] }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [agents, setAgents] = useState<Awaited<ReturnType<typeof window.workbench.agentPlugins.active>>>([])
  const [spaces, setSpaces] = useState<BrainSpace[]>([])
  const [form, setForm] = useState(newProfile)
  const [directories, setDirectories] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void Promise.all([api().profiles(), window.workbench.agentPlugins.active(), window.workbench.brain.spaces()])
      .then(([items, cli, areas]) => {
        if (live) { setProfiles(items); setAgents(cli); setSpaces(areas) }
      }).catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [])
  function select(profile = newProfile()) {
    setForm(profile)
    setDirectories(profile.defaultPermissions.writableDirs.join('\n'))
    setError('')
    setStatus('')
  }
  function field<K extends keyof ModelProfile>(key: K, value: ModelProfile[K]) {
    setForm(current => ({ ...current, [key]: value }))
  }
  async function save() {
    setBusy(true)
    setError('')
    try {
      const saved = await api().saveProfile({ ...form, defaultPermissions: {
        ...form.defaultPermissions, writableDirs: directories.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      } })
      setProfiles(items => [saved, ...items.filter(item => item.id !== saved.id)])
      select(saved)
      setStatus('Profile 已保存')
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <section className="s11-governance" aria-label="Model Profiles">
    <header className="s10-section-header"><h2>Model Profiles</h2><IconAction icon={Plus} label="新建 Profile" onClick={() => select()}/></header>
    <div className="s11-segments" aria-label="预设" role="group">{profiles.map(profile =>
      <button key={profile.id} type="button" aria-pressed={profile.id === form.id} onClick={() => select(profile)}>{profile.name}</button>)}</div>
    <form className="s10-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>预设名称<input required value={form.name} onChange={event => field('name', event.target.value)}/></label>
      <div className="s10-price-inputs">
        <label>执行引擎<select value={form.backendKind} onChange={event => setForm(current =>
          ({ ...current, backendKind: event.target.value as ModelProfile['backendKind'], backendId: '' }))}>
          <option value="api_key">API Key</option><option value="local_cli">本机 CLI</option>
        </select></label>
        <label>服务或 CLI<select value={form.backendId} onChange={event => field('backendId', event.target.value)}>
          <option value="">{form.backendKind === 'api_key' ? '使用工作台角色配置' : '选择本机 CLI'}</option>
          {(form.backendKind === 'api_key' ? providers : agents).map(service =>
            <option key={service.id} value={service.id}>{service.name}</option>)}
        </select></label>
        <label>目标脑区<select value={form.defaultSpaceId} onChange={event => field('defaultSpaceId', event.target.value)}>
          {spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select></label>
        <label>模型覆盖<input value={form.modelName} onChange={event => field('modelName', event.target.value)}/></label>
        <label>推理强度<select value={form.reasoningEffort} onChange={event => field('reasoningEffort', event.target.value as ModelProfile['reasoningEffort'])}>
          <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
        </select></label>
        <label>温度<input type="number" min="0" max="1" step="0.1" value={form.temperature} onChange={event => field('temperature', Number(event.target.value))}/></label>
        <label>步数上限<input type="number" min="1" max="40" value={form.maxSteps} onChange={event => field('maxSteps', Number(event.target.value))}/></label>
        <label>预算上限（美元）<input type="number" min="0" max="1000" step="any" value={form.maxBudgetUsd} onChange={event => field('maxBudgetUsd', Number(event.target.value))}/></label>
      </div>
      <label>授权目录，每行一个绝对路径<textarea rows={3} value={directories} onChange={event => setDirectories(event.target.value)}/></label>
      <div className="s10-actions">
        {([['allowNetwork','允许联网'], ['allowShell','允许隔离 CLI 子进程'],
          ['allowAllNotesRead','允许读取范围内全部笔记'], ['allowBrainNotePropose','允许提议笔记修改']] as const).map(([key, label]) =>
          <label key={key} className="s10-check"><input type="checkbox" checked={form.defaultPermissions[key]}
            onChange={event => field('defaultPermissions', { ...form.defaultPermissions, [key]: event.target.checked })}/>{label}</label>)}
      </div>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
      <div className="s10-actions">
        <IconAction icon={Save} label="保存 Profile" type="submit" disabled={busy || !form.name.trim()}/>
        {form.id && <IconAction icon={Trash2} label="删除 Profile" danger disabled={busy} onClick={() => {
          const id = form.id
          setBusy(true)
          void api().deleteProfile(id).then(() => { setProfiles(items => items.filter(item => item.id !== id)); select() })
            .catch(cause => setError(String(cause))).finally(() => setBusy(false))
        }}/>}
      </div>
    </form>
  </section>
}

export function GlobalPromptSettings() {
  const [prompt, setPrompt] = useState('')
  const [feedback, setFeedback] = useState({ error: false, text: '' })
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    void api().globalPrompt().then(value => { if (live) { setPrompt(value); setReady(true) } })
      .catch(cause => { if (live) setFeedback({ error: true, text: String(cause) }) })
    return () => { live = false }
  }, [])
  return <form className="s11-governance s10-form" onSubmit={event => {
    event.preventDefault()
    void api().saveGlobalPrompt(prompt).then(() => setFeedback({ error: false, text: '全局提示词已保存' }))
      .catch(cause => setFeedback({ error: true, text: String(cause) }))
  }}>
    <h2>全局系统提示词</h2>
    <label>办公指令<textarea rows={9} value={prompt} onChange={event => setPrompt(event.target.value)}
      placeholder="留空使用内置办公指令" disabled={!ready}/></label>
    <IconAction icon={Save} label="保存全局提示词" type="submit" disabled={!ready}/>
    {feedback.text && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </form>
}
