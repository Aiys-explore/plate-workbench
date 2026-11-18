import { watch, type FSWatcher } from 'chokidar'
import { lstat, readdir } from 'node:fs/promises'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sessionAdapters, type SessionAdapter, type SessionDashboard, type SessionMessageCursor, type SessionMessagePage } from '../../shared/sessions'
import type { Dimension, UsageReport } from '../../shared/usage'
import { scan, type ScanMetrics } from './scan'
import { SessionStore, type Source } from './store'
import { scanZCode } from './zcode-scan'
import { createHash, randomUUID } from 'node:crypto'
import { digest } from './adapters'

type Timing = { phase: string; at: number; ms?: number; source?: string; bytes?: number; events?: number; sessions?: number }
const tracing = process.env.NOTES_WORKBENCH_ACCEPTANCE_TIMING === '1'
const timeline: Timing[] = []
const timing = (phase: string, started?: number, details?: Omit<Timing,'phase'|'at'|'ms'>) => {
  if (!tracing) return
  const at = Date.now()
  timeline.push({ phase, at, ...(started === undefined ? {} : { ms: at - started }), ...details })
  if (timeline.length > 12000) timeline.splice(0,1000)
}
if (tracing) Object.defineProperty(globalThis,Symbol.for('workbench.acceptance.timing'),{value:timeline})
const sourceTag = (path: string) => tracing
  ? createHash('sha256').update((process.platform === 'win32' ? path.toLowerCase() : path)).digest('hex').slice(0,16)
  : undefined

