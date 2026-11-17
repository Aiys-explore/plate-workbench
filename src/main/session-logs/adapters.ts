import { createHash } from 'node:crypto'
import type { ObservedNumber, SessionAdapter, Usage } from '../../shared/sessions'
import type { Quota } from '../../shared/usage'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const str = (v: unknown) => typeof v === 'string' && v.length > 0 ? v : undefined
const atom = (v: unknown) => (typeof v === 'string' && /^[\w:./@+ -]{1,256}$/.test(v)) ? v : undefined
const id = (v: unknown) => (typeof v === 'string' && /^[\w:.|+/-]{1,256}$/.test(v)) ? v : Number.isSafeInteger(v) ? String(v) : undefined
const path = (v: unknown) => typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f]/.test(v) ? v : undefined
const n = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : undefined
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v :
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null
export const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export const adapterVersion = { codex: 'codex-rollout/5', deepseek: 'dsh-v4/4', zcode: 'zcode-sqlite/1' } as const
export type Kind = 'session' | 'context' | 'message' | 'turn-start' | 'turn-end' | 'turn-abort' |
  'tool-start' | 'tool-end' | 'approval' | 'question' | 'answer' | 'error' | 'exit' | 'archive' | 'usage' | 'quota' | 'model-start' | 'model-stop'
