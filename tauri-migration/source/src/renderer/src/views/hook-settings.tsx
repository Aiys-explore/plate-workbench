import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import type { HarnessHook, HookEvent } from '../../../shared/harness'
import { IconAction } from '../icon-action'

const api = () => window.workbench.harness
const events: HookEvent[] = ['UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd']
const eventLabels: Record<HookEvent,string> = {
  UserPromptSubmit:'提交任务', PreToolUse:'工具执行前', PostToolUse:'工具执行后',
  Stop:'模型准备结束', SessionEnd:'会话结束',
}
const blank = (): HarnessHook => ({
  id:'',name:'',eventName:'PreToolUse',matcher:'*',handlerKind:'command',commandOrRef:'',
  scriptSha256:'',trustedSha256:'',sourcePreview:'',timeoutSec:30,asyncRun:false,enabled:true,
})

export function HookSettings() {
  const [hooks, setHooks] = useState<HarnessHook[]>([])
  const [form, setForm] = useState<HarnessHook>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => setHooks(await api().hooks()), [])
  useEffect(() => { void refresh().catch(cause => setError(String(cause))) }, [refresh])
  const field = <K extends keyof HarnessHook>(key: K,value: HarnessHook[K]) =>
    setForm(current => current && { ...current, [key]:value })

  async function action(work: () => Promise<unknown>) {
    setError('')
    setBusy(true)
    try { await work(); await refresh() }
    catch (cause) { setError(String(cause)); await refresh().catch(() => {}) }
    finally { setBusy(false) }
  }

  return <section className="s11-governance" aria-label="Hooks 与信任">
    <header className="s10-section-header"><h2>Hooks 与信任</h2>
      <div className="s10-actions">
        <IconAction icon={RefreshCw} label="刷新 Hook 内容哈希" disabled={busy} onClick={() => void action(refresh)}/>
        <IconAction icon={Plus} label="新增 Hook" disabled={busy} onClick={() => setForm(blank())}/>
      </div>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="s11-trace">
      {hooks.map(hook => {
        const builtin = hook.handlerKind === 'builtin'
        const needsTrust = !builtin && (!hook.scriptSha256 || hook.scriptSha256 !== hook.trustedSha256)
        return <details key={hook.id}>
          <summary>{hook.name} · {eventLabels[hook.eventName]} {needsTrust && <strong className="s11-trust-warning">待信任</strong>}</summary>
          <label className="s10-check"><input type="checkbox" checked={hook.enabled} disabled={busy}
            onChange={event => void action(() => api().toggleHook(hook.id,event.target.checked))}/> 启用</label>
          {!builtin && <>
            <p>{hook.handlerKind === 'mcp_tool' ? 'MCP 工具引用' : 'Rhai 受限脚本'}</p>
            {hook.commandOrRef.startsWith('file:') && <p>{hook.commandOrRef}</p>}
            <p className="s11-hash">SHA-256 · {hook.scriptSha256 || '无法读取当前内容'}</p>
            <pre>{hook.sourcePreview}</pre>
            <div className="s10-actions">
              {needsTrust && <IconAction icon={ShieldCheck} label="信任此哈希" disabled={busy || !hook.scriptSha256}
                onClick={() => void action(() => api().trustHook(hook.id,hook.scriptSha256))}>信任</IconAction>}
              <button type="button" disabled={busy} onClick={() => setForm(hook)}>编辑</button>
            </div>
          </>}
        </details>
      })}
    </div>
    {form && <form className="s10-run-form" aria-label="Hook 编辑器" onSubmit={event => {
      event.preventDefault()
      void action(async () => { await api().saveHook(form); setForm(undefined) })
    }}>
      <label>Hook 名称<input required value={form.name} onChange={event => field('name',event.target.value)}/></label>
      <div className="s10-price-inputs">
        <label>生命周期<select value={form.eventName} onChange={event =>
          setForm({ ...form,eventName:event.target.value as HookEvent,asyncRun:false })}>
          {events.map(event => <option key={event} value={event}>{eventLabels[event]} · {event}</option>)}
        </select></label>
        <label>处理类型<select value={form.handlerKind} onChange={event =>
          field('handlerKind',event.target.value as HarnessHook['handlerKind'])}>
          <option value="command">Rhai 受限脚本</option><option value="mcp_tool">MCP 工具</option>
        </select></label>
        <label>匹配条件<input value={form.matcher} placeholder="*、工具名称或正则" onChange={event => field('matcher',event.target.value)}/></label>
        <label>超时（秒）<input type="number" min="1" max="120" value={form.timeoutSec}
          onChange={event => field('timeoutSec',Number(event.target.value))}/></label>
      </div>
      <label>{form.handlerKind === 'mcp_tool' ? 'MCP 地址与工具名' : '脚本或 file:绝对路径（.rhai）'}
        <textarea rows={5} required value={form.commandOrRef} onChange={event => field('commandOrRef',event.target.value)}/>
      </label>
      <p className="s10-quiet-empty">{form.handlerKind === 'mcp_tool'
        ? '格式为 HTTPS 或本机回环地址#工具名称，任务须授权联网。'
        : '从 hook 对象读取事件，返回 Rhai 决策对象，例如 #{ allow: true }。保存后可展开核对内容和信任哈希。'}</p>
      {(form.eventName === 'PostToolUse' || form.eventName === 'SessionEnd') && <label className="s10-check">
        <input type="checkbox" checked={form.asyncRun} onChange={event => field('asyncRun',event.target.checked)}/>异步通知
      </label>}
      <div className="s10-actions">
        <button type="button" onClick={() => setForm(undefined)}>取消</button>
        <IconAction icon={Save} label="保存 Hook" type="submit" disabled={busy}/>
      </div>
    </form>}
  </section>
}
