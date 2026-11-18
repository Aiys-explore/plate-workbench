import type { SessionStatus, SessionSummary } from '../../shared/sessions'

const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', deepseek: 'DeepSeek', 'deepseek-harness': 'DeepSeek Harness', zcode: 'ZCode' }
const logState: Record<SessionStatus, string> = { UNKNOWN: '状态未知', PAUSED: '已暂停', STARTING: '启动中',
  DOING: '执行中', PENDING: '等待中', REVIEW: '待检查', ERROR: '异常', DONE: '会话已结束' }

export function HomeAgentDock({ sessions, show, manage }: {
  sessions: SessionSummary[]; show: (session: SessionSummary) => void; manage: () => void
}) {
  const workspaces = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const workspace = session.cwd || session.project || '工作区未知'
    const list = workspaces.get(workspace)
    if (list) list.push(session)
    else workspaces.set(workspace, [session])
  }
  // 同名会话：短 ID 前 8 位相同时，追加后续位直到可区分，并放宽行高。
  const prefixCounts = new Map<string, number>()
  for (const session of sessions) {
    const prefix = session.id.slice(0, 8)
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
  }
  const sessionShortId = (id: string) => {
    if (id.length <= 8) return id
    if ((prefixCounts.get(id.slice(0, 8)) ?? 0) <= 1) return id.slice(0, 8)
    // 前 8 位撞车时逐位延长，直到该前缀唯一。
    for (let length = 9; length <= id.length; length++) {
      const candidate = id.slice(0, length)
      const unique = sessions.filter(other => other.id.startsWith(candidate)).length === 1
      if (unique) return candidate
    }
    return id
  }
  const line = (agent: string, label: string, status: string, live: boolean, id?: string) => <>
    <span className="home-runtime-icon" aria-hidden="true">{agent.slice(0,1)}</span>
    <span className="plate-dock-label"><strong>{agent}</strong><small><span>{label}</span>{id && <code>#{id}</code>}</small></span>
    <small className="plate-dock-state" data-live={live}>{status}</small>
  </>
  return <section className="home-agent-dock" aria-label="Agent 活动">
    <header><h2>Agent 活动</h2></header>
    <div className="home-agent-dock-scroll">
      {Array.from(workspaces, ([workspace, logs]) => <section className="plate-dock-group" key={workspace}>
        <h3 title={workspace}>{workspace.split(/[\\/]/).filter(Boolean).at(-1) || workspace}</h3>
        {logs.map(session => {
          const sameName = (prefixCounts.get(session.id.slice(0, 8)) ?? 0) > 1
          const displayId = sessionShortId(session.id)
          return <button type="button" className="home-agent-target plate-log-row"
          key={session.adapter + ':' + session.id} onClick={() => show(session)}
          data-same-name={sameName ? 'true' : undefined}
          title={[names[session.adapter], session.project, workspace, session.id, logState[session.status], '来源：会话日志'].filter(Boolean).join(' · ')}
          aria-label={`${names[session.adapter]} · ${session.project || '会话'} · ${workspace} · ${displayId} · ${logState[session.status]}`}>
          {line(names[session.adapter], session.project || '会话', logState[session.status], session.status === 'DOING', displayId)}
        </button>
        })}
      </section>)}
      {!sessions.length &&
        <div className="plate-dock-empty"><p>暂无活动。安装连接器后，可从笔记交接任务。</p><button type="button" onClick={manage}>发现连接器</button></div>}
    </div>
  </section>
}
