import type { ContextOccupancy, ObservedNumber, SessionStatus, Usage } from '../../shared/sessions'
import type { Event } from './adapters'

export interface Projection {
  cwd: string | null; project: string | null; parentId: string | null; model: string | null
  status: SessionStatus; reason: string; lastAt: number | null; lastKind: string | null; activeAt: number | null
  turn: string | null; calls: string[]; waits: string[]; eventCount: number; messageCount: number
  toolCount: number; turnCount: number; usage: Usage; usageBasis: string | null
  codexTotal: Usage; codexResponses: Usage; dshResponses: Usage; zcodeResponses: Usage
  contextWindow: ObservedNumber | null; recentContext: ObservedNumber | null
  contextOccupancy: ContextOccupancy | null; effort: string | null; step: string | null
  turnStartedAt: number | null; turnStoppedAt: number | null
  toolNames: Record<string, string>
}
export const empty = (): Projection => ({
  cwd: null, project: null, parentId: null, model: null, status: 'UNKNOWN', reason: '没有足够的活动证据',
  lastAt: null, lastKind: null, activeAt: null, turn: null, calls: [], waits: [],
  eventCount: 0, messageCount: 0, toolCount: 0, turnCount: 0, usage: {}, usageBasis: null,
  codexTotal: {}, codexResponses: {}, dshResponses: {}, zcodeResponses: {}, contextWindow: null, recentContext: null,
  contextOccupancy: null, effort: null, step: null, turnStartedAt: null, turnStoppedAt: null, toolNames: {}
})
function add(a: Usage, b: Usage): Usage {
  const v = { ...a }
  for (const key of Object.keys(b) as (keyof Usage)[]) v[key] = (a[key] ?? 0) + (b[key] ?? 0)
  return v
}
export function reduce(state: Projection, e: Event): Projection {
  if (e.kind === 'quota') return { ...state, eventCount: state.eventCount + 1 }
  const s = { ...state, eventCount: state.eventCount + 1 }
  s.cwd = e.cwd ?? s.cwd
  s.project = e.project ?? s.project
  s.parentId = e.parentId ?? s.parentId
  s.model = e.model ?? s.model
  if (e.kind === 'turn-start' || (state.model && s.model !== state.model)) {
    if (state.model && s.model !== state.model) { s.contextWindow = null; s.effort = null }
    s.recentContext = null; s.contextOccupancy = null
    if (e.kind === 'turn-start' && s.contextWindow?.source.startsWith('event_msg/')) s.contextWindow = null
  }
  s.effort = e.effort ?? s.effort
  // A request snapshot and a window size do not establish current occupancy.
  if (e.contextWindow || e.recentContext) s.contextOccupancy = null
  if (e.contextWindow && !e.recentContext) s.recentContext = null
  s.contextWindow = e.contextWindow ?? s.contextWindow
  s.recentContext = e.recentContext ?? s.recentContext
  if (e.at !== null && (s.lastAt === null || e.at >= s.lastAt)) {
    s.lastAt = e.at
    s.lastKind = e.kind
  }
  if (s.status === 'DOING' && e.at !== null && ['message','usage','tool-end'].includes(e.kind)) {
    s.activeAt = Math.max(s.activeAt ?? 0, e.at)
  }
  if (e.kind === 'usage' && e.usage) {
    // Codex reports cumulative snapshots alongside per-response usage. Never sum the two.
    if (e.usageMode === 'codex-total') s.codexTotal = { ...s.codexTotal, ...e.usage }
    if (e.usageMode === 'codex-response') s.codexResponses = add(s.codexResponses, e.usage)
    if (e.usageMode === 'dsh-response') s.dshResponses = add(s.dshResponses, e.usage)
    if (e.usageMode === 'zcode-response') s.zcodeResponses = add(s.zcodeResponses ?? {}, e.usage)
    if (Object.keys(s.codexTotal).length) {
      s.usage = s.codexTotal; s.usageBasis = 'codex-thread-cumulative'
    } else if (Object.keys(s.codexResponses).length) {
      s.usage = s.codexResponses; s.usageBasis = 'codex-own-responses'
    } else if (Object.keys(s.dshResponses).length) {
      s.usage = s.dshResponses; s.usageBasis = 'deepseek-assistant-responses'
    } else if (s.zcodeResponses && Object.keys(s.zcodeResponses).length) {
      s.usage = s.zcodeResponses; s.usageBasis = 'ZCode · 已记录的逐请求 Token 合计'
    }
  }
  if (e.kind === 'message') s.messageCount++
  const set = (status: SessionStatus, reason: string) => { s.status = status; s.reason = reason }
  const clear = () => { s.turn = null; s.calls = []; s.waits = []; s.toolNames = {} }
  const stop = () => { s.turnStoppedAt = e.at ?? s.lastAt }
  switch (e.kind) {
    case 'turn-start':
      clear(); s.turn = e.turn ?? ''; s.activeAt = e.at; s.turnStartedAt = e.at; s.turnStoppedAt = null
      s.step = '轮次已开始'; set('DOING', '观察到轮次开始'); break
    case 'model-start':
      if (s.turn === null) s.turnStartedAt = null
      s.activeAt = e.at ?? s.activeAt
      if (!s.waits.length && !s.calls.length) {
        s.turnStoppedAt = null; s.step = '模型请求中'; set('DOING', '观察到模型步骤开始')
      }
      break
    case 'model-stop':
      if (s.status === 'DOING' && s.turn === null && !s.calls.length) {
        stop(); s.step = null; set('PAUSED', '模型步骤已返回，未观察到本轮结束')
      }
      break
    case 'tool-start': {
      const call = e.call ?? e.key
      s.calls = [...s.calls.filter(x => x !== e.call), e.call ?? e.key]
      s.toolNames = { ...s.toolNames, [call]: e.tool ?? '未命名工具' }
      s.activeAt = e.at ?? s.activeAt
      if (!s.waits.length) {
        if (s.turn === null && s.status !== 'DOING') s.turnStartedAt = null
        s.turnStoppedAt = null; s.step = '工具 · ' + s.toolNames[call]; set('DOING', '工具已开始')
      }
      break
    }
    case 'tool-end': {
      if (e.tool !== 'command_execution' || s.calls.includes(e.call ?? '')) s.toolCount++
      else if (!s.toolCount) s.toolCount++ // older logs may expose only the completed item
      s.calls = s.calls.filter(x => x !== e.call)
      const tool = e.call ? s.toolNames?.[e.call] : undefined
      if (e.call) { s.toolNames = { ...s.toolNames }; delete s.toolNames[e.call] }
      if (!s.waits.length) {
        const next = s.calls.at(-1)
        if (e.outcome === 'failed') { stop(); s.step = tool ? '工具出错 · ' + tool : '工具出错'; set('ERROR', '工具返回错误') }
        else {
          if (s.status === 'ERROR' && s.turn !== null) { s.turnStoppedAt = null; set('DOING', '观察到工具继续执行') }
          if (s.status === 'DOING') s.step = next ? '工具 · ' + (s.toolNames[next] ?? '未命名工具') : '工具已返回，等待本轮结束'
        }
      }
      break
    }
    case 'message':
      if (s.status === 'DOING' && !s.calls.length && e.role === 'assistant' && e.text) s.step = '回复中'
      break
    case 'approval': case 'question':
      s.waits = [...new Set([...s.waits, e.waitId ?? e.key])]
      s.step = e.kind === 'approval' ? '等待审批' + (e.tool ? ' · ' + e.tool : '') : '等待回答'
      set('PENDING', e.kind === 'approval' ? '明确等待审批' : '明确等待回答'); break
    case 'answer':
      s.waits = e.waitId ? s.waits.filter(x => x !== e.waitId) : s.waits.length === 1 ? [] : s.waits
      if (!s.waits.length && s.status === 'PENDING') {
        s.activeAt = e.at ?? s.activeAt
        if (s.turn !== null || s.calls.length) {
          const call = s.calls.at(-1)
          s.step = call ? '工具 · ' + (s.toolNames?.[call] ?? '未命名工具') : '继续本轮'
          set('DOING', '等待已解除，本轮尚未结束')
        } else { stop(); s.step = null; set('PAUSED', '等待已解除，未观察到继续执行') }
      }
      break
    case 'error': clear(); stop(); s.step = null; set('ERROR', '日志报告错误'); break
    case 'turn-end': clear(); stop(); s.step = null; s.turnCount++; set('REVIEW', '本轮已结束，待查看'); break
    case 'turn-abort': clear(); stop(); s.step = null; set('PAUSED', '本轮已中断'); break
    case 'exit':
      clear()
      if (!['REVIEW','ERROR','DONE'].includes(s.status)) { stop(); s.step = null; set('PAUSED', '进程退出，未观察到完成证据') }
      break
    case 'archive': clear(); stop(); s.step = null; set('DONE', '可信归档'); break
  }
  return s
}
export function statusView(s: Projection, archived: boolean, confirmed: boolean, started: number, now: number, threshold: number) {
  if (archived || confirmed) return { status: 'DONE' as const, reason: archived ? '可信归档' : '用户确认', noProgress: false }
  if (s.status === 'DOING' && (s.activeAt === null || s.activeAt < started)) {
    return { status: 'PAUSED' as const, reason: '重启后未观察到当前轮次仍在运行', noProgress: false }
  }
  return { status: s.status, reason: s.reason, noProgress: s.status === 'DOING' && s.lastAt !== null && now - s.lastAt >= threshold }
}
