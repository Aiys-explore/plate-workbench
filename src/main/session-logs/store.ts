import Database from 'better-sqlite3'
import { localSqlitePath } from '../local-sqlite-path'
import { createHash, randomUUID } from 'node:crypto'
import type { SessionAdapter, SessionMessage, SessionMessageCursor, SessionMessagePage, SessionSummary } from '../../shared/sessions'
import { UsageStore } from './usage'
import { adapterVersion, type Context, type Event } from './adapters'
import { empty, reduce, statusView, type Projection } from './state'

export interface Source { adapter: SessionAdapter; path: string; archive: boolean; compressed: boolean }
export type ZstdFault = 'zstd-magic' | 'zstd-header' | 'zstd-block' | 'zstd-frame-limit' | 'zstd-output-limit' | 'zstd-decode'
export interface Cursor {
  identity: string; offset: number; decoded: number; line: string; lineAt: number; dropping: boolean
  frame: string; mode: 'plain' | 'frames' | 'snapshot' | 'sqlite'
  size: number; mtime: number; ctime: number; head: string; tail: string; context: Context
  bytesRead: number; anchorBytesRead: number; archive: boolean
  // In frame mode, head/tail describe the last complete frame boundary. Offset
  // includes buffered input, but stops at the boundary if the stream is blocked.
  zstd?: { boundary: number; fault?: ZstdFault; drain?: true }
  legacyZstdBoundary?: number
  sqlite?: { fingerprints: Record<string, string>; bad: Record<string, Bad[]> }
}
export interface LocatedEvent { session: string; offset: number; frameAt: number | null; event: Event }
export interface Bad { offset: number; space: 'decoded' | 'physical'; reason: string }
export interface Batch {
  source: Source; cursor: Cursor; reset: boolean; events: LocatedEvent[]; bad: Bad[]
  replaceSessions?: string[]
  resolvedZstdFault?: ZstdFault
}
type SessionRow = { adapter: SessionAdapter; id: string; projection: string; archived: number; confirmed: number | null; revision: string | null }
type EventRow = { event: string }
const messageRevision = (scope: string, adapter: SessionAdapter, id: string, revision: string | null) =>
  createHash('sha256').update(JSON.stringify([scope,adapter,id,revision])).digest('hex')
