import type Database from 'better-sqlite3'
import { sessionAdapters, type SessionAdapter, type Usage } from '../../shared/sessions'
import { usageFields, type Bucket, type Dimension, type Measure, type Quota, type Totals, type UsageDay } from '../../shared/usage'
import type { Event } from './adapters'

const schema = `
CREATE TABLE IF NOT EXISTS usage_fact (
 adapter TEXT NOT NULL, sid TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL,
 at INTEGER, kind TEXT NOT NULL, stable TEXT, child INTEGER NOT NULL, model TEXT, project TEXT, project_key TEXT,
 input INTEGER, output INTEGER, cachedInput INTEGER, cacheWrite INTEGER, reasoning INTEGER, total INTEGER,
 quota TEXT, PRIMARY KEY(adapter,sid,key),
 FOREIGN KEY(adapter,path) REFERENCES log_cursor(adapter,path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS usage_fact_at ON usage_fact(at);
CREATE INDEX IF NOT EXISTS usage_fact_stable ON usage_fact(adapter,kind,stable,child,at,sid,key) WHERE stable IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_fact_winner ON usage_fact(adapter,kind,stable,child,(at IS NULL),coalesce(at,0),sid,key)
 WHERE stable IS NOT NULL;
CREATE TABLE IF NOT EXISTS usage_manual (id INTEGER PRIMARY KEY CHECK(id=1), amount INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE VIEW IF NOT EXISTS usage_unique AS
 SELECT f.* FROM usage_fact f WHERE NOT EXISTS
 (SELECT 1 FROM session_tombstone t WHERE t.adapter=f.adapter AND t.id=f.sid)
 AND (f.stable IS NULL OR NOT EXISTS (SELECT 1 FROM usage_fact p
   WHERE p.adapter=f.adapter AND p.kind=f.kind AND p.stable=f.stable
   AND (p.child,p.at IS NULL,coalesce(p.at,0),p.sid,p.key) <
       (f.child,f.at IS NULL,coalesce(f.at,0),f.sid,f.key)
   AND NOT EXISTS (SELECT 1 FROM session_tombstone t WHERE t.adapter=p.adapter AND t.id=p.sid)));
`
type Fact = { path: string; event: string }
const localDay = (at: number) => {
  const d = new Date(at)
  return [d.getFullYear(),d.getMonth()+1,d.getDate()].map(v=>String(v).padStart(2,'0')).join('-')
}
const measure = (value: number | null, known: number, missing = 0): Measure => ({value, known, missing})
const shift = (now: number, amount: number) => {
  const d = new Date(now); d.setHours(0,0,0,0); d.setDate(d.getDate()+amount); return +d
}
const projectKey = (cwd?: string) => cwd == null ? null : process.platform === 'win32' ? cwd.replaceAll('/','\\').toLowerCase() : cwd
const use = usageFields.map(f => `sum(${f}) AS ${f},count(${f}) AS ${f}_n`).join(',')
const agg = `count(DISTINCT adapter||':'||sid) FILTER (WHERE kind NOT IN ('quota','gap')) AS sessions,
 count(*) FILTER (WHERE kind='turn' AND stable IS NOT NULL) AS turns,
 count(*) FILTER (WHERE kind='turn' AND stable IS NULL) AS turn_missing,
 count(*) FILTER (WHERE kind='call') AS calls,
 count(*) FILTER (WHERE kind IN ('usage','gap')) AS usage_n,${use}`
