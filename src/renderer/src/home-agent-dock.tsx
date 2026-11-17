import type { ProviderCandidate } from '../../shared/plate-terminal/contract'
import type { SessionStatus, SessionSummary } from '../../shared/sessions'
import type { TerminalActivity } from './plate-terminal/terminal-panel'
import { clearPlateDrag, consumePlateDrag, handoff, isPlateDrag, startPlateDrag, type Destination } from './home-handoff'

const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', deepseek: 'DeepSeek', 'deepseek-harness': 'DeepSeek Harness', zcode: 'ZCode' }
const logState: Record<SessionStatus, string> = { UNKNOWN: '状态未知', PAUSED: '已暂停', STARTING: '启动中',
  DOING: '执行中', PENDING: '等待中', REVIEW: '待检查', ERROR: '异常', DONE: '会话已结束' }

export function HomeAgentDock({ slots, available, sessions, open, show, manage }: {
  slots: TerminalActivity[]; available: readonly ProviderCandidate[]; sessions: SessionSummary[]
  open: (target: Destination) => void; show: (session: SessionSummary) => void; manage: () => void
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
  const row = (agent: string, label: string, status: string, target: Destination, live: boolean) =>
    <button type="button" className="home-agent-target" draggable
      title={agent + ' · ' + label + ' · ' + status}
      data-agent-target={target.kind === 'slot' ? 'slot-' + target.id : target.flavor}
      onClick={() => open(target)}
      onDragStart={event => startPlateDrag(event.dataTransfer, { target })} onDragEnd={clearPlateDrag}
      onDragOver={event => {
        if (isPlateDrag(event.dataTransfer, 'material')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
      }} onDrop={event => {
        const item = consumePlateDrag(event.dataTransfer)
        if (!item || !('material' in item)) return
        event.preventDefault()
        handoff(item.material, target)
      }}>
      {line(agent,label,status,live)}
    </button>
  return <section className="home-agent-dock" aria-label="Agent 活动">
    <header><h2>Agent 活动</h2>{slots.some(slot => !slot.exited) && <small>{slots.filter(slot => !slot.exited).length} 个运行中</small>}</header>
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
      {slots.some(slot => !slot.exited) && <section className="plate-dock-group"><h3>Plate 终端</h3>
      {slots.filter(slot => !slot.exited).map(slot => <div key={slot.id}>
        {row(names[slot.flavor] ?? slot.flavor, slot.label + ' · #' + slot.id, '运行中', { kind: 'slot', id: slot.id }, true)}</div>)}
      </section>}
      {available.length > 0 && <section className="plate-dock-group"><h3>本机可打开</h3>
      {available.map(runtime => <div key={runtime.flavor}>
        {row(runtime.displayName, runtime.status === 'desktop' ? '打开或复制任务' : '新开终端', '可打开',
          runtime.status === 'desktop' ? { kind: 'desktop', flavor: 'zcode' } : { kind: 'runtime', flavor: runtime.flavor }, false)}</div>)}
      </section>}
      {!sessions.length && !slots.some(slot => !slot.exited) && !available.length &&
        <div className="plate-dock-empty"><p>暂无活动。安装连接器后，可从笔记交接任务。</p><button type="button" onClick={manage}>发现连接器</button></div>}
    </div>
  </section>
}