export type UsageMode = 'codex-total' | 'codex-response' | 'dsh-response' | 'zcode-response'
export interface Event {
  key: string; kind: Kind; at: number | null; sourceType: string; sequence?: number
  turn?: string; call?: string; tool?: string; role?: 'user' | 'assistant'
  messageId?: string; text?: string; outcome?: 'ok' | 'failed' | 'aborted'; waitId?: string
  cwd?: string; project?: string; parentId?: string; model?: string; version?: string; provider?: string
  usage?: Usage; usageMode?: UsageMode; externalId?: string; rootTurn?: string; actorId?: string
  lastUsage?: Usage; quota?: Quota[]; ownHistory?: boolean; completedTurn?: string
  contextWindow?: ObservedNumber; recentContext?: ObservedNumber; effort?: string
}
export interface Context { sessionId?: string; turn?: string; model?: string; provider?: string; historyStart?: number }
export const initialContext = (): Context => ({})
const usageFields = ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning', 'total'] as const
function tokens(raw: unknown, names: readonly string[]): Usage | undefined {
  const v = obj(raw), result: Usage = {}
  usageFields.forEach((k, i) => { const amount = n(v[names[i]]); if (amount !== undefined) result[k] = amount })
  return Object.keys(result).length ? result : undefined
}
const codexUsage = (v: unknown) => tokens(v, ['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','total_tokens'])
const dshUsage = (v: unknown) => tokens(v, ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'])
function codexQuota(raw: unknown, at: number, source: string): Quota[] {
  const r = obj(raw), scope = atom(r.limit_id)
  if (!scope) return []
  const result: Quota[] = []
  for (const slot of ['primary','secondary'] as const) {
    const w = obj(r[slot]), used = w.used_percent, reset = n(w.resets_at)
    const windowMinutes = n(w.window_minutes) || null
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0)
      result.push({source:source+':rate_limits.'+slot,at,scope,slot,unit:'%',limit:100,used,
        windowMinutes,resetAt:reset && reset < 100_000_000_000 ? reset*1000 : null,balance:null})
  }
  const credits = obj(r.credits)
  if (typeof credits.balance === 'string' && /^\d{1,30}(?:\.\d{1,15})?$/.test(credits.balance) && credits.unlimited === false)
    result.push({source:source+':rate_limits.credits.balance',at,scope,slot:'credits',unit:'Codex credits',limit:null,
      used:null,windowMinutes:null,resetAt:null,balance:credits.balance})
  return result
}
const project = (cwd: string | undefined) => cwd?.split(/[\\/]/).filter(Boolean).at(-1)
const messageText = (v: unknown) => {
  // The scanner bounds the entire source row to 1 MiB and diagnoses larger rows.
  if (typeof v === 'string') return str(v)
  if (!Array.isArray(v)) return undefined
  return v.map((x: unknown) => {
    const o = obj(x); return ['input_text','output_text','text','Text'].includes(String(o.type)) ? str(o.text) ?? '' : ''
  }).filter(Boolean).join('\n') || undefined
}
const hasUserMetadata = (v: unknown) => ['user', 'assistant'].includes(String(v))
export function normalize(adapter: Exclude<SessionAdapter,'zcode'>, row: unknown, previous: Context, lineHash: string): { context: Context; events: Event[] } {
  const x = obj(row), p = obj(x.payload), d = obj(x.data), message = obj(d.message), item = obj(p.item)
  const outer = str(x.type) ?? ''
  const inner = str(p.type)
  const sourceType = adapter === 'codex' && inner ? outer + '/' + inner : outer
  const sequence = n(adapter === 'codex' ? x.ordinal : x.seq)
  const at = time(adapter === 'codex' ? x.timestamp : x.time ?? x.createdAt)
  const context = { ...previous }
  const events: Event[] = []
  const result = { context, events }
  const observed = (v: unknown, field: string) => {
    const value = n(v); return value === undefined ? undefined : { value, source: sourceType + ':' + field, at }
  }
  const emit = (kind: Kind, fields: Partial<Event> = {}, key?: string) => {
    if (!context.sessionId) return
    events.push({ key: key ?? kind + ':' + (sequence !== undefined ? 'seq:' + sequence : lineHash),
      kind, at, sourceType, sequence, turn: context.turn, model: context.model, provider: context.provider, ...fields })
  }
  const sendMessage = (role: 'user'|'assistant', content: unknown, mid?: string) => {
    const text = messageText(content)
    // Modern Codex emits the same user message in two streams with unrelated IDs.
    const mirroredUser = adapter === 'codex' && role === 'user' && context.turn && text
    const key = mirroredUser ? 'message:user:' + context.turn + ':' + digest(text) : mid ? 'message:' + role + ':' + mid : undefined
    if (text || mid) emit('message', { role, messageId: mid, text }, key)
  }
  const toolStart = (call: string | undefined, tool?: string) => { if (call) emit('tool-start', { call, tool }, 'tool-start:' + call) }
  const toolEnd = (call: string | undefined, outcome?: Event['outcome'], tool?: string) => {
    if (call) emit('tool-end', { call, outcome, tool }, 'tool-end:' + call)
  }
  if (adapter === 'codex') {
    if (outer === 'session_meta') {
      const sid = id(p.session_id ?? p.id)
      if (!sid) return result
      Object.assign(context, { sessionId: sid, turn: undefined, model: atom(p.model),
        provider: atom(p.model_provider), historyStart: n(p.subagent_history_start_ordinal) })
      const cwd = path(p.cwd), parentId = id(p.parent_thread_id ?? obj(obj(p.source).subagent).parent_thread_id ??
        obj(obj(obj(p.source).subagent).thread_spawn).parent_thread_id)
      emit('session', { cwd, project: project(cwd), parentId, version: atom(p.cli_version),
        contextWindow: observed(p.context_window,'context_window') }, 'session')
      return result
    }
    if (!context.sessionId || (sequence !== undefined && context.historyStart !== undefined && sequence < context.historyStart)) return result
    const t = id(p.turn_id)
    if (t && ['turn_context','token_usage_record','event_msg'].includes(outer)) context.turn = t
    const rootTurn = id(p.root_turn_id)
    if (outer === 'turn_context') {
      context.model = atom(p.model) ?? context.model
      const cwd = path(p.cwd)
      emit('context', { cwd, project: project(cwd), rootTurn, effort: atom(p.effort) })
    } else if (outer === 'token_usage_record') {
      const usage = codexUsage(p.usage), externalId = id(p.response_id), actorId = id(p.thread_id)
      if (!actorId || actorId === context.sessionId) emit('usage', { usage, usageMode: 'codex-response', externalId, rootTurn, actorId,
        ownHistory: sequence !== undefined && context.historyStart !== undefined && sequence >= context.historyStart },
        externalId ? 'usage:response:' + externalId : undefined)
    } else if (outer === 'response_item') {
      const call = id(p.call_id ?? p.id)
      if (inner === 'message' && hasUserMetadata(p.role)) sendMessage(p.role as 'user'|'assistant', p.content, id(p.id))
      if (inner === 'function_call' || inner === 'custom_tool_call') toolStart(call, atom(p.name))
      if (inner === 'function_call_output' || inner === 'custom_tool_call_output') {
        const success = obj(p.output).success
        toolEnd(call, success === false ? 'failed' : success === true ? 'ok' : undefined)
      }
      if (inner === 'web_search_call' && p.status === 'in_progress') toolStart(call, 'web_search')
      if (inner === 'web_search_call' && p.status === 'completed') toolEnd(call, 'ok', 'web_search')
    } else if (outer === 'event_msg') {
      const call = id(p.call_id ?? p.item_id)
      const request = id(p.request_id ?? p.approval_id ?? p.call_id ?? p.item_id)
      switch (inner) {
        case 'task_started': case 'turn_started': emit('turn-start', { rootTurn,
          contextWindow: observed(p.model_context_window,'model_context_window') }, t ? 'turn-start:' + t : undefined); break
        case 'task_complete': case 'turn_completed': emit('turn-end', { rootTurn, completedTurn:t ?? context.turn }, t ? 'turn-end:' + t : undefined); context.turn = undefined; break
        case 'turn_aborted': emit('turn-abort', { rootTurn, outcome: 'aborted' }, t ? 'turn-abort:' + t : undefined); context.turn = undefined; break
        case 'exec_command_begin': case 'mcp_tool_call_begin': case 'patch_apply_begin':
          toolStart(call, inner); break
        case 'exec_command_end': case 'mcp_tool_call_end': case 'patch_apply_end':
          toolEnd(call, p.success === false || (typeof p.exit_code === 'number' && p.exit_code !== 0) ? 'failed' :
            p.success === true || p.exit_code === 0 ? 'ok' : undefined, inner); break
        case 'item_started':
          if (item.type === 'CommandExecution') toolStart(id(item.id), 'command_execution')
          break
        case 'item_completed':
          if (item.type === 'UserMessage' || item.type === 'AgentMessage') sendMessage(item.type === 'UserMessage' ? 'user' : 'assistant', item.content, id(item.id))
          if (item.type === 'CommandExecution') toolEnd(id(item.id), typeof item.exit_code === 'number' ?
            item.exit_code === 0 ? 'ok' : 'failed' : undefined, 'command_execution')
          break
        case 'exec_approval_request': case 'apply_patch_approval_request': case 'request_permissions':
          emit('approval', { waitId: request }); break
        case 'request_user_input': emit('question', { waitId: request }); break
        case 'approval_response': case 'user_input_response': emit('answer', { waitId: request }); break
        case 'error': emit('error'); break
        case 'shutdown_complete': case 'session_exit': emit('exit'); break
        case 'token_count': {
          const info = obj(p.info), usage = codexUsage(info.total_token_usage)
          const contextWindow = observed(info.model_context_window,'info.model_context_window')
          const recentContext = observed(obj(info.last_token_usage).total_tokens,'info.last_token_usage.total_tokens')
          if (usage || contextWindow || recentContext) emit('usage', { usage, usageMode: 'codex-total', contextWindow, recentContext,
            lastUsage:codexUsage(info.last_token_usage) })
          const quota = at === null ? [] : codexQuota(p.rate_limits,at,sourceType)
          if (quota.length) emit('quota', {quota})
          break
        }
      }
    }
  } else {
    if (outer === 'session' && x.version === 4) {
      const sid = id(x.id)
      if (!sid) return result
      Object.assign(context, { sessionId: sid, turn: undefined, model: undefined, provider: undefined })
      const cwd = path(x.cwd)
      emit('session', { cwd, project: project(cwd), parentId: id(x.parentSession), version: '4' }, 'session')
      return result
    }
    if (!context.sessionId) return result
    const t = id(d.turn)
    if (t) context.turn = t
    switch (outer) {
      case 'request/context': case 'subagent/descriptor':
        context.model = atom(d.model ?? d.agentModel) ?? context.model
        context.provider = atom(d.agentProvider ?? d.provider) ?? context.provider
        emit('context', { contextWindow: observed(d.contextWindow,'data.contextWindow'), effort: atom(d.agentReasoningEffort) }); break
      case 'working-directory/change': { const cwd = path(d.cwd); emit('context', { cwd, project: project(cwd) }); break }
      case 'user/message': { const v = message.role === 'user' ? message : d; sendMessage('user', v.content, id(v.id)); break }
      case 'assistant/message': {
        sendMessage('assistant', message.content, id(message.id))
        const usage = dshUsage(d.usage), mid = id(message.id)
        emit('usage', { usage, usageMode: 'dsh-response', externalId: mid }, mid ? 'usage:message:' + mid : undefined)
        break
      }
      case 'turn/start': emit('turn-start', {}, t ? 'turn-start:' + t : undefined); break
      case 'turn/end': {
        const reason = obj(d.reason).kind
        if (reason === 'completed') emit('turn-end', {completedTurn:t ?? context.turn}, t ? 'turn-end:' + t : undefined)
        else if (['error','failed'].includes(String(reason))) emit('error')
        else emit('turn-abort', { outcome: 'aborted' })
        context.turn = undefined
        break
      }
      case 'tool/call': toolStart(id(d.callId), atom(d.name)); break
      case 'tool/result': toolEnd(id(message.toolCallId ?? d.callId), message.isError === true ? 'failed' : message.isError === false ? 'ok' : undefined); break
      case 'approval/asked': case 'approval/request':
        emit('approval', { waitId: id(d.id ?? d.requestId ?? d.callId), tool: atom(d.toolName) }); break
      case 'question/request': emit('question', { waitId: id(d.requestId) }); break
      case 'approval/decided': case 'approval/response': case 'question/response':
        emit('answer', { waitId: id(d.id ?? d.requestId ?? d.callId) }); break
      case 'session/error': case 'turn/error': emit('error'); break
      case 'session/exit': emit('exit'); break
    }
  }
  return result
}