type Group = Record<string, number | null>
function totals(r: Group): Totals {
  const count = (n: string, missing = 0) => measure(r[n] || null,r[n] ?? 0,missing)
  return { sessions:count('sessions'), turns:count('turns',r.turn_missing ?? 0), calls:count('calls'),
    tokens:Object.fromEntries(usageFields.map(f=>[f,measure(r[f] ?? null,r[f+'_n'] ?? 0,
      (r.usage_n ?? 0)-(r[f+'_n'] ?? 0))])) as Totals['tokens'] }
}
const dimensionColumn = {adapter:'adapter',model:'model',project:'project_key'} as const
const adapterLabels: Record<SessionAdapter,string> = {codex:'Codex',deepseek:'DeepSeek Harness',zcode:'ZCode'}
const adapterLabel = (key: string | null) => adapterLabels[key as SessionAdapter] ?? '未归属'
const placeholders = sessionAdapters.map(()=>'?').join(',')
const enabledArgs = (enabled: ReadonlySet<SessionAdapter>) => sessionAdapters.map(a=>enabled.has(a) ? a : '')

export class UsageStore {
  private readonly put: Database.Statement
  constructor(private readonly db: Database.Database) {
    db.exec(schema)
    db.function('usage_local_day',{deterministic:false},at=>localDay(Number(at)))
    this.put = db.prepare('INSERT OR IGNORE INTO usage_fact VALUES ('+Array(18).fill('?').join(',')+')')
    db.exec('CREATE TABLE IF NOT EXISTS usage_migration(version INTEGER PRIMARY KEY)')
    if (!db.prepare('SELECT 1 FROM usage_migration WHERE version=1').get()) db.transaction(()=>{
      for (const s of db.prepare('SELECT adapter,id FROM agent_session').all() as {adapter: SessionAdapter; id: string}[]) this.refresh(s.adapter,s.id)
      db.prepare('INSERT INTO usage_migration VALUES (1)').run()
    })()
    if (!db.prepare('SELECT 1 FROM usage_migration WHERE version=2').get()) db.transaction(()=>{
      db.exec(`DROP VIEW usage_unique;
        CREATE VIEW usage_unique AS
        SELECT f.* FROM usage_fact f WHERE NOT EXISTS
          (SELECT 1 FROM session_tombstone t WHERE t.adapter=f.adapter AND t.id=f.sid)
        AND (f.stable IS NULL OR (f.sid,f.key) = (
          SELECT p.sid,p.key FROM usage_fact p
          WHERE p.adapter=f.adapter AND p.kind=f.kind AND p.stable=f.stable
            AND NOT EXISTS (SELECT 1 FROM session_tombstone t WHERE t.adapter=p.adapter AND t.id=p.sid)
          ORDER BY p.child,p.at IS NULL,coalesce(p.at,0),p.sid,p.key LIMIT 1));
        INSERT INTO usage_migration VALUES (2);`)
    })()
  }
  refresh(adapter: SessionAdapter, sid: string) {
    this.db.prepare('DELETE FROM usage_fact WHERE adapter=? AND sid=?').run(adapter,sid)
    if (adapter==='zcode' && !this.db.prepare('SELECT 1 FROM agent_session WHERE adapter=? AND id=?').get(adapter,sid)) return
    const rows = this.db.prepare(`SELECT path,event FROM (
      SELECT e.path,e.event,e.at,e.sequence,e.kind,e.key,e.decoded_offset,
       row_number() OVER (PARTITION BY e.key ORDER BY e.source_type='jsonl/turn.started',c.archive,e.path,e.decoded_offset) AS picked
      FROM log_event e JOIN log_cursor c USING(adapter,path) WHERE e.adapter=? AND e.session_id=?
    ) WHERE picked=1 ORDER BY kind!='session', at IS NULL,at,sequence,path,decoded_offset,key`).all(adapter,sid) as Fact[]
    let child = false, project: string | null = null, cwd: string | undefined, created: number|null = null
    let previous: Usage | undefined, pending = 0
    const events = rows.map(({path,event})=>({path,e:JSON.parse(event) as Event}))
    const scopedResponse = events.some(({e})=>e.usageMode==='codex-response')
    const turns = new Set<string>()
    const add = (path: string,e: Event,kind: string,stable?: string,usage?: Usage,quota?: unknown) =>
      this.put.run(adapter,sid,e.key,path,e.at,kind,stable ?? null,Number(child),e.model ?? null,project,projectKey(cwd),
        ...usageFields.map(f=>usage?.[f] ?? null),quota ? JSON.stringify(quota) : null)
    for (const {path,e} of events) {
      if (e.cwd !== undefined) { cwd=e.cwd; project=e.project ?? cwd }
      if (e.kind === 'session') { child=Boolean(e.parentId); created=e.at; continue }
      if (e.sourceType==='jsonl/turn.started' && (created===null || e.at===null || e.at<created)) continue
      if (e.kind === 'context' || e.kind === 'archive') continue
      if (e.kind === 'quota') { if (e.quota?.length) add(path,e,'quota',undefined,undefined,e.quota); continue }
      if (e.kind === 'usage') {
        if (e.usageMode !== 'codex-total') {
          if (e.usageMode === 'codex-response') pending++
          const owned = !child || (adapter === 'deepseek' ? Boolean(e.externalId) : e.actorId === sid || e.ownHistory)
          add(path,e,owned && e.usage ? 'usage' : 'gap',e.externalId,owned ? e.usage : undefined)
          continue
        }
        if (!e.usage) continue
        const current = e.usage, prev = previous
        if (prev && usageFields.every(f=>current[f]===prev[f])) continue
        previous = current
        const delta: Usage = {}
        for (const f of usageFields) {
          const currentValue = current[f], baseline = prev?.[f]
          if (currentValue !== undefined && (baseline !== undefined || !prev) && currentValue >= (baseline ?? 0))
            delta[f] = currentValue-(baseline ?? 0)
        }
        // A snapshot can fill a missing response only when the entire change matches
        // the single request reported on the same row. Never attribute inherited totals.
        const last = e.lastUsage
        const matched = last && delta.total !== undefined && last.total === delta.total &&
          usageFields.every(f=>delta[f] === undefined || last[f] === undefined || delta[f] === last[f])
        if (!child && !pending && !scopedResponse && matched) {
          const value: Usage = {}
          for (const f of usageFields) if (delta[f] !== undefined && delta[f] === last[f]) value[f] = delta[f]
          add(path,e,'usage',undefined,value)
        } else if (!child && !pending && (prev || !scopedResponse)) add(path,e,'gap')
        pending = 0
        continue
      }
      if (e.kind === 'turn-end') {
        if (e.completedTurn && e.at !== null) {
          if (turns.has(e.completedTurn)) continue
          turns.add(e.completedTurn)
        }
        add(path,e,'turn',e.completedTurn ? JSON.stringify(adapter==='zcode' ? [e.completedTurn] : [e.completedTurn,e.at]) : undefined)
      } else if (e.kind === 'tool-start' && e.call) add(path,e,'call',JSON.stringify(adapter==='zcode' ? [e.call] : [e.call,e.at]))
      else add(path,e,'activity',e.messageId ? JSON.stringify(['message',e.messageId,e.at])
        : e.call ? JSON.stringify([e.kind,e.call,e.at]) : undefined)
    }
  }
  window(days: number, now: number, enabled: ReadonlySet<SessionAdapter>, dimension: Dimension = 'adapter', filter?: string | null) {
    const col = dimensionColumn[dimension]
    const sql = `FROM usage_unique WHERE adapter IN (${placeholders}) AND kind!='quota' AND at>=? AND at<=?`
    const args = [...enabledArgs(enabled),shift(now,1-days),now]
    const filtered = filter === undefined ? '' : ` AND ${col} IS ?`
    const params = filter === undefined ? args : [...args,filter]
    const query = (head: string, tail = '') => this.db.prepare(`SELECT ${head} ${sql}${filtered} ${tail}`).all(...params)
    const label = (dim: Dimension,key: string | null,label?: string) => dim==='adapter' ? adapterLabel(key) : label ?? key ?? '未归属'
    const group = (dim: Dimension): Bucket[] => {
      const column = dimensionColumn[dim], title = dim==='project' ? ',min(project) AS title' : ''
      return (query(`${column} AS k${title},${agg}`,`GROUP BY ${column} ORDER BY total DESC,${column}`) as (Group & {k:string|null; title?:string})[])
        .map(r=>({key:r.k,label:label(dim,r.k,r.title),totals:totals(r)}))
    }
    const filterOptions = (this.db.prepare(`SELECT ${col} AS k,${dimension==='project'?'min(project)':'NULL'} AS title ${sql} GROUP BY ${col} ORDER BY ${col}`)
      .all(...args) as {k:string|null;title?:string}[]).map(r=>({key:r.k,label:label(dimension,r.k,r.title)}))
    const dates = new Map((query(`usage_local_day(at) AS d,${agg}`,'GROUP BY d') as (Group & {d:string})[]).map(r=>[r.d,r]))
    const trend = Array.from({length:days},(_,i)=>{
      const key=localDay(shift(now,i+1-days));return {key,label:key,totals:totals(dates.get(key) ?? {})}
    })
    const total = totals((query(agg) as Group[])[0])
    const undated = Number((this.db.prepare(`SELECT count(*) AS n FROM usage_unique WHERE adapter IN (${placeholders}) AND kind IN ('usage','gap','turn','call','activity') AND at IS NULL${filtered}`)
      .get(...enabledArgs(enabled),...(filter===undefined?[]:[filter])) as {n:number}).n)
    return {days:trend,groups:group(dimension),models:group('model'),total,filter:filterOptions,
      undated,modelDenominator:total.tokens.total.value}
  }
  today(now: number, enabled: ReadonlySet<SessionAdapter>) {
    const args = [...enabledArgs(enabled),shift(now,0),now]
    const source = `FROM usage_unique WHERE adapter IN (${placeholders}) AND kind!='quota' AND at>=? AND at<=?`
    const rows = this.db.prepare(`SELECT adapter,sid AS id,${agg} ${source} GROUP BY adapter,sid`).all(...args) as
      (Group & {adapter:SessionAdapter;id:string})[]
    // Groups partition the same deduplicated facts by adapter and session.
    // Derive the footer from those rows rather than running the same scan again.
    const summed: Group = {}
    const day: UsageDay[] = rows.map(r=>{
      for (const [k,v] of Object.entries(r)) {
        if (typeof v === 'number') summed[k] = (summed[k] ?? 0) + v
      }
      const t=totals(r)
      return {...t,adapter:r.adapter,id:r.id,endedTurns:t.turns.value,tokenTotal:t.tokens.total.value}
    })
    return {day,today:totals(summed)}
  }
  quota(now: number, enabled: ReadonlySet<SessionAdapter>) {
    const quota: Quota[] = []
    if (enabled.has('codex')) {
      const rows = this.db.prepare(`SELECT value FROM (
       SELECT j.value, row_number() OVER (PARTITION BY json_extract(j.value,'$.scope'),json_extract(j.value,'$.slot') ORDER BY f.at DESC,f.sid,f.key) AS pick
       FROM usage_unique f,json_each(f.quota) j WHERE f.kind='quota' AND f.at<=?) WHERE pick=1`).all(now) as {value:string}[]
      for (const r of rows) quota.push(JSON.parse(r.value) as Quota)
    }
    const manual = this.db.prepare('SELECT amount AS "limit",at FROM usage_manual WHERE id=1').get() as {limit:number;at:number}|undefined
    return {quota,manual:manual ?? null}
  }
  manual(limit: number | null, at: number) {
    if (limit === null) this.db.prepare('DELETE FROM usage_manual WHERE id=1').run()
    else this.db.prepare('INSERT OR REPLACE INTO usage_manual VALUES (1,?,?)').run(limit,at)
  }
}