type Root = { adapter: SessionAdapter; root: string; archive: boolean }
type ProfileSource = { type: string; logPath: string; enabled: boolean; archivePath?: string }
const QUIET = 1000
const local = (p: string) => isAbsolute(p) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(p))
const within = (root: string, file: string) => {
  const r = relative(root,file)
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)
}
async function safeTarget(path: string) {
  if (!(await safeRoot(dirname(path)))) return false
  const stat = await lstat(path)
  return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())
}
function candidate(root: Root, path: string): Source | undefined {
  const name = basename(path)
  const match = root.adapter === 'codex' ? /^rollout-[\w.-]+\.jsonl$/.test(name)
    : root.adapter === 'deepseek' ? /^session\.v4\.jsonl(?:\.(?:zstd|zst))?$/.test(name)
    : path === root.root && /\.sqlite$/i.test(name) || /^zcode-\d{4}-\d\d-\d\d\.jsonl$/.test(name)
  if (match) return { adapter: root.adapter, path, archive: root.archive, compressed: /\.(zstd|zst)$/.test(name) }
  return undefined
}
async function safeRoot(path: string) {
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    const s = await lstat(p)
    if (!s.isDirectory() || s.isSymbolicLink()) return false
  }
  return true
}
export class SessionService {
  private readonly started = Date.now()
  private roots: Root[] = []
  private messageScope = randomUUID()
  private watcher?: FSWatcher
  private periodic?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  private active?: Promise<void>
  private rerun = false
  private closed = false
  private quiet = new Map<string,{ signature: string; since: number }>()
  private changed = new Map<string,Source>()
  private notified = new Set<string>()
  private inventoryNeeded = true
  private metrics: ScanMetrics[] = []
  private readonly store: SessionStore
  private dayCache?: { start: number; expires: number; data: Pick<SessionDashboard,'day'|'today'>; badLines: number }
  constructor(file: string, private readonly threshold = 90000, private readonly held=()=>false) { this.store = new SessionStore(file) }
  deleteDatabase(){return this.store.deleteDatabase()}
  removed(adapter:SessionAdapter,id:string){return this.store.removed(adapter,id)}
  invalidateDeletion(){this.dayCache=undefined}
  async configure(profiles: ProfileSource[]) {
    if (this.closed || this.held()) return
    const roots = new Map<string,Root>()
    for (const p of profiles) {
      if (!p.enabled || !sessionAdapters.includes(p.type as SessionAdapter) || !local(p.logPath)) continue
      const adapter = p.type as SessionAdapter
      const add = (root: string, archive: boolean) => {
        root = resolve(root)
        const key = adapter + ':' + (process.platform === 'win32' ? root.toLowerCase() : root)
        if (!roots.has(key) || archive) roots.set(key,{ adapter, root, archive })
      }
      add(p.logPath, false)
      if (adapter === 'zcode' && basename(p.logPath).toLowerCase() === 'db.sqlite' &&
        basename(dirname(p.logPath)).toLowerCase() === 'db') add(join(dirname(dirname(p.logPath)),'log'),false)
      if (adapter === 'codex' && p.archivePath && local(p.archivePath)) add(p.archivePath,true)
    }
    const next = [...roots.values()].sort((a,b) => Number(b.archive) - Number(a.archive) || a.root.localeCompare(b.root))
    if (JSON.stringify(next) === JSON.stringify(this.roots)) return
    this.roots = next
    this.messageScope = randomUUID()
    this.dayCache = undefined
    await this.watcher?.close()
    if (this.closed || this.held()) return
    this.changed.clear(); this.notified.clear(); this.quiet.clear()
    this.inventoryNeeded = true
    const watched: string[] = []
    for (const r of next) if (await safeTarget(r.root).catch(() => false)) {
      watched.push(r.root)
      if (r.adapter === 'zcode' && /\.sqlite$/i.test(r.root)) watched.push(r.root+'-wal')
    }
    if (this.closed || this.held()) return
    this.watcher = watched.length ? watch(watched, {
      persistent: false, ignoreInitial: true, followSymlinks: false, depth: 8,
      ignored: (path, st) => Boolean(st && (st.isSymbolicLink() || (st.isFile() &&
        !this.roots.some(r => (within(r.root,path) && candidate(r,path)) ||
          (r.adapter==='zcode' && path===r.root+'-wal')))))
    }) : undefined
    this.watcher?.on('all',(kind,path) => {
      if (kind === 'addDir' || kind === 'unlinkDir') { this.inventoryNeeded = true; this.schedule(); return }
      for (const r of this.roots) {
        const src = r.adapter==='zcode' && path===r.root+'-wal' ? r.root : path
        if (!within(r.root,src)) continue
        const s = candidate(r,src)
        if (s) {
          const key = s.adapter + ':' + src
          this.changed.set(key,s)
          this.notified.add(key)
          timing('watch',undefined,{source:sourceTag(src)})
        }
      }
      this.schedule()
    }).on('error', () => { this.inventoryNeeded = true; this.schedule() })
    this.periodic ??= setInterval(() => { this.inventoryNeeded = true; this.schedule(0) }, 1500)
    this.periodic.unref()
    this.schedule(0)
  }
  private schedule(ms = 110) {
    if (this.closed || this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.refresh().catch(() => { this.inventoryNeeded = true })
    },ms)
    this.debounce.unref()
  }
  list(now = Date.now()) {
    return this.store.list(this.started, now, this.threshold, new Set(this.roots.map(r => r.adapter)), this.messageScope)
  }
  zcodeEvidence(path: string) {
    return this.store.zcodeEvidence(resolve(path))
  }
  dashboard(now = Date.now()): SessionDashboard {
    const begin = Date.now()
    const enabled = new Set(this.roots.map(r => r.adapter))
    const localDay = new Date(now)
    const dayStart = localDay.setHours(0, 0, 0, 0)
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!this.dayCache || this.dayCache.start !== dayStart || this.dayCache.expires <= now) {
      const usageStarted = Date.now()
      this.dayCache = { start: dayStart, expires: now + 4000,
        data: this.store.usage.today(now, enabled), badLines: this.store.badLines(enabled) }
      timing('dashboard-usage',usageStarted)
    }
    const listStarted = Date.now()
    const sessions = this.list(now)
    timing('dashboard-list',listStarted,{sessions:sessions.length})
    timing('ipc-dashboard',begin,{sessions:sessions.length})
    return { sessions, ...this.dayCache.data, dayStart, timeZone,
      sources: this.roots.length, badLines: this.dayCache.badLines }
  }
  usage(days: 7 | 30, dimension: Dimension, filter?: string | null): UsageReport {
    if ((days !== 7 && days !== 30) || !['adapter','model','project'].includes(dimension) ||
      (filter !== undefined && filter !== null && (typeof filter !== 'string' || filter.length > 4096)))
      throw new Error('统计筛选无效')
    const enabled = new Set(this.roots.map(r => r.adapter)), now = Date.now()
    return {...this.store.usage.window(days,now,enabled,dimension,filter), ...this.store.usage.quota(now,enabled),
      badLines:this.store.badLines(enabled), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,through:now}
  }
  manualLimit(limit: number | null) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('上限必须为正整数')
    this.store.usage.manual(limit,Date.now())
  }
  messages(adapter: SessionAdapter, id: string, before = Number.MAX_SAFE_INTEGER, limit = 5) {
    if (!sessionAdapters.includes(adapter) || typeof id !== 'string' || id.length > 256 ||
      !Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('会话消息查询参数无效')
    }
    return this.roots.some(r => r.adapter === adapter) ? this.store.messages(adapter,id,before,limit) : []
  }
  messagePage(adapter: SessionAdapter, id: string, cursor?: SessionMessageCursor): SessionMessagePage {
    if (!sessionAdapters.includes(adapter) || typeof id !== 'string' || !id.length || id.length > 256 ||
      (cursor !== undefined && (!cursor || typeof cursor.revision !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.revision) ||
        !Number.isSafeInteger(cursor.before) || cursor.before < 2))) throw new Error('会话分页参数无效')
    if (!this.roots.some(root => root.adapter === adapter)) return { adapter,id,status:'missing' }
    return this.store.messagePage(adapter,id,this.messageScope,cursor)
  }
  resumeRecord(adapter: SessionAdapter, id: string) {
    if (this.closed || !sessionAdapters.includes(adapter)) return null
    const r = this.store.resumeRecord(adapter,id,this.messageScope)
    if (!r || !this.roots.some(root => root.adapter === adapter && within(root.root,r.source.path))) return null
    const { path, identity, cursor } = r.source
    try {
      const canonical = realpathSync.native(path)
      if ((process.platform === 'win32' ? canonical.toLowerCase() : canonical) !==
          (process.platform === 'win32' ? path.toLowerCase() : path)) return null
      const file = openSync(path,'r')
      try {
        const stat = fstatSync(file,{bigint:true}), entry = lstatSync(path,{bigint:true})
        const key = (s: typeof stat) => [s.dev,s.ino,s.birthtimeNs].join(':')
        const stamp = (s: typeof stat) => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')
        if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || key(stat) !== identity ||
            key(entry) !== identity || stat.ino === 0n) return null
        if (cursor.mode === 'sqlite') {
          const side = (suffix: string) => lstatSync(path+suffix,{bigint:true,throwIfNoEntry:false})
          const wal = side('-wal'), journal = side('-journal')
          if (journal?.size || wal && (!wal.isFile() || wal.isSymbolicLink()) ||
              cursor.head !== [stamp(stat),wal ? stamp(wal) : ''].join('|')) return null
        } else {
          if (stat.size !== BigInt(cursor.size) || Number(stat.mtimeNs / 1000n) !== cursor.mtime ||
              Number(stat.ctimeNs / 1000n) !== cursor.ctime || cursor.offset !== cursor.size ||
              cursor.line.length || cursor.frame.length || cursor.dropping) return null
          const len = Math.min(cursor.offset,128)
          const at = (start: number) => {
            const bytes = Buffer.alloc(len)
            return readSync(file,bytes,0,len,start) === len ? digest(bytes) : null
          }
          if (at(0) !== cursor.head || at(cursor.offset-len) !== cursor.tail) return null
        }
        if (stamp(lstatSync(path,{bigint:true})) !== stamp(stat)) return null
      } finally { closeSync(file) }
    } catch { return null }
    return { cwd:r.cwd, revision:r.revision, source:path, fingerprint:identity, subagent:!!r.parentId }
  }
  async refresh() {
    if (this.closed || this.held()) return
    if (this.active) { this.rerun = true; return this.active }
    this.active = this.cycle()
    try { await this.active } finally {
      this.active = undefined
      if (this.rerun) { this.rerun = false; this.schedule(0) }
    }
  }
  private async cycle() {
    const pending = new Map(this.changed); this.changed.clear()
    const notified = new Set(this.notified); this.notified.clear()
    const roots = this.roots
    const recentFiles = new Map<string,number>()
    if (this.inventoryNeeded && !notified.size) {
      const inventoryStarted = Date.now()
      this.inventoryNeeded = false
      const visit = async (r: Root, dir: string, depth: number): Promise<void> => {
        if (this.closed || depth > 8) return
        for (const d of await readdir(dir,{withFileTypes:true})) {
          if (d.isSymbolicLink()) continue
          const path = join(dir,d.name)
          if (d.isDirectory()) await visit(r,path,depth+1)
          else if (d.isFile()) {
            const s = candidate(r,path)
            if (s) {
              const key = s.adapter + ':' + path
              if (!pending.get(key)?.archive) pending.set(key,s)
              const stamp = await lstat(path).catch(() => undefined)
              if (stamp && Date.now() - stamp.mtimeMs < 15000) recentFiles.set(key,stamp.mtimeMs)
              if (tracing && stamp && Date.now() - stamp.mtimeMs < 5000)
                timing('inventory-seen',undefined,{source:sourceTag(path),bytes:stamp.size})
            }
          }
        }
      }
      for (const r of roots) {
        if (!(await safeTarget(r.root).catch(() => false))) continue
        const st = await lstat(r.root).catch(() => undefined)
        if (st?.isFile()) {
          const s = candidate(r,r.root)
          if (s) pending.set(s.adapter + ':' + s.path,s)
        } else if (st?.isDirectory()) await visit(r,r.root,r.adapter==='zcode'?8:0).catch(() => undefined)
      }
      for (const adapter of sessionAdapters) for (const path of this.store.paths(adapter)) {
        const matching = roots.filter(r => r.adapter === adapter && within(r.root,path))
        if (!matching.length) { if(!this.held())this.store.remove({ adapter,path, archive:false,compressed:false }) }
        else if (!pending.has(adapter + ':' + path)) {
          const s = candidate(matching[0],path)
          if (s) pending.set(adapter + ':' + path,s)
        }
      }
      timing('inventory',inventoryStarted)
    }
    if (this.inventoryNeeded) this.schedule(15)
    // Prioritize recent notifications; each file gets at most one chunk per cycle.
    const priority = (key: string, source: Source) => notified.has(key) ? 3 :
      recentFiles.has(key) ? 2 : roots.some(r => r.root === source.path) ? 1 : 0
    const recent = [...pending].sort(([a,x],[b,y]) =>
      priority(b,y) - priority(a,x) || (recentFiles.get(b) ?? 0) - (recentFiles.get(a) ?? 0))
    const sliceEnd = Date.now() + 180
    for (let i=0; i<recent.length; i++) {
      const [key,s] = recent[i]
      if (this.closed || this.roots !== roots) break
      if (i && Date.now() >= sliceEnd) {
        for (const [remaining,source] of recent.slice(i)) {
          if (!this.changed.has(remaining)) this.changed.set(remaining,source)
          if (notified.has(remaining)) this.notified.add(remaining)
        }
        this.schedule(15)
        break
      }
      try {
        const root = roots.find(r => r.adapter === s.adapter && within(r.root,s.path))
        if (!root || !(await safeRoot(dirname(s.path)))) continue
        const st = await lstat(s.path)
        if (!st.isFile() || st.isSymbolicLink()) continue
        const sig = [st.size,st.mtimeMs,st.ctimeMs].join(':')
        const prev = this.quiet.get(key)
        const q = prev?.signature === sig ? prev : { signature:sig,since:Date.now() }
        if (s.compressed) this.quiet.set(key,q)
        const readStarted = Date.now()
        const result = s.adapter === 'zcode' && /\.sqlite$/i.test(s.path) ? await scanZCode(s,this.store.cursor(s))
          : await scan({ ...s, archive: root.archive },this.store.cursor(s),Date.now() - q.since >= QUIET)
        if (this.closed || this.roots !== roots) break
        if (result.batch) {
          const source = sourceTag(s.path)
          timing('read',readStarted,{source,bytes:result.metrics.bytes,events:result.batch.events.length})
          const applyStarted = Date.now()
          if(this.held())return
          this.store.apply(result.batch,tracing ? started=>timing('apply-usage',started,{source}) : undefined)
          timing('apply',applyStarted,{source,events:result.batch.events.length})
          this.dayCache = undefined
        }
        if (result.metrics.bytes || result.metrics.reset || result.metrics.sessionsRead) {
          this.metrics.push(result.metrics)
          if (this.metrics.length > 500) this.metrics.splice(0,1)
        }
        if (result.metrics.pending) {
          if (!this.changed.has(key)) this.changed.set(key,s)
          this.schedule(s.compressed && !result.batch ? QUIET : 15)
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' && !this.closed && this.roots === roots) {
          this.quiet.delete(key)
          if(!this.held())this.store.remove(s)
        }
      }
    }
  }
  // Available to main-process development tests; no paths or transcript are broadcast.
  scanMetrics() { return [...this.metrics] }
  async close() {
    this.closed = true
    clearTimeout(this.debounce); clearInterval(this.periodic)
    await this.watcher?.close()
    await this.active?.catch(() => undefined)
    this.store.close()
  }
}
