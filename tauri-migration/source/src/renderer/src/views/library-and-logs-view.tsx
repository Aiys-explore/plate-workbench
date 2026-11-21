import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ExternalAgentMessage, ExternalAgentSession } from '../../../shared/harness'
import type { ProjectSummary } from '../../../shared/ipc'
import { useWorkbench } from '../store'

const pageSize = 100
const tools: Record<ExternalAgentSession['sourceTool'], string> = {
  claude_code: 'Claude Code', codex_cli: 'Codex CLI', gemini_cli: 'Gemini CLI', custom: '自定义',
}
const roles = { user: '用户', assistant: 'Agent', tool: '工具' }
const localTime = (time: number) => new Date(time).toLocaleString('zh-CN')
const api = () => window.workbench.agentLogs
const issue = (error: unknown) => error instanceof Error ? error.message : String(error)

export function LibraryAndLogsView() {
  const [sessions, setSessions] = useState<ExternalAgentSession[]>([])
  const [selected, setSelected] = useState<ExternalAgentSession>()
  const [messages, setMessages] = useState<ExternalAgentMessage[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [project, setProject] = useState('default')
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [directory, setDirectory] = useState('')
  const [defaults, setDefaults] = useState(true)
  const [loading, setLoading] = useState(true)
  const [moreSessions, setMoreSessions] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const attached = useWorkbench(state => state.attachLogToWorkbench)
  const title = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    title.current?.focus()
    let active = true
    Promise.all([api().list(0), window.workbench.notes.projects()]).then(([items, allProjects]) => {
      if (!active) return
      setSessions(items)
      setMoreSessions(items.length === pageSize)
      setProjects(allProjects.filter(item => item.archivedAt === null))
    }).catch(cause => { if (active) setError(issue(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function perform(action: () => Promise<void>) {
    setLoading(true)
    setError('')
    setStatus('')
    try { await action() }
    catch (cause) { setError(issue(cause)) }
    finally { setLoading(false) }
  }

  async function load(term: string, offset = 0) {
    const items = await (term ? api().search(term, offset) : api().list(offset))
    setSearched(term)
    setMoreSessions(items.length === pageSize)
    setSessions(current => offset ? [...current, ...items] : items)
  }

  function scan(event: FormEvent) {
    event.preventDefault()
    void perform(async () => {
      const result = await api().scan({ includeDefaults: defaults, customDirectory: directory.trim() || undefined })
      await load('')
      setQuery('')
      setSelected(undefined)
      setMessages([])
      setStatus(`扫描 ${result.scannedFiles} 个文件，更新 ${result.updatedSessions} 个会话，导入 ${result.newMessages} 条消息`
        + (result.skippedPaths ? `，跳过 ${result.skippedPaths} 个路径。` : '。'))
    })
  }

  function select(session: ExternalAgentSession) {
    void perform(async () => {
      const items = await api().messages(session.id, 0)
      setSelected(session)
      setMessages(items)
    })
  }

  return <section className="s10-content s10-logs" aria-labelledby="s10-logs-title">
    <h1 id="s10-logs-title" tabIndex={-1} ref={title}>本机 Agent 记录</h1>
    <form onSubmit={scan} className="s10-actions">
      <label><input type="checkbox" checked={defaults} onChange={event => setDefaults(event.target.checked)}/>
        扫描 Claude Code 和 Codex 默认目录
      </label>
      <label>自定义目录 <input type="text" value={directory} onChange={event => setDirectory(event.target.value)}/></label>
      <button type="submit" disabled={loading}>扫描记录</button>
    </form>
    <form className="s10-actions" onSubmit={event => {
      event.preventDefault()
      void perform(async () => {
        await load(query.trim())
        setSelected(undefined)
        setMessages([])
      })
    }}>
      <label>搜索消息 <input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button type="submit" disabled={loading}>搜索会话</button>
    </form>
    <p role="status">{loading ? '处理中…' : status}</p>
    {error && <p role="alert" className="s10-error">{error}</p>}
    <div className="s10-settings-grid" aria-busy={loading}>
      <aside aria-label="会话列表">
        {!loading && sessions.length === 0 && <p>{searched ? '没有匹配会话。' : '没有已索引会话。'}</p>}
        <ul className="s10-provider-list">
          {sessions.map(item => <li key={item.id}><button type="button" disabled={loading}
            aria-pressed={selected?.id === item.id} onClick={() => select(item)}>
            <strong>{item.title}</strong>
            <span>{tools[item.sourceTool]} · {item.messageCount} 条</span>
          </button></li>)}
        </ul>
        {moreSessions && <button type="button" disabled={loading}
          onClick={() => void perform(() => load(searched, sessions.length))}>更多会话</button>}
      </aside>
      {selected && <article className="s10-log-entry">
        <h2>{selected.title}</h2>
        <details><summary>查看本机来源</summary><p>{selected.sourcePath}</p>
          {selected.workspaceCwd && <p>{selected.workspaceCwd}</p>}
        </details>
        <pre className="s10-log-summary">{selected.summary}</pre>
        <div className="s10-actions">
          <button type="button" onClick={() => attached(selected)}>引用到工作台</button>
          <label>写入分区 <select value={project} onChange={event => setProject(event.target.value)}>
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <button type="button" disabled={loading || !project} onClick={() => void perform(async () => {
            await api().sendToHippocampus(selected.id, project)
            setStatus('会话摘要已送入海马体。')
          })}>送入海马体</button>
        </div>
        <ol className="s10-log-messages">
          {messages.map(message => <li key={message.id}>
            <header><strong>{message.toolName || roles[message.role]}</strong>
              <time dateTime={new Date(message.createdAt).toISOString()}>{localTime(message.createdAt)}</time>
            </header>
            <pre>{message.content}</pre>
            {message.touchedFiles.map(path => <p key={path}><code>{path}</code></p>)}
          </li>)}
        </ol>
        {messages.length < selected.messageCount && <button type="button" disabled={loading}
          onClick={() => void perform(async () => {
            const more = await api().messages(selected.id, messages.length)
            setMessages(current => [...current, ...more])
          })}>更多消息</button>}
      </article>}
    </div>
  </section>
}
