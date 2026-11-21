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
    <header className="s10-section-header">
      <h1 id="s10-settings-title">模型与权限</h1>
      <button type="button" onClick={openAgentSettings}>本机 Agent 设置</button>
    </header>
    <h2>API 模型服务商</h2>
    <div className="s10-settings-grid">
      <aside aria-label="模型服务商列表">
        <button type="button" disabled={pending} onClick={() => select()}>新增服务商</button>
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
              <button type="button" onClick={() => void act(async () => {
                await window.workbench.providers.test(selectedId)
                return '已连通保存的模型服务'
              })}>测试已保存配置</button>
              <button type="button" onClick={() => setConfirmRemove(true)}>删除服务商</button>
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
  </section>
}
