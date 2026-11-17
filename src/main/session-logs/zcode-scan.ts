import { lstat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { digest, initialContext, type Event } from './adapters'
import type { ScanMetrics } from './scan'
import type { Bad, Batch, Cursor, LocatedEvent, Source } from './store'
import { id, integer, messageEvent, modelSelection, modelStop, sessionEvents, stepStart, time, toolEvents, usageEvent, turnEvents, type Row } from './zcode-events'

const files = async (path: string) => {
  const entries = await Promise.all(['','-wal','-shm','-journal'].map(suffix => lstat(path+suffix,{bigint:true}).catch((e: NodeJS.ErrnoException) => {
    if (suffix && e.code === 'ENOENT') return undefined
    throw e
  })))
  for (const s of entries) if (s && (!s.isFile() || s.isSymbolicLink())) throw new Error('unsafe-sqlite-source')
  const [db,wal,shm,journal] = entries
  if (!db || journal?.size || (wal?.size && !shm)) throw new Error('sqlite-sidecars-unavailable')
  const stamp = (s: typeof db | undefined) => s ? [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':') : ''
  return { identity:[db.dev,db.ino,db.birthtimeNs].join(':'), signature:[stamp(db),stamp(wal)].join('|'),
    immutable: !wal?.size, size:Number(db.size) }
}
const tables = [
  ['message','time_created','time_updated','sequence'],
  ['part','time_created','time_updated','sequence'],
  ['session_entry','time_created','time_updated','time_updated'],
  ['turn_usage','started_at','completed_at','status'],
  ['tool_usage','started_at','completed_at','status'],
  ['model_usage','started_at','completed_at','status']
] as const
// SQLite rows are mutable. Metadata watermarks locate sessions affected by inserts,
// terminal updates, or deletes; only those sessions reload event bodies.
const inventory = (db: DatabaseSync, sessions: Row[]) => {
  const values = new Map<string, unknown[]>()
  for (const s of sessions) {
    const sid = id(s.id)
    if (sid) values.set(sid,[s])
  }
  for (const [table,start,end,extra] of tables) {
    for (const r of db.prepare(`SELECT session_id AS sid,count(*) AS n,min(rowid) AS lo,max(rowid) AS hi,
      min(${start}) AS first,max(${end}) AS last,count(${end}) AS ends,
      CAST(sum(${start}) AS TEXT) AS starts_sum,CAST(sum(${end}) AS TEXT) AS ends_sum,
      CAST(sum(CASE WHEN typeof(${extra})='integer' THEN ${extra}
        WHEN ${extra}='completed' THEN 1 WHEN ${extra}='error' THEN 2
        WHEN ${extra}='cancelled' THEN 3 WHEN ${extra}='running' THEN 4 ELSE 0 END) AS TEXT) AS extra_sum
      FROM ${table} GROUP BY session_id`).iterate() as Iterable<Row>) {
      if (typeof r.sid === 'string') values.get(r.sid)?.push([table,r])
    }
  }
  return Object.fromEntries([...values].map(([sid,rows])=>[sid,digest(JSON.stringify(rows))]))
}
const object = (d: string) => `CASE WHEN json_valid(${d}) THEN ${d} END`
const field = (d: string, key: string) => `json_extract(${object(d)}, '$.${key}')`
const body = field('p.data','text')
const MAX_TEXT = 1024 * 1024
function readSession(db: DatabaseSync, session: Row, sid: string) {
  const events: LocatedEvent[] = [], bad: Bad[] = []
  let rowsRead = 0
  const seen = new Set<string>()
  const emit = (eventsToAdd: (Event | undefined)[], row: Row, table: number, reason?: string) => {
    const offset = (integer(row.rowid) ?? 0)*10 + table
    if (reason) bad.push({offset,space:'decoded',reason})
    for (const e of eventsToAdd) if (e && !seen.has(e.key)) {
      seen.add(e.key)
      events.push({session:sid,offset,frameAt:null,event:e})
    }
  }
  const read = (sql: string) => db.prepare(sql).all(sid).map(r=>{rowsRead++; return r as Row})
  // Forks can copy old rows with new message IDs; the preserved creation time
  // identifies history before the child existed. Tool/usage facts use own IDs.
  const created = time(session.time_created)
  const own = (at: unknown) => !id(session.parent_id) || (created !== null && time(at) !== null && Number(at) >= created)
  emit(sessionEvents(session),session,0)
  const messages = read(`SELECT rowid,id,time_created,sequence,${field('data','role')} AS role,
    ${field('data','time.completed')} AS model_completed,json_valid(data) AS valid FROM message WHERE session_id=? ORDER BY sequence,id`)
  const visible = new Map(messages.filter(m=>own(m.time_created) && (m.role==='user'||m.role==='assistant')).map(m=>[m.id,m]))
  const texts = new Map<unknown, {parts:string[]; bytes:number}>()
  const toolParts: Row[] = []
  for (const p of read(`SELECT p.rowid,p.id,p.message_id,p.time_created,p.sequence,
    json_valid(p.data) AS valid,${field('p.data','type')} AS type,
    CASE WHEN ${field('p.data','type')}='text' AND coalesce(${field('p.data','synthetic')},0)=0
      AND coalesce(${field('p.data','ignored')},0)=0 THEN length(CAST(${body} AS BLOB)) END AS text_bytes,
    CASE WHEN ${field('p.data','type')}='text' AND coalesce(${field('p.data','synthetic')},0)=0
      AND coalesce(${field('p.data','ignored')},0)=0 AND length(CAST(${body} AS BLOB))<=${MAX_TEXT}
      THEN ${body} END AS text,
    ${field('p.data','callID')} AS tool_call_id,${field('p.data','tool')} AS tool_name,
    ${field('p.data','state.status')} AS status,${field('p.data','state.time.start')} AS started_at,
    ${field('p.data','state.time.end')} AS completed_at
    FROM part p WHERE p.session_id=? ORDER BY p.message_id,p.sequence,p.id`)) {
    if (!p.valid) { emit([],p,2,'zcode-malformed-part'); continue }
    const m = visible.get(p.message_id)
    if (!m) continue
    if (p.type === 'step-start' && m.role === 'assistant') emit([stepStart(p)],p,2)
    if (p.type === 'tool' && m.role === 'assistant' && own(p.started_at)) toolParts.push(p)
    if (p.type !== 'text' || p.text_bytes == null) continue
    const before = texts.get(p.message_id) ?? {parts:[],bytes:0}
    if (typeof p.text !== 'string' || typeof p.text_bytes !== 'number' || before.bytes+p.text_bytes+1 > MAX_TEXT) {
      emit([],p,2,'zcode-text-limit'); continue
    }
    before.parts.push(p.text); before.bytes += p.text_bytes+1
    texts.set(p.message_id,before)
  }
  for (const m of messages) {
    if (!m.valid) emit([],m,1,'zcode-malformed-message')
    else if (visible.has(m.id)) emit([messageEvent(m,texts.get(m.id)?.parts ?? []),modelStop(m)],m,1)
  }
  for (const r of read(`SELECT rowid,id,time_created,
    coalesce(${field('data','modelSelection.modelId')},${field('data','modelId')}) AS model,
    coalesce(${field('data','modelSelection.providerId')},${field('data','providerId')}) AS provider,
    coalesce(${field('data','modelSelection.options.reasoningLevel')},${field('data','thoughtLevel')}) AS effort
    FROM session_entry WHERE session_id=? AND type='runtime/model_selection'`))
    if (own(r.time_created)) emit([modelSelection(r)],r,3)
  for (const r of read(`SELECT rowid,turn_id,status,started_at,completed_at FROM turn_usage WHERE session_id=?`)) {
    if (!own(r.started_at)) continue
    const list = turnEvents(r)
    emit(list,r,4,list.length ? undefined : 'zcode-invalid-turn')
  }
  const recordedTools = new Map<string, Event[]>()
  for (const r of read(`SELECT rowid,tool_call_id,tool_name,turn_id,status,started_at,completed_at FROM tool_usage WHERE session_id=?`)) {
    if (!own(r.started_at)) continue
    const list = toolEvents(r,'tool_usage')
    if (list.length) recordedTools.set(String(r.tool_call_id),list)
    emit(list,r,5,list.length ? undefined : 'zcode-invalid-tool')
  }
  for (const r of toolParts) {
    const recorded = recordedTools.get(String(r.tool_call_id)) ?? []
    const list = toolEvents(r,'part.tool').filter(e=>!recorded.some(old=>old.kind===e.kind))
    emit(list,r,2)
  }
  for (const r of read(`SELECT rowid,logical_request_id,attempt_index,status,turn_id,started_at,completed_at,
    model_id,provider_id,variant,input_tokens,output_tokens,cache_read_input_tokens,
    cache_creation_input_tokens,reasoning_tokens,provider_total_tokens FROM model_usage WHERE session_id=?
    ORDER BY CASE WHEN status='completed' THEN 0 ELSE 1 END,rowid DESC`)) {
    if (!own(r.started_at)) continue
    const e = usageEvent(r,sid)
    emit([e],r,6,e ? undefined : 'zcode-invalid-model-attempt')
  }
  return { events,bad,rowsRead }
}

export async function scanZCode(source: Source, before: Cursor | undefined): Promise<{batch?:Batch;metrics:ScanMetrics}> {
  const original = await files(source.path)
  const reset = before?.identity !== original.identity || !before?.sqlite
  const metrics: ScanMetrics = { path:source.path,adapter:'zcode',offsetBefore:before?.offset ?? 0,
    offsetAfter:before?.offset ?? 0,bytes:0,anchorBytes:0,decodedBytes:0,frames:0,events:0,bad:0,
    reset:false,mode:'sqlite',pending:false,rowsRead:0,sessionsRead:0 }
  if (!reset && before?.head===original.signature) return {metrics}
  const url = pathToFileURL(source.path)
  // Live WAL must be consulted. When no WAL exists, immutable mode avoids
  // creating sidecars; discard the read if a writer changed that condition.
  if (original.immutable) url.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(original.immutable ? url : source.path,{readOnly:true})
  let batch: Batch
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; BEGIN')
    const sessions = db.prepare(`SELECT rowid,id,directory,parent_id,version,time_created,time_updated,time_archived
      FROM session WHERE time_deleted IS NULL`).all() as Row[]
    const fingerprints = inventory(db,sessions)
    const prev = reset ? undefined : before?.sqlite
    const replaceSessions = Object.keys(prev?.fingerprints ?? {}).filter(sid=>!Object.hasOwn(fingerprints,sid))
    const badBySession: Record<string,Bad[]> = Object.assign(Object.create(null),prev?.bad)
    for (const sid of replaceSessions) delete badBySession[sid]
    const events: LocatedEvent[] = []
    for (const session of sessions) {
      const sid = id(session.id)
      if (!sid || fingerprints[sid] === prev?.fingerprints[sid]) continue
      const r = readSession(db,session,sid)
      replaceSessions.push(sid)
      metrics.sessionsRead!++
      metrics.rowsRead! += r.rowsRead
      for (const e of r.events) events.push(e)
      if (r.bad.length) badBySession[sid] = r.bad
      else delete badBySession[sid]
    }
    const bad = Object.values(badBySession).flat()
    const offset = (reset ? 0 : before?.offset ?? 0) + replaceSessions.length
    const cursor: Cursor = { identity:original.identity,head:original.signature,offset,decoded:0,line:'',lineAt:0,
      dropping:false,frame:'',mode:'sqlite',size:original.size,mtime:0,ctime:0,tail:'',context:initialContext(),
      bytesRead:0,anchorBytesRead:0,archive:false,sqlite:{fingerprints,bad:badBySession} }
    batch = {source,cursor,reset,events,bad,replaceSessions}
    db.exec('COMMIT')
  } finally { db.close() }
  const after = await files(source.path)
  if (after.identity !== original.identity || (original.immutable && after.signature !== original.signature))
    return {metrics:{...metrics,pending:true}}
  // A WAL writer may commit while we read. Persist the starting signature so
  // the next poll observes the newer commit even if it occurred before close.
  return {batch,metrics:{...metrics,offsetAfter:batch.cursor.offset,reset,events:batch.events.length,
    bad:batch.bad.length,pending:after.signature!==original.signature}}
}
