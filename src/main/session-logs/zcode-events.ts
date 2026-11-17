import type { Usage } from '../../shared/sessions'
import { digest, type Event, type Kind } from './adapters'

export type Row = Record<string, unknown>
export type TextPart = { message: string; text: string }
export const id = (v: unknown) => typeof v === 'string' && /^[\w:.|+/-]{1,256}$/.test(v) ? v : undefined
const label = (v: unknown) => typeof v === 'string' && /^[\w:./@+ -]{1,256}$/.test(v) ? v : undefined
export const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
export const time = (v: unknown) => integer(v) && (v as number) <= 8.64e15 ? v as number : null
const cwd = (v: unknown) => typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f]/.test(v) &&
  /^(?:[A-Za-z]:[/\\]|[/\\]{2}|\/)/.test(v) ? v : undefined
const event = (table: string, kind: Kind, key: string, at: number | null, fields: Partial<Event> = {}): Event =>
  ({ key: kind + ':' + digest(key), kind, at, sourceType: 'sqlite/' + table, ...fields })

export function runtimeTurnStart(raw: unknown): { sid:string; event:Event } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Row, sid = id(r.sessionId), turn = id(r.turnId)
  if (r.event !== 'turn.started' || r.status !== 'started' || !sid || !turn ||
    typeof r.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(r.timestamp)) return undefined
  const at = time(Date.parse(r.timestamp))
  if (at === null) return undefined
  return {sid,event:event('turn_usage.started_at','turn-start',turn,at,{turn,sourceType:'jsonl/turn.started'})}
}

export function sessionEvents(r: Row): Event[] {
  const sid = id(r.id)
  if (!sid) return []
  const directory = cwd(r.directory), archived = time(r.time_archived)
  const out = [event('session', 'session', sid, time(r.time_created), {
    cwd: directory, project: directory?.split(/[/\\]/).filter(Boolean).at(-1),
    parentId: id(r.parent_id), version: label(r.version)
  })]
  if (archived !== null) out.push(event('session.time_archived', 'archive', sid, archived))
  return out
}
export function messageEvent(r: Row, parts: readonly string[]): Event | undefined {
  const mid = id(r.id)
  if (!mid || (r.role !== 'user' && r.role !== 'assistant')) return undefined
  const text = parts.join('\n')
  if (!text) return undefined
  return event('message+part.text', 'message', mid, time(r.time_created), {
    role: r.role, messageId: mid, text, sequence: integer(r.sequence)
  })
}
export function stepStart(r: Row): Event | undefined {
  const pid = id(r.id), at = time(r.time_created)
  return pid && at !== null ? event('part.step-start', 'model-start', pid, at) : undefined
}
export function modelStop(r: Row): Event | undefined {
  const mid = id(r.id), at = time(r.model_completed)
  return mid && r.role === 'assistant' && at !== null && at >= (time(r.time_created) ?? at)
    ? event('message.time.completed','model-stop',mid,at) : undefined
}
export function modelSelection(r: Row): Event | undefined {
  const key = id(r.id), at = time(r.time_created), model = label(r.model)
  return key && at !== null && model ? event('session_entry.model_selection','context',key,at,
    { model, provider:label(r.provider), effort:label(r.effort) }) : undefined
}
export function turnEvents(r: Row): Event[] {
  const turn = id(r.turn_id), start = time(r.started_at), end = time(r.completed_at)
  if (!turn || start === null) return []
  const out = [event('turn_usage.started_at','turn-start',turn,start,{turn})]
  if (end === null || end < start) return out
  if (r.status === 'completed') out.push(event('turn_usage.completed','turn-end',turn,end,{turn,completedTurn:turn}))
  if (r.status === 'cancelled') out.push(event('turn_usage.cancelled','turn-abort',turn,end,{turn}))
  if (r.status === 'error') out.push(event('turn_usage.error','error',turn,end,{turn}))
  return out
}
export function toolEvents(r: Row, table: 'tool_usage' | 'part.tool'): Event[] {
  const call = id(r.tool_call_id), start = time(r.started_at), end = time(r.completed_at)
  if (!call || start === null) return []
  const fields = {call, tool:label(r.tool_name), turn:id(r.turn_id)}
  const out = [event(table,'tool-start',call,start,fields)]
  if (end !== null && end >= start && ['completed','error','cancelled'].includes(String(r.status)))
    out.push(event(table,'tool-end',call,end,{...fields,outcome:r.status === 'error' ? 'failed' : r.status === 'cancelled' ? 'aborted' : 'ok'}))
  return out
}
const usageColumns = {
  input:'input_tokens', output:'output_tokens', cachedInput:'cache_read_input_tokens',
  cacheWrite:'cache_creation_input_tokens', reasoning:'reasoning_tokens', total:'provider_total_tokens'
} as const
export function usageEvent(r: Row, sid: string): Event | undefined {
  const logical = id(r.logical_request_id), attempt = integer(r.attempt_index), at = time(r.completed_at)
  if (!logical || attempt === undefined || at === null) return undefined
  const stable = JSON.stringify([logical,attempt])
  const usage: Usage = {}
  // Error/cancelled attempts have placeholder component zeros and no provider total
  // in the observed database. Keep the attempt as missing coverage in that case.
  if (r.status === 'completed' || integer(r.provider_total_tokens) !== undefined)
    for (const [k, col] of Object.entries(usageColumns)) {
      const v = integer(r[col])
      if (v !== undefined) usage[k as keyof Usage] = v
    }
  return event('model_usage','usage',stable,at,{
    externalId:stable, actorId:sid, ownHistory:true, model:label(r.model_id), provider:label(r.provider_id),
    effort:label(r.variant), turn:id(r.turn_id), usageMode:'zcode-response',
    usage:Object.keys(usage).length ? usage : undefined
  })
}
