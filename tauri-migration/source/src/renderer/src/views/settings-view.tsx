import { FileText, SlidersHorizontal } from 'lucide-react'
import { ProfileSettings, GlobalPromptSettings } from './harness-settings'
import { IconAction } from '../icon-action'
import { IconApiKey, IconAttachLog, IconDelete, IconModel, IconNew, IconRefresh, IconShield } from '../components/icons'
import { readPreferences, savePreferences } from '../s10-preferences'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ModelRole, ProviderConfig, ProviderKind, UpsertProviderInput } from '../../../shared/harness'

const services: Record<ProviderKind, { label: string; baseUrl: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openai_compatible: { label: 'OpenAI 兼容', baseUrl: '' },
}
const roleLabels: Record<ModelRole, string> = {
  workbench_chat: '工作台任务',
  brain_consolidator: '做梦整理',
  embedding: '向量',
}
const blankProvider = (): UpsertProviderInput => ({
  name: '', kind: 'openai', baseUrl: services.openai.baseUrl, defaultModel: '',
  roles: ['workbench_chat'], inputPricePer1m: 0, outputPricePer1m: 0, enabled: true,
})
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)

export function SettingsView({ openAgentSettings }: { openAgentSettings: () => void }) {
  const [tab, setTab] = useState<'agents' | 'providers' | 'logs' | 'limits' | 'profiles' | 'global'>('providers')
  const [prefs, setPrefs] = useState(readPreferences)
  const [prefsStatus, setPrefsStatus] = useState('')
  function saveLocalPreferences(event: FormEvent) {
    event.preventDefault()
    try { savePreferences(prefs); setPrefsStatus('本机偏好已保存。') }
    catch { setPrefsStatus('本机偏好保存失败。') }
  }
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [form, setForm] = useState(blankProvider)
  const [hint, setHint] = useState('')
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const secretField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let mounted = true
    void window.workbench.providers.list().then(
      items => { if (mounted) setProviders(items) },
      cause => { if (mounted) setError(describe(cause)) },
    ).finally(() => { if (mounted) setPending(false) })
    return () => { mounted = false }
  }, [])

  function select(provider?: ProviderConfig) {
    if (secretField.current) secretField.current.value = ''
    setConfirmRemove(false)
    setError('')
    setStatus('')
    if (provider) {
      const { keyHint, updatedAt, ...input } = provider
      setForm(input)
      setHint(keyHint)
    } else {
      setForm(blankProvider())
      setHint('')
    }
  }

  function update<K extends keyof UpsertProviderInput>(field: K, value: UpsertProviderInput[K]) {
    setForm(current => ({ ...current, [field]: value }))
  }

  async function act(action: () => Promise<string>) {
    setPending(true)
    setError('')
    setStatus('')
    try { setStatus(await action()) }
    catch (cause) { setError(describe(cause)) }
    finally { setPending(false) }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const apiKey = secretField.current?.value
    if (secretField.current) secretField.current.value = ''
    void act(async () => {
      const saved = await window.workbench.providers.upsert({ ...form, apiKey })
      setProviders(items => [saved, ...items.filter(item => item.id !== saved.id)])
      select(saved)
      return '服务商已保存'
    })
  }

  const selectedId = form.id
  return <section className="s10-content s10-settings" aria-labelledby="s10-settings-title">
    <h1 id="s10-settings-title" className="s10-visually-hidden">模型与权限</h1>
    <div className="s10-settings-sections">
      <nav aria-label="设置分类">
        {([
          ['agents','本机 CLI',IconModel], ['providers','API 模型服务商',IconApiKey],
          ['logs','本机记录来源',IconAttachLog], ['limits','默认任务上限',IconShield],
          ['profiles','Model Profiles',SlidersHorizontal], ['global','全局系统提示词',FileText],
        ] as const).map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={tab === id}
          onClick={() => { setTab(id); setPrefsStatus('') }}>
          <Icon size={14} strokeWidth={1.65} aria-hidden="true"/>{label}
        </button>)}
      </nav>
      <div>
      {tab === 'profiles' && <ProfileSettings providers={providers}/>}
      {tab === 'global' && <GlobalPromptSettings/>}
      {tab === 'agents' && <section>
        <h2>本机 CLI</h2>
        <button type="button" onClick={openAgentSettings}>本机 Agent 设置</button>
      </section>}
      {(tab === 'logs' || tab === 'limits') && <form onSubmit={saveLocalPreferences}>
        <h2>{tab === 'logs' ? '本机记录来源' : '默认任务上限'}</h2>
        {tab === 'logs' ? <>
          <label className="s10-check"><input type="checkbox" checked={prefs.includeDefaultLogs}
            onChange={event => setPrefs({ ...prefs, includeDefaultLogs: event.target.checked })}/>扫描 Claude Code 和 Codex 默认目录</label>
          <label>自定义目录<input value={prefs.customLogDirectory}
            onChange={event => setPrefs({ ...prefs, customLogDirectory: event.target.value })}/></label>
        </> : <>
          <label>默认步数上限<input type="number" min="1" max="40" step="1" required value={prefs.maxSteps}
            onChange={event => setPrefs({ ...prefs, maxSteps: Number(event.target.value) })}/></label>
          <label>默认预算上限（美元）<input type="number" min="0" max="1000" step="any" required value={prefs.maxBudgetUsd}
            onChange={event => setPrefs({ ...prefs, maxBudgetUsd: Number(event.target.value) })}/></label>
        </>}
        <button type="submit">保存本机偏好</button><p role="status">{prefsStatus}</p>
      </form>}
      {tab === 'providers' && <section aria-label="API 模型服务商">
      <h2>API 模型服务商</h2>
    <div className="s10-settings-grid">
      <aside aria-label="模型服务商列表">
        <IconAction icon={IconNew} label="新增服务商" disabled={pending} onClick={() => select()}/>
        <ul className="s10-provider-list">
          {providers.map(provider => <li key={provider.id}><button type="button" disabled={pending}
            aria-pressed={selectedId === provider.id} onClick={() => select(provider)}>
            <strong>{provider.name}</strong>
            <span>{provider.defaultModel} · {provider.enabled ? '已启用' : '已停用'}</span>
          </button></li>)}
        </ul>
      </aside>
      <form onSubmit={save} aria-busy={pending}>
        <fieldset disabled={pending}>
          <legend>{selectedId ? '编辑服务商' : '新增服务商'}</legend>
          <label>名称<input value={form.name} maxLength={80} required onChange={e => update('name', e.target.value)}/></label>
          <label>类型<select value={form.kind} onChange={event => {
            const kind = event.target.value as ProviderKind
            setForm(current => ({ ...current, kind, baseUrl: services[kind].baseUrl }))
          }}>
            {Object.entries(services).map(([kind, service]) => <option key={kind} value={kind}>{service.label}</option>)}
          </select></label>
          <label>服务地址<input type="url" value={form.baseUrl} required onChange={e => update('baseUrl', e.target.value)}/></label>
          <label>默认模型<input value={form.defaultModel} maxLength={80} required onChange={e => update('defaultModel', e.target.value)}/></label>
          <label>API Key<input ref={secretField} type="password" autoComplete="new-password"
            aria-describedby="s10-key-hint" maxLength={2048}/></label>
          <p id="s10-key-hint">{hint ? `已保存 ${hint}。留空沿用。` : '保存在系统钥匙串。'}</p>
          <fieldset className="s10-inline-options">
            <legend>模型用途</legend>
            {(Object.keys(roleLabels) as ModelRole[]).map(role => <label key={role}>
              <input type="checkbox" checked={form.roles.includes(role)} onChange={e => update('roles', e.target.checked
                ? [...form.roles, role] : form.roles.filter(item => item !== role))}/>{roleLabels[role]}
            </label>)}
          </fieldset>
          <div className="s10-price-inputs">
            <label>输入 / 百万 token（美元）<input type="number" min="0" step="any"
              value={form.inputPricePer1m} onChange={e => update('inputPricePer1m', Number(e.target.value))}/></label>
            <label>输出 / 百万 token（美元）<input type="number" min="0" step="any"
              value={form.outputPricePer1m} onChange={e => update('outputPricePer1m', Number(e.target.value))}/></label>
          </div>
          <label className="s10-check"><input type="checkbox" checked={form.enabled}
            onChange={e => update('enabled', e.target.checked)}/>启用该服务商</label>
          <div className="s10-actions">
            <button type="submit">保存服务商</button>
            {selectedId && <>
              <IconAction icon={IconRefresh} label="测试已保存配置" onClick={() => void act(async () => {
                await window.workbench.providers.test(selectedId)
                return '已连通保存的模型服务'
              })}/>
              <IconAction icon={IconDelete} label="删除服务商" danger onClick={() => setConfirmRemove(true)}/>
            </>}
          </div>
          {selectedId && confirmRemove && <div className="s10-actions">
            <span>删除该服务商及保存的 API Key？</span>
            <button type="button" onClick={() => void act(async () => {
              await window.workbench.providers.remove(selectedId)
              setProviders(items => items.filter(item => item.id !== selectedId))
              select()
              return '服务商已删除'
            })}>确认删除</button>
            <button type="button" onClick={() => setConfirmRemove(false)}>取消</button>
          </div>}
        </fieldset>
        <p role="status">{pending ? '处理中…' : status}</p>
        {error && <p className="s10-error" role="alert">{error}</p>}
      </form>
    </div>
      </section>}
      </div>
    </div>
  </section>
}
