import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { AgentSettings } from '../../shared/ipc'
import type { AgentProfile } from '../../shared/agents'

const names: Record<string, string> = {
  dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode',
}
const settingsEvent = 'plate-open-agent-settings'

export function openAgentSettings() {
  window.dispatchEvent(new Event(settingsEvent))
}

export function useAgentSettingsEntry(open: () => void) {
  useEffect(() => {
    window.addEventListener(settingsEvent, open)
    return () => window.removeEventListener(settingsEvent, open)
  }, [open])
}

function AgentDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} className="home-runtime-dialog plate-agent-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <header><h2 id={heading}>{title}</h2>
      <button type="button" className="p13-action" onClick={onClose}>关闭</button>
    </header>
    {children}
  </dialog>
}

export function AgentSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AgentSettings>()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [defaultAgent, setDefaultAgent] = useState('')
  const [key, setKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [issue, setIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [scan, setScan] = useState(0)
  const detected = new Set(agents.map(agent => agent.id))
  useEffect(() => {
    let live = true
    setBusy(true)
    setIssue('')
    void Promise.all([window.workbench.agentSettings.get(), window.workbench.agents.list()]).then(([next, listed]) => {
      if (!live) return
      setSettings(next)
      setDefaultAgent(next.defaultAgent ?? '')
      setAgents(listed)
    }, error => { if (live) setIssue(String(error)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [scan])
  const save = async () => {
    setBusy(true)
    setIssue('')
    setNotice('')
    try {
      const saved = await window.workbench.agentSettings.save({
        defaultAgent: defaultAgent || null,
        deepseekKey: key.trim() || undefined,
        clearDeepseekKey: removeKey,
      })
      setSettings(saved)
      setKey('')
      setRemoveKey(false)
      setNotice('Agent 设置已保存')
    } catch (error) {
      setIssue(String(error))
    } finally {
      setBusy(false)
    }
  }
  return <AgentDialog title="Agent 设置" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (!busy && settings) void save() }}>
      <fieldset disabled={busy || !settings}>
        <label>默认 Agent
          <select value={defaultAgent} onChange={event => setDefaultAgent(event.target.value)}>
            <option value="">每次选择</option>
            {Object.entries(names).map(([id, name]) =>
              <option value={id} key={id} disabled={!detected.has(id)}>
                {name}{detected.has(id) ? '' : '（未找到）'}
              </option>)}
          </select>
        </label>
        <p>Codex、Claude Code 和 OpenCode 使用本机 CLI 的登录或模型配置。</p>
        <label>DeepSeek API Key
          <input type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={key}
            placeholder={settings?.deepseekKey === 'saved' ? '留空以保留已保存密钥' : '输入 DeepSeek API Key'}
            onChange={event => { setKey(event.target.value); setRemoveKey(false) }}/>
        </label>
        <p>{settings?.deepseekKey === 'saved' ? '已用当前 Windows 用户凭据加密保存。' :
          settings?.deepseekKey === 'environment' ? '当前使用启动环境中的密钥。' :
          '后台执行使用 API Key，与 DeepSeek 桌面版登录分开。'}</p>
        {settings?.deepseekKey === 'saved' && <label className="plate-agent-remove-key">
          <input type="checkbox" checked={removeKey} onChange={event => {
            setRemoveKey(event.target.checked)
            if (event.target.checked) setKey('')
          }}/> 保存时移除已存密钥
        </label>}
      </fieldset>
      {issue && <p role="alert">{issue}</p>}
      {notice && <p role="status">{notice}</p>}
      <footer>
        <button className="p13-action" type="button" disabled={busy} onClick={() => setScan(value => value + 1)}>刷新检测</button>
        <button className="p13-action plate-agent-primary" type="submit" disabled={busy || !settings}>保存设置</button>
      </footer>
    </form>
  </AgentDialog>
}

export function TaskAgentDialog({ onClose, select }: { onClose: () => void; select: (agent: string) => void }) {
  const [agents, setAgents] = useState<AgentProfile[]>()
  const [issue, setIssue] = useState('')
  useEffect(() => {
    let live = true
    void window.workbench.agents.list().then(rows => { if (live) setAgents(rows) }, error => {
      if (live) setIssue(String(error))
    })
    return () => { live = false }
  }, [])
  return <AgentDialog title="交给哪个 Agent？" onClose={onClose}>
    {issue ? <p role="alert">{issue}</p> : !agents ? <p role="status">正在检测本机 Agent…</p> :
      agents.length ? <ul className="plate-agent-choices">{agents.map(agent =>
        <li key={agent.id}><button className="p13-action" type="button" onClick={() => select(agent.id)}>{agent.name}</button></li>
      )}</ul> : <p>未找到本机 Agent。安装后可在 Agent 设置中刷新检测。</p>}
    <footer><button className="p13-action" type="button" onClick={() => { onClose(); openAgentSettings() }}>Agent 设置</button></footer>
  </AgentDialog>
}