export class SessionStore {
  private readonly db: Database.Database
  readonly usage: UsageStore
  constructor(file: string) {
    this.db = new Database(localSqlitePath(file), { timeout: 1000 })
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS log_cursor (
        adapter TEXT NOT NULL, path TEXT NOT NULL, archive INTEGER NOT NULL, version TEXT NOT NULL,
        identity TEXT NOT NULL, byte_offset INTEGER NOT NULL, session_id TEXT, state TEXT NOT NULL,
        PRIMARY KEY(adapter,path)
      );
      CREATE TABLE IF NOT EXISTS log_event (
        adapter TEXT NOT NULL, path TEXT NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL,
        decoded_offset INTEGER NOT NULL, physical_frame_offset INTEGER, source_type TEXT NOT NULL,
        sequence INTEGER, at INTEGER, kind TEXT NOT NULL, model TEXT, provider TEXT, turn_id TEXT,
        root_turn_id TEXT, external_id TEXT, actor_id TEXT, usage_mode TEXT, event TEXT NOT NULL,
        PRIMARY KEY(adapter,path,session_id,key),
        FOREIGN KEY(adapter,path) REFERENCES log_cursor(adapter,path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS log_event_session ON log_event(adapter,session_id,path,decoded_offset);
      CREATE INDEX IF NOT EXISTS log_event_day ON log_event(at) WHERE at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS log_bad (
        adapter TEXT NOT NULL, path TEXT NOT NULL, space TEXT NOT NULL, byte_offset INTEGER NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(adapter,path,space,byte_offset),
        FOREIGN KEY(adapter,path) REFERENCES log_cursor(adapter,path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_session (
        adapter TEXT NOT NULL, id TEXT NOT NULL, projection TEXT NOT NULL, archived INTEGER NOT NULL,
        last_at INTEGER, PRIMARY KEY(adapter,id)
      );
      CREATE TABLE IF NOT EXISTS session_tombstone (
        adapter TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(adapter,id)
      );
      CREATE TABLE IF NOT EXISTS session_confirmation (
        adapter TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(adapter,id)
      );
      CREATE TABLE IF NOT EXISTS session_message_revision (
        adapter TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(adapter,id),
        FOREIGN KEY(adapter,id) REFERENCES agent_session(adapter,id) ON DELETE CASCADE
      );
    `)
    this.db.transaction(()=>{
      const c=this.db.prepare('PRAGMA table_info(session_tombstone)').all() as {name:string}[]
      if(!c.some(x=>x.name==='agent_id'))this.db.exec('ALTER TABLE session_tombstone ADD COLUMN agent_id TEXT')
      if(!c.some(x=>x.name==='reason'))this.db.exec('ALTER TABLE session_tombstone ADD COLUMN reason TEXT')
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS session_tombstone_profile ON session_tombstone(agent_id,id) WHERE agent_id IS NOT NULL')
    }).immediate()
    this.usage = new UsageStore(this.db)
  }
  deleteDatabase(){return this.db}
  removed(adapter:SessionAdapter,id:string){
    return !!this.db.prepare('SELECT 1 FROM session_tombstone WHERE adapter=? AND id=?').get(adapter,id)
  }
  close() { this.db.close() }
  cursor(s: Source): Cursor | undefined {
    const row = this.db.prepare('SELECT state, version FROM log_cursor WHERE adapter=? AND path=?').get(s.adapter, s.path) as
      { state: string; version: string } | undefined
    if (row?.version === adapterVersion[s.adapter]) {
      const cursor = JSON.parse(row.state) as Cursor
      if (s.compressed && cursor.mode === 'snapshot') {
        const fault = this.db.prepare(`SELECT byte_offset AS offset FROM log_bad
          WHERE adapter=? AND path=? AND space='physical'
          AND reason IN ('zstd-unsafe-snapshot','zstd-snapshot-limit')`).get(s.adapter,s.path) as {offset:number} | undefined
        cursor.legacyZstdBoundary = fault?.offset ?? cursor.offset
      }
      return cursor
    }
    return undefined
  }
  paths(adapter: SessionAdapter) {
    return (this.db.prepare('SELECT path FROM log_cursor WHERE adapter=?').all(adapter) as { path: string }[]).map(r => r.path)
  }
  private impacted(s: Source) {
    return (this.db.prepare('SELECT DISTINCT session_id FROM log_event WHERE adapter=? AND path=?').all(s.adapter, s.path) as
      { session_id: string }[]).map(r => r.session_id)
  }
  private archive(adapter: SessionAdapter, id: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM log_event e JOIN log_cursor c USING(adapter,path)
      WHERE e.adapter=? AND e.session_id=? AND
        ((e.kind='session' AND c.archive=1) OR (e.adapter='zcode' AND e.kind='archive')) LIMIT 1`).get(adapter, id))
  }
  private save(adapter: SessionAdapter, id: string, projection: Projection) {
    if(this.removed(adapter,id))return
    this.db.prepare(`INSERT INTO agent_session VALUES (?,?,?,?,?) ON CONFLICT(adapter,id)
      DO UPDATE SET projection=excluded.projection, archived=excluded.archived,last_at=excluded.last_at`)
      .run(adapter,id,JSON.stringify(projection), Number(this.archive(adapter,id)),projection.lastAt)
  }
  private advanceMessages(adapter: SessionAdapter, id: string) {
    this.db.prepare(`INSERT INTO session_message_revision
      SELECT adapter,id,? FROM agent_session WHERE adapter=? AND id=?
      ON CONFLICT(adapter,id) DO UPDATE SET revision=excluded.revision`).run(randomUUID(),adapter,id)
  }
  private rebuild(adapter: SessionAdapter, id: string) {
    // Choose one copy per normalized key. Preserve on-disk order within each source, using
    // timestamps/sequence to merge separate files for the same external session.
    const rows = this.db.prepare(`SELECT event FROM (
      SELECT e.*, row_number() OVER (PARTITION BY key ORDER BY e.source_type='jsonl/turn.started', c.archive, e.path, decoded_offset) AS preferred
      FROM log_event e JOIN log_cursor c USING(adapter,path) WHERE e.adapter=? AND e.session_id=?
    ) WHERE preferred=1 ORDER BY kind!='session', at, sequence,
      path, decoded_offset, CASE kind WHEN 'message' THEN 0 ELSE 1 END, key`).all(adapter,id) as EventRow[]
    const events = rows.map(r=>JSON.parse(r.event) as Event)
    if (!rows.length || (adapter==='zcode' && !events.some(e=>e.kind==='session'))) {
      this.db.prepare('DELETE FROM agent_session WHERE adapter=? AND id=?').run(adapter,id)
    } else {
      const created = events.find(e=>e.kind==='session')?.at
      this.save(adapter,id,events.reduce((s,e) => adapter==='zcode' && e.sourceType==='jsonl/turn.started' &&
        (e.at===null || created==null || e.at<created) ? s : reduce(s,e),empty()))
    }
  }
  apply(batch: Batch, onUsage?: (started: number) => void) {
    const { source: s, cursor, events, bad, reset } = batch
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT archive FROM log_cursor WHERE adapter=? AND path=?').get(s.adapter,s.path) as
        { archive: number } | undefined
      const rebuild = new Set(reset || (old && Boolean(old.archive) !== s.archive) ? this.impacted(s) : [])
      if (reset) this.db.prepare('DELETE FROM log_cursor WHERE adapter=? AND path=?').run(s.adapter,s.path)
      if (batch.replaceSessions) {
        const erase = this.db.prepare('DELETE FROM log_event WHERE adapter=? AND path=? AND session_id=?')
        for (const id of batch.replaceSessions) { erase.run(s.adapter,s.path,id); rebuild.add(id) }
        this.db.prepare('DELETE FROM log_bad WHERE adapter=? AND path=?').run(s.adapter,s.path)
      }
      this.db.prepare(`INSERT INTO log_cursor VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(adapter,path) DO UPDATE
        SET archive=excluded.archive,version=excluded.version,identity=excluded.identity,
        byte_offset=excluded.byte_offset,session_id=excluded.session_id,state=excluded.state`)
        .run(s.adapter,s.path,Number(s.archive),adapterVersion[s.adapter],cursor.identity,cursor.offset,cursor.context.sessionId ?? null,JSON.stringify(cursor))
      const append = this.db.prepare(`INSERT OR IGNORE INTO log_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      const grouped = new Map<string, Event[]>()
      for (const {session,offset,frameAt,event: e} of events) {
        if (append.run(s.adapter,s.path,session,e.key,offset,frameAt,e.sourceType,e.sequence ?? null,e.at,e.kind,e.model ?? null,
          e.provider ?? null,e.turn ?? null,e.rootTurn ?? null,e.externalId ?? null,e.actorId ?? null,e.usageMode ?? null,JSON.stringify(e)).changes) {
          if (!grouped.has(session)) grouped.set(session,[])
          grouped.get(session)!.push(e)
        }
      }
      for (const [id, added] of grouped) {
        const multiple = this.db.prepare('SELECT 1 FROM log_event WHERE adapter=? AND session_id=? AND path<>? LIMIT 1').get(s.adapter,id,s.path)
        if (s.adapter==='zcode' || reset || multiple || rebuild.has(id)) { rebuild.add(id); continue }
        const before = this.db.prepare('SELECT projection FROM agent_session WHERE adapter=? AND id=?').get(s.adapter,id) as
          { projection: string } | undefined
        this.save(s.adapter,id,added.reduce(reduce,before ? JSON.parse(before.projection) as Projection : empty()))
      }
      for (const id of rebuild) this.rebuild(s.adapter,id)
      for (const id of rebuild) this.advanceMessages(s.adapter,id)
      for (const [id, added] of grouped) {
        if (!rebuild.has(id) && added.some(e => e.kind === 'message')) this.advanceMessages(s.adapter,id)
      }
      const usageStarted = onUsage ? Date.now() : 0
      for (const id of new Set([...rebuild,...grouped.keys()])) this.usage.refresh(s.adapter,id)
      onUsage?.(usageStarted)
      const isolate = this.db.prepare('INSERT OR IGNORE INTO log_bad VALUES(?,?,?,?,?)')
      if (batch.resolvedZstdFault) {
        this.db.prepare(`DELETE FROM log_bad WHERE adapter=? AND path=? AND space='physical'
          AND byte_offset=? AND reason=?`).run(s.adapter,s.path,cursor.zstd!.boundary,batch.resolvedZstdFault)
      }
      for (const b of bad) isolate.run(s.adapter,s.path,b.space,b.offset,b.reason)
    })()
  }
  remove(source: Source) {
    this.db.transaction(() => {
      const ids = this.impacted(source)
      this.db.prepare('DELETE FROM log_cursor WHERE adapter=? AND path=?').run(source.adapter,source.path)
      for (const id of ids) {
        this.rebuild(source.adapter,id)
        this.advanceMessages(source.adapter,id)
        this.usage.refresh(source.adapter,id)
      }
    })()
  }
  tombstone(adapter: SessionAdapter, id: string, at: number) {
    this.db.prepare('INSERT OR IGNORE INTO session_tombstone(adapter,id,at) VALUES(?,?,?)').run(adapter,id,at)
  }
  zcodeEvidence(path: string) {
    const cursor = this.cursor({adapter:'zcode',path,archive:false,compressed:false})
    if (!cursor?.sqlite) return []
    return (this.db.prepare(`SELECT source_type AS source, max(at) AS at FROM log_event
      WHERE adapter='zcode' AND path=? AND kind IN ('session','message','turn-end','tool-start','usage')
        AND (kind!='usage' OR (usage_mode='zcode-response' AND json_extract(event,'$.usage') IS NOT NULL))
      GROUP BY source_type`).all(path) as {source:string;at:number|null}[])
  }
  confirm(adapter: SessionAdapter, id: string, at: number) {
    this.db.prepare('INSERT OR REPLACE INTO session_confirmation VALUES(?,?,?)').run(adapter,id,at)
  }
  private readMessages(adapter: SessionAdapter, id: string, before: number, limit: number) {
    const rows = this.db.prepare(`WITH picked AS (
      SELECT e.*,row_number() OVER (PARTITION BY e.key ORDER BY c.archive,e.path,e.decoded_offset) AS preferred
      FROM log_event e JOIN log_cursor c USING(adapter,path)
      WHERE e.adapter=? AND e.session_id=? AND e.kind='message'
        AND NOT EXISTS (SELECT 1 FROM session_tombstone t WHERE t.adapter=e.adapter AND t.id=e.session_id)
        AND json_extract(e.event,'$.text') IS NOT NULL
    ), numbered AS (
      SELECT event,row_number() OVER (ORDER BY at,sequence,path,decoded_offset,key) AS position,
        count(*) OVER () AS total FROM picked WHERE preferred=1
    ) SELECT event,position,total FROM numbered WHERE position<? ORDER BY position DESC LIMIT ?`).all(adapter,id,before,limit) as
      {event:string; position:number; total:number}[]
    const items: SessionMessage[] = rows.reverse().map(({event,position}) => {
      const e = JSON.parse(event) as Event
      return { offset:position, at:e.at, role:e.role!, text:e.text!, source:e.sourceType }
    })
    return { items, total: rows[0]?.total ?? 0 }
  }
  messages(adapter: SessionAdapter, id: string, before: number, limit: number): SessionMessage[] {
    return this.readMessages(adapter,id,before,limit).items
  }
  resumeRecord(adapter: SessionAdapter, id: string, scope: string) {
    const row = this.db.prepare(`SELECT s.projection,r.revision FROM agent_session s
      LEFT JOIN session_message_revision r USING(adapter,id) WHERE s.adapter=? AND s.id=?
      AND NOT EXISTS(SELECT 1 FROM session_tombstone t WHERE t.adapter=s.adapter AND t.id=s.id)`)
      .get(adapter,id) as { projection: string; revision: string | null } | undefined
    if (!row) return null
    const sources = this.db.prepare(`SELECT c.path,c.identity,c.state FROM log_cursor c JOIN log_event e USING(adapter,path)
      WHERE c.adapter=? AND e.session_id=? GROUP BY c.path ORDER BY c.path LIMIT 2`)
      .all(adapter,id) as {path:string; identity:string; state:string}[]
    // Multiple source files can be merged for reading, but do not prove a unique action target.
    if (sources.length !== 1 || !this.db.prepare(`SELECT 1 FROM log_event WHERE adapter=? AND path=? AND session_id=? AND kind='session'`)
      .get(adapter,sources[0].path,id)) return null
    const { cwd, parentId } = JSON.parse(row.projection) as Projection
    return { revision: messageRevision(scope,adapter,id,row.revision), cwd, parentId,
      source: {path:sources[0].path, identity:sources[0].identity, cursor:JSON.parse(sources[0].state) as Cursor} }
  }
  messagePage(adapter: SessionAdapter, id: string, scope: string, cursor?: SessionMessageCursor): SessionMessagePage {
    return this.db.transaction((): SessionMessagePage => {
      const row = this.db.prepare(`SELECT r.revision FROM agent_session s
        LEFT JOIN session_message_revision r USING(adapter,id)
        WHERE s.adapter=? AND s.id=? AND NOT EXISTS (
          SELECT 1 FROM session_tombstone t WHERE t.adapter=s.adapter AND t.id=s.id)`).get(adapter,id) as
        { revision: string | null } | undefined
      if (!row) return { adapter,id,status:'missing' }
      const revision = messageRevision(scope,adapter,id,row.revision)
      if (cursor && cursor.revision !== revision) return { adapter,id,status:'changed' }
      const before = cursor?.before ?? null
      const { items,total } = this.readMessages(adapter,id,before ?? Number.MAX_SAFE_INTEGER,5)
      if (before !== null && (!items.length || before > total || items.at(-1)?.offset !== before - 1)) {
        return { adapter,id,status:'changed' }
      }
      return { adapter,id,status:'ok',revision,before,total,items }
    })()
  }
  list(started: number, now: number, threshold: number, enabled: ReadonlySet<SessionAdapter>, scope?: string): SessionSummary[] {
    const rows = this.db.prepare(`SELECT s.*, c.at AS confirmed, r.revision FROM agent_session s
      LEFT JOIN session_confirmation c USING(adapter,id)
      LEFT JOIN session_message_revision r USING(adapter,id)
      WHERE NOT EXISTS (SELECT 1 FROM session_tombstone t WHERE t.adapter=s.adapter AND t.id=s.id)
      ORDER BY s.last_at DESC, s.adapter, s.id`).all() as SessionRow[]
    return rows.filter(row => enabled.has(row.adapter)).map(row => {
      const s = JSON.parse(row.projection) as Projection
      const { cwd, project, parentId, model, lastAt, lastKind, eventCount, messageCount, toolCount, turnCount, usage, usageBasis } = s
      const active = statusView(s, Boolean(row.archived), row.confirmed !== null && (s.activeAt ?? 0) <= row.confirmed, started, now, threshold)
      return { adapter: row.adapter, id: row.id, cwd, project, parentId, model, lastAt, lastKind, eventCount,
        messageCount, toolCount, turnCount, usage, usageBasis,
        ...(scope && { messageRevision: messageRevision(scope,row.adapter,row.id,row.revision) }),
        contextWindow: s.contextWindow ?? null, recentContext: s.recentContext ?? null,
        contextOccupancy: s.contextOccupancy ?? null, effort: s.effort ?? null, step: s.step ?? null,
        turnStartedAt: s.turnStartedAt ?? null,
        turnStoppedAt: s.turnStoppedAt ?? (active.status === 'PAUSED' ? s.lastAt : null), ...active }
    })
  }
  badLines(enabled: ReadonlySet<SessionAdapter>) {
    const rows = this.db.prepare("SELECT adapter,count(*) AS n FROM log_bad WHERE space='decoded' GROUP BY adapter").all() as
      { adapter: SessionAdapter; n: number }[]
    return rows.reduce((sum, r) => sum + (enabled.has(r.adapter) ? r.n : 0), 0)
  }
}
