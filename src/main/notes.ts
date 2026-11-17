import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import {
  closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { watch, type FSWatcher } from 'chokidar'
import { DEFAULT_PROJECT, NOTE_TEMPLATES, type DraftRecovery, type DraftSummary, type SearchMatch, type SearchResult, type LinkBinding, type LinkIndex, type Note, type NoteEdge, type NoteFilters, type NoteSummary, type NoteTemplate, type ProjectSummary, type SaveResult } from '../shared/ipc'
import { isUuid, linkCatalog, resolveLink, uuidV4 } from '../shared/link-resolution'
import { runManaged } from './managed-delete-file'
import { scanWiki, markdownSource } from '../shared/wiki-markdown'
import type { Scope, Source } from '../shared/p12'
import type { SourceNote, WikiLink } from './export-planner'
import { noteMetadata } from './note-metadata'
import { plateTitleLine } from '../shared/plate-title'
import { Journal } from './p11-journal'
import type { ProjectDetail, ProjectFields, Receipt } from '../shared/p11'
import type { NoteIndexAction, NoteIndexStage, NoteIndexState } from '../shared/note-index'
import { fileSnapshot, identity, pinIndexRoot, readStartupIndex, type Snapshot } from './note-index-reader'

const conflictName = /-conflict-\d{8}T\d{9}Z\.md$/
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const checkProject = (id: string) => {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) || reservedName.test(id)) {
    throw new Error('项目 ID 无效')
  }
}
const checkId = (id: string) => {
  if (typeof id !== 'string' || !uuidV4.test(id)) throw new Error('笔记 ID 无效')
}

function snapshot(path: string) {
  try {
    if (!lstatSync(path).isFile()) throw new Error('笔记路径不是普通文件')
    const fd = openSync(path, 'r')
    try {
      const before = fstatSync(fd, { bigint: true })
      const bytes = readFileSync(fd)
      const after = fstatSync(fd, { bigint: true })
      const current = lstatSync(path, { bigint: true })
      const stamp = (stat: typeof before) => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      if (!current.isFile() || stamp(before) !== stamp(after) || stamp(after) !== stamp(current) || identity(after) !== identity(current)) {
        throw new Error('文件正在被其他程序写入，请稍后重试')
      }
      return fileSnapshot(bytes, after)
    } finally { closeSync(fd) }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function writeNewFile(path: string, content: string | Uint8Array) {
  const fd = openSync(path, 'wx')
  try {
    try {
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
}

type IndexedNote = { note: NoteSummary; revision: string; body: string; metadata: Omit<ReturnType<typeof noteMetadata>, 'body'> }
type LegacyLinks = { catalog: ReturnType<typeof linkCatalog>; edges: Set<string> }
const columns = 'id, path, title, project_id AS projectId, kind, created_at AS createdAt, updated_at AS updatedAt'
const draftColumns = `note_id AS id, path, title, project_id AS projectId, kind,
  created_at AS createdAt, written_at AS writtenAt, base_revision AS revision, version, content`
type StoredDraft = Omit<DraftSummary, 'source'> & Pick<NoteSummary, 'projectId' | 'kind' | 'createdAt'> & { content: string }
type DraftCopy = { path: string; identity: string | null; revision: string | null; copyId: string | null }

export class NoteStore {
  private readonly projectsDir: string
  private readonly db: Database.Database
  readonly projectJournal: Journal
  private readonly indexed = new Map<string, IndexedNote>()
  private readonly opened = new Map<string, NoteSummary & { revision: string }>()
  private readonly readRevisions = new Map<string, Map<string, NoteSummary>>()
  private readonly pending = new Set<string>()
  private watcher?: FSWatcher
  private watching?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private scanNeeded = false
  private stopping = false
  private readonly verifyIndexRoot: () => void
  private startup: NoteIndexState = { phase: 'waiting', run: 0, sequence: 0 }
  private controller?: AbortController

  constructor(root: string, private readonly onChanged: (path: string, external: boolean) => void, deferScan=false,
    private readonly held=()=>false, private readonly onProgress:(state:NoteIndexState)=>void=()=>{}) {
    this.projectsDir = join(root, 'projects')
    mkdirSync(this.projectsDir, { recursive: true })
    if (!lstatSync(this.projectsDir).isDirectory()) throw new Error('projects 必须是普通目录')
    const indexPath = join(root, 'index.sqlite')
    this.db = new Database(localSqlitePath(indexPath), { timeout: 1000 })
    try {
      this.verifyIndexRoot = pinIndexRoot(root, this.projectsDir, indexPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = FULL')
      this.projectJournal = new Journal(this.db)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, color TEXT,
          archived_at INTEGER, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note (
          id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES project(id), kind TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note_link (
          source_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,
          target_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,
          PRIMARY KEY (source_note_id, target_note_id)
        );
        CREATE TABLE IF NOT EXISTS note_tag (
          note_id TEXT REFERENCES note(id) ON DELETE CASCADE, tag TEXT,
          PRIMARY KEY (note_id, tag)
        );
        CREATE INDEX IF NOT EXISTS note_project_updated ON note(project_id, updated_at);
        CREATE INDEX IF NOT EXISTS note_link_target ON note_link(target_note_id);
        CREATE INDEX IF NOT EXISTS note_tag_value ON note_tag(tag);
      `)
      this.db.exec(`CREATE TABLE IF NOT EXISTS p11_project (
      id TEXT PRIMARY KEY REFERENCES project(id), root TEXT NOT NULL, color TEXT NOT NULL
        CHECK(color IN ('default','blue','green','amber','red')), revision INTEGER NOT NULL
    ) STRICT;`)
      this.db.exec('CREATE TABLE IF NOT EXISTS m43_removed_project(id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS m43_removed_note(id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
      this.migrateDrafts()
      this.db.exec(`CREATE TABLE IF NOT EXISTS note_draft_copy (
        draft_id TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        identity TEXT, revision TEXT, copy_id TEXT, PRIMARY KEY(draft_id, version)
      )`)
      this.ensureProject(DEFAULT_PROJECT)
      if (!deferScan) {
        this.scan(this.readLegacyLinks())
        this.startup = { ...this.startup, phase: 'ready' }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrateDrafts() {
    this.db.transaction(() => {
      const hasDrafts = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_draft'").get()
      if (hasDrafts && !this.db.prepare("SELECT 1 FROM pragma_foreign_key_list('note_draft')").get()) return
      if (hasDrafts) this.db.exec('ALTER TABLE note_draft RENAME TO note_draft_legacy')
      this.db.exec(`CREATE TABLE note_draft (
        note_id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
        project_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
        base_revision TEXT NOT NULL, content TEXT NOT NULL, written_at INTEGER NOT NULL,
        version TEXT NOT NULL
      )`)
      if (hasDrafts) this.db.exec(`INSERT INTO note_draft
        SELECT d.note_id, n.path, n.title, n.project_id, n.kind, n.created_at,
          d.base_revision, d.content, d.written_at, lower(hex(randomblob(16)))
        FROM note_draft_legacy d LEFT JOIN note n ON n.id = d.note_id;
        DROP TABLE note_draft_legacy;`)
    })()
  }

  projectFolder(id:string){checkProject(id);return join(this.projectsDir,id)}
  deleteDatabase(){return this.db}

  rescanAfterRemoval() {
    // Keep this refresh synchronous. Invalidate any older startup snapshot
    // before consulting the removal tombstones and the surviving Markdown.
    this.controller?.abort()
    this.controller=undefined
    this.indexed.clear()
    this.scan(this.readLegacyLinks())
    for(const id of this.opened.keys()){
      if(this.db.prepare('SELECT 1 FROM m43_removed_note WHERE id=?').get(id)){
        this.opened.delete(id);this.readRevisions.delete(id)
      }
    }
    if (this.startup.phase !== 'ready') this.setStartup({ phase:'ready' })
    this.onChanged(this.projectsDir,false)
  }

  private readLegacyLinks(): LegacyLinks | undefined {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_link_binding'").get()) return
    const catalog = linkCatalog(this.list())
    const edges = new Set((this.db.prepare('SELECT source_note_id AS source, target_note_id AS target FROM note_link').all() as NoteEdge[])
      .map(({ source, target }) => source + target))
    return { catalog, edges }
  }

  indexStatus() { return this.startup }

  assertIndexReady() {
    if (this.startup.phase !== 'ready') throw new Error('笔记索引未就绪，当前操作暂不可提交。请完成笔记索引后再试。')
  }

  private setStartup(stage:NoteIndexStage, run=this.startup.run) {
    this.startup = { ...stage, run, sequence: this.startup.sequence + 1 }
    this.onProgress(this.startup)
  }

  cancelStartup(run:number): NoteIndexAction {
    if (run !== this.startup.run || !['waiting','collecting','reading'].includes(this.startup.phase))
      return { accepted:false, state:this.startup }
    this.controller?.abort()
    this.controller=undefined
    this.setStartup({ phase:'cancelled' })
    return { accepted:true, state:this.startup }
  }

  restartStartup(run:number): NoteIndexAction {
    if (run !== this.startup.run || this.stopping || !['waiting','cancelled','failed','blocked'].includes(this.startup.phase))
      return { accepted:false, state:this.startup }
    if (this.held()) {
      this.setStartup({ phase:'blocked' })
      return { accepted:false, state:this.startup }
    }
    const controller = this.controller = new AbortController()
    this.setStartup({ phase:'collecting', found:0 }, run+1)
    void this.buildStartup(controller)
    return { accepted:true, state:this.startup }
  }

  private async buildStartup(controller:AbortController) {
    const current=()=>!this.stopping && this.controller===controller && !controller.signal.aborted
    const version=()=>this.db.pragma('data_version', { simple:true })
    try {
      this.verifyIndexRoot()
      await this.startWatching()
      if (!current()) return
      this.verifyIndexRoot()
      const before = version()
      const saved = this.db.prepare('SELECT path FROM note').all() as { path: string }[]
      if (saved.some(({path})=>!this.identify(path))) throw new Error('已有笔记索引不属于当前项目目录')
      const pending = new Set((this.db.prepare(`SELECT c.path FROM note_draft_copy c JOIN note_draft d
        ON d.note_id=c.draft_id AND d.version=c.version WHERE c.copy_id IS NULL`).all() as {path:string}[]).map(x=>x.path))
      const removed = new Set((this.db.prepare('SELECT id FROM m43_removed_note').all() as {id:string}[]).map(x=>x.id))
      const manifest = await readStartupIndex(this.projectsDir, {
        known:new Set(saved.map(x=>x.path)),
        project:name=>{try {checkProject(name);return true} catch {return false}},
        accepts:path=>{
          const file=this.identify(path)
          return !!file && !pending.has(path) && (file.id===null || !removed.has(file.id))
        }
      }, controller.signal, stage=>{ if (current()) this.setStartup(stage) })
      if (!current()) return
      if (this.held()) { this.setStartup({ phase:'blocked' }); return }
      this.setStartup({ phase:'committing', read:manifest.files.size })
      await yieldTurn()
      if (!current()) return
      const validate = () => {
        if (this.held()) throw new Error('工作区删除结果待核对')
        this.verifyIndexRoot()
        if (version() !== before) throw new Error('已提交的笔记索引或草稿发生变化，请重新开始')
      }
      validate()
      // Match the synchronous scan's existing-row-first order, including
      // stable conflict-copy identities and its duplicate UUID precedence.
      const paths = [...new Set([...saved.map(x=>x.path), ...manifest.files.keys()])].filter(path=>!pending.has(path))
      this.refresh(paths, paths.map(path=>manifest.files.get(path)??null), this.readLegacyLinks(), undefined, {
        before:validate, after:()=>{ manifest.verify();validate() }
      })
      this.setStartup({ phase:'ready' })
      this.onChanged(this.projectsDir,false)
      this.scheduleRefresh()
    } catch (error) {
      if (current()) {
        if (this.held()) this.setStartup({ phase:'blocked' })
        else this.setStartup({ phase:'failed', message:error instanceof Error ? error.message : String(error) })
      }
    } finally {
      if (this.controller===controller) this.controller=undefined
    }
  }

  startWatching() {
    return this.watching ??= this.openWatcher().catch(async error=>{
      try { await this.watcher?.close() } finally { this.watcher=undefined;this.watching=undefined }
      throw error
    })
  }

  private async openWatcher() {
    const watcher = this.watcher = watch(this.projectsDir, {
      followSymlinks: false, depth: 1, atomic: true, ignoreInitial: true,
      ignored: (path, stats) => stats?.isFile() === true && !this.identify(path)
    })
    await new Promise<void>((ready, reject) => {
      watcher.once('error', reject)
      watcher.once('ready', () => { watcher.off('error', reject); ready() })
      watcher.on('error', (error) => console.error('笔记目录监听失败：', error))
      watcher.on('all', (event, watchedPath) => {
        if (this.stopping) return
        const path = resolve(watchedPath)
        if (event === 'addDir' || event === 'unlinkDir') this.scanNeeded = true
        else if (this.identify(path)) this.pending.add(path)
        else return
        this.scheduleRefresh()
      })
    })
  }

  async close() {
    this.stopping = true
    this.controller?.abort()
    this.controller=undefined
    clearTimeout(this.timer)
    try { await this.watcher?.close() } finally { this.db.close() }
  }

  projectDetails(): ProjectDetail[] {
    return this.db.prepare(`SELECT p.id,p.name,p.archived_at archivedAt,coalesce(s.root,'') root,
      coalesce(s.color,'default') color,coalesce(s.revision,0) revision
      FROM project p LEFT JOIN p11_project s USING(id) ORDER BY p.created_at,p.id`).all() as ProjectDetail[]
  }

  projectWrite(id:string|undefined, revision:number|undefined, fields:ProjectFields|undefined, archived:boolean|undefined,
    operation:string, verify:()=>boolean) {
    return this.db.transaction(() => {
      const before=this.projectDetails().find(p=>p.id===id)
      if ((id && (!before || id===DEFAULT_PROJECT || before.revision!==revision)) || !verify()) {
        return this.projectJournal.finish(operation,{status:'unchanged',message:'项目或影响已变化，请重新读取。'})
      }
      const target=id ?? randomUUID()
      if (!before) {
        // The managed folder is created lazily by the existing note creation path.
        this.db.prepare('INSERT INTO project (id,name,root_path,created_at) VALUES (?,?,?,?)')
          .run(target,fields!.name,join(this.projectsDir,target),Date.now())
      } else if (fields) this.db.prepare('UPDATE project SET name=? WHERE id=?').run(fields.name,target)
      else this.db.prepare('UPDATE project SET archived_at=? WHERE id=?').run(archived ? Date.now():null,target)
      this.db.prepare(`INSERT INTO p11_project VALUES(?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET root=excluded.root,color=excluded.color,revision=revision+1`)
        .run(target,fields?.root ?? before?.root ?? '',fields?.color ?? before?.color ?? 'default')
      const project=this.projectDetails().find(p=>p.id===target)!
      return this.projectJournal.finish(operation,{status:'saved',message:'项目已更新。',project} satisfies Receipt)
    }).immediate()
  }

  p11Note(id:string,path:string,revision:string) {
    const row=this.db.prepare(`SELECT ${columns} FROM note WHERE id=? AND path=?`).get(id,path) as NoteSummary|undefined
    if (!row || this.getDraft(id) || this.readPath(path)?.revision!==revision) return undefined
    const stat=lstatSync(path)
    return stat.nlink===1 && stat.isFile() && this.effectiveProject(this.identify(path)?.projectId)===row.projectId ? row : undefined
  }

  projects(): ProjectSummary[] {
    return this.projectDetails().filter(p=>p.id!==DEFAULT_PROJECT).map(({id,name,archivedAt,color,revision})=>({id,name,archivedAt,color,revision}))
  }

  createProject(name: string): ProjectSummary {
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\r\n\u0000]/.test(name)) {
      throw new Error('请输入 1–120 个字符的单行项目名称')
    }
    const id = randomUUID()
    this.ensureProject(id, name.trim())
    return { id, name: name.trim(), archivedAt: null }
  }

  create(title: string, projectId: string, template: NoteTemplate = 'blank'): Note {
    if (typeof title !== 'string' || title.length > 240 || /[\r\n\u0000]/.test(title)) {
      throw new Error('请输入 1–240 个字符的单行标题')
    }
    if (typeof template !== 'string' || !Object.hasOwn(NOTE_TEMPLATES, template)) throw new Error('笔记模板无效')
    checkProject(projectId)
    if (this.db.prepare('SELECT 1 FROM project WHERE id = ? AND archived_at IS NOT NULL').get(projectId)) {
      throw new Error('不能在已归档项目中新建笔记')
    }
    const dir = this.ensureProject(projectId)
    const path = join(dir, `${randomUUID()}.md`)
    writeNewFile(path, title.trim() ? `# ${title.trim()}\n\n${NOTE_TEMPLATES[template].body}`
      : plateTitleLine('') + NOTE_TEMPLATES[template].body)
    return this.indexWrite(path)
  }

  directory(id: string): string {
    return dirname(this.get(id).path)
  }

  // Fresh reads that do not consult the rebuildable index for identity.
  delegationSources(): { files: Map<string, { path: string; noteId: string | null; disk: Snapshot }>; stable: () => boolean } {
    const enumerate = () => {
      const paths: string[] = []
      if (!lstatSync(this.projectsDir).isDirectory()) throw new Error('projects 必须是普通目录')
      for (const dir of readdirSync(this.projectsDir, { withFileTypes: true })) {
        try { checkProject(dir.name) } catch { continue }
        if (dir.isSymbolicLink()) throw new Error('无法核对链接项目中的任务标记')
        if (!dir.isDirectory()) continue
        const project = join(this.projectsDir, dir.name)
        for (const file of readdirSync(project, { withFileTypes: true })) {
          if (!/\.md$/i.test(file.name)) continue
          if (!file.isFile()) throw new Error('无法核对非普通 Markdown 文件中的任务标记')
          paths.push(join(project, file.name))
        }
      }
      return paths.sort()
    }
    const read = (path: string) => {
      if (!lstatSync(this.projectsDir).isDirectory() || !lstatSync(dirname(path)).isDirectory()) throw new Error('项目路径已变更')
      const disk = snapshot(path)
      if (!disk?.validUtf8 || disk.content.includes('\0')) throw new Error('无法核对未读完或非 UTF-8 的笔记')
      return disk
    }
    const paths = enumerate()
    const files = new Map(paths.map(path => [path, { path, noteId: this.identify(path)?.id ?? null, disk: read(path) }]))
    return { files, stable: () => {
      const latest = enumerate()
      return latest.length === paths.length && latest.every((path, i) =>
        path === paths[i] && read(path).revision === files.get(path)!.disk.revision)
    } }
  }

  delegationEditable(id: string, path: string, revision: string) {
    const opened = this.opened.get(id)
    return opened?.path === path && opened.revision === revision && !this.getDraft(id)
  }

  // Auxiliary edits must fail closed: never route them through keepBoth or discard a draft.
  writeTaskAnchor(id: string, path: string, revision: string, next: string, verify: () => boolean): Note | undefined {
    if (!this.delegationEditable(id, path, revision)) return undefined
    const temp = join(dirname(path), `.${randomUUID()}.notes-tmp`)
    writeNewFile(temp, next)
    try {
      if (!verify() || this.readPath(path)?.revision !== revision) return undefined
      renameSync(temp, path)
    } finally { rmSync(temp, { force: true }) }
    const note = this.indexWrite(path)
    if (note.id !== id || note.content !== next) throw new Error('标记保存后检测到外部修改，请读取磁盘版本')
    return note
  }

  // Run after a durable intent is registered. Record the staged file identity
  // before the final proof so restart can distinguish our rename from a copy.
  writeDelegationResult(id: string, path: string, revision: string, bytes: Uint8Array,
    verify: () => boolean, staged: (identity: string) => void): Note | undefined {
    if (!this.delegationEditable(id, path, revision)) return
    const temp = join(dirname(path), `.${randomUUID()}.notes-tmp`)
    writeNewFile(temp, bytes)
    try {
      const file = snapshot(temp)
      if (!file || !file.bytes.equals(bytes)) throw new Error('Staged bytes changed')
      staged(file.identity)
      const latest = () => this.delegationEditable(id, path, revision) && this.readPath(path)?.revision === revision
      if (!verify() || !latest() || snapshot(temp)?.revision !== file.revision) return
      if (!latest()) return
      renameSync(temp, path)
      const committed = this.readPath(path)
      if (committed?.identity !== file.identity || !committed.bytes.equals(bytes)) throw new Error('Committed revision changed')
    } finally { rmSync(temp, { force: true }) }
    const result = this.indexWrite(path)
    if (result.id !== id || result.content !== Buffer.from(bytes).toString('utf8')) throw new Error('Cannot verify committed note')
    return result
  }

  delegationDraft(id: string) { return !!this.getDraft(id) }

  bitmapDirectory(id: string) {
    const note = this.get(id)
    if (!this.readPath(note.path)) throw new Error('原笔记不在授权目录中')
    return dirname(note.path)
  }

  read(id: string): Note {
    const row = this.get(id)
    const disk = this.readPath(row.path)
    if (!disk) {
      const indexed = this.indexed.has(row.path)
      this.refresh([row.path])
      if (indexed) this.onChanged(row.path, true)
      throw new Error('笔记文件已在磁盘上移除')
    }
    const changed = this.indexed.get(row.path)?.revision !== disk.revision
    const next = this.open(this.refresh([row.path], [disk])[0]!, disk)
    if (changed) this.onChanged(row.path, true)
    return next
  }

  update(id: string, content: string, revision?: string, draftVersion?: string): SaveResult {
    if (typeof content !== 'string') throw new Error('正文必须是文本')
    checkId(id)
    id = id.toLowerCase()
    const expected = this.expected(id, revision)
    const row = this.readRevisions.get(id)?.get(expected) ?? this.get(id)
    const draft = this.getDraft(id)
    const cleanup = draft?.path === row.path && draft.revision === expected && draft.content === content &&
      (draftVersion === undefined || draft.version === draftVersion) ? draft.version : undefined
    const disk = this.readPath(row.path)
    const finish = (result: SaveResult): SaveResult => {
      if (cleanup) this.draftDiscard(id, cleanup)
      return result
    }
    if (disk?.revision !== expected) return finish(this.keepBoth(row, content))
    if (disk.content === content) return finish({ status: 'saved', note: this.open(row, disk) })

    const temp = join(dirname(row.path), `.${randomUUID()}.notes-tmp`)
    writeNewFile(temp, content)
    try {
      const latest = this.readPath(row.path)
      if (latest?.revision !== expected) return finish(this.keepBoth(row, content))
      renameSync(temp, row.path)
    } finally { rmSync(temp, { force: true }) }
    return finish({ status: 'saved', note: this.indexWrite(row.path) })
  }

  delete(id: string, revision?: string): 'deleted' | 'changed' {
    checkId(id)
    const opened = this.opened.get(id.toLowerCase())
    const row = revision !== undefined && opened?.revision === revision ? opened : this.get(id)
    const expected = revision === undefined ? this.opened.get(row.id)?.revision : this.expected(row.id, revision)
    const disk = this.readPath(row.path)
    if (disk && expected !== undefined && disk.revision !== expected) {
      this.refresh([row.path], [disk])
      this.onChanged(row.path, true)
      return 'changed'
    }
    if (disk) rmSync(row.path, { force: true })
    this.opened.delete(row.id)
    this.readRevisions.delete(row.id)
    this.db.prepare('DELETE FROM note_draft WHERE note_id = ? AND path = ?').run(row.id, row.path)
    this.afterMutation([row.path])
    return 'deleted'
  }

  draftWrite(id: string, content: string, revision: string, version = randomUUID()): boolean {
    checkId(id)
    id = id.toLowerCase()
    const base = this.expected(id, revision)
    if (typeof content !== 'string') throw new Error('草稿必须是文本')
    checkId(version)
    const row = this.readRevisions.get(id)?.get(base)
    if (!row) return false
    const prior = this.getDraft(id)
    if (prior && (prior.path !== row.path || prior.revision !== base)) throw new Error('请先处理现有恢复草稿')
    this.db.prepare(`INSERT INTO note_draft VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id) DO UPDATE SET content=excluded.content, written_at=excluded.written_at, version=excluded.version`)
      .run(row.id, row.path, row.title, row.projectId, row.kind, row.createdAt, base, content, Date.now(), version)
    return true
  }

  draftDiscard(id: string, version: string): boolean {
    checkId(id)
    if (typeof version !== 'string' || !version) throw new Error('请重新核对草稿')
    return this.db.prepare('DELETE FROM note_draft WHERE note_id = ? AND version = ?').run(id.toLowerCase(), version).changes === 1
  }

  draftList(): DraftSummary[] {
    const rows = this.db.prepare(`SELECT ${draftColumns} FROM note_draft ORDER BY written_at DESC`).all() as StoredDraft[]
    return rows.map((draft) => this.inspectDraft(draft).summary)
  }

  draftRestore(id: string): DraftRecovery {
    checkId(id)
    id = id.toLowerCase()
    const draft = this.getDraft(id)
    if (!draft) return { status: 'missing' }
    const { summary, row, disk } = this.inspectDraft(draft)
    if (summary.source === 'unchanged' && row && disk) {
      return { status: 'restored', note: { ...row, content: disk.content, revision: disk.revision }, content: draft.content, version: draft.version }
    }
    return { status: 'preview', draft: summary, content: draft.content, diskRevision:disk?.revision ?? null }
  }

  draftSaveCopy(id: string, version: string, expected?: {source:DraftSummary['source'];diskRevision:string|null}): Note {
    checkId(id)
    id = id.toLowerCase()
    const lookup = () => this.db.prepare(`SELECT path, identity, revision, copy_id AS copyId FROM note_draft_copy
      WHERE draft_id = ? AND version = ?`).get(id, version) as DraftCopy | undefined
    let attempt = lookup()
    if (attempt?.copyId) {
      const disk = this.readPath(attempt.path)
      const row = this.db.prepare(`SELECT ${columns} FROM note WHERE id = ? AND path = ?`).get(attempt.copyId, attempt.path) as NoteSummary | undefined
      if (disk && row && disk.identity === attempt.identity && disk.revision === attempt.revision) return this.open(row, disk)
      throw new Error(`已完成的草稿副本已移动或变化，请检查：${attempt.path}。不会重复创建。`)
    }
    const draft = this.getDraft(id)
    if (!draft || draft.version !== version) throw new Error('草稿已变化，请重新核对')
    const { summary, row, disk } = this.inspectDraft(draft)
    if (expected && (expected.source!==summary.source || expected.diskRevision!==(disk?.revision ?? null)))
      throw new Error('磁盘版本或文件身份已变化，请取消并重新核对草稿。'+(attempt?`本次副本路径：${attempt.path}`:''))
    if (!attempt) {
      const dir = this.ensureProject(row && summary.source === 'changed' ? row.projectId : DEFAULT_PROJECT)
      let time = Date.now()
      let path: string
      do { path = this.conflictPath(dir, draft.title, time++) }
      while (this.readPath(path) || this.db.prepare('SELECT 1 FROM note_draft_copy WHERE path = ?').get(path))
      // Reserve the intent before touching disk. A path without an observed
      // file identity must never be adopted, even if its bytes match the draft.
      this.db.prepare('INSERT INTO note_draft_copy(draft_id,version,path) VALUES (?,?,?)').run(id, version, path)
      attempt = lookup()!
    }
    const { path } = attempt
    let copyDisk: Snapshot | null
    try {
      copyDisk = this.readPath(path)
      if (!attempt.identity && !copyDisk) {
        const fd = openSync(path, 'wx')
        try {
          const file = fstatSync(fd, { bigint: true })
          const identity = `${file.dev}:${file.ino}:${file.birthtimeNs}`
          this.db.prepare('UPDATE note_draft_copy SET identity=? WHERE draft_id=? AND version=?').run(identity, id, version)
          attempt.identity = identity
          writeFileSync(fd, draft.content, 'utf8')
          fsyncSync(fd)
        } finally { closeSync(fd) }
        copyDisk = this.readPath(path)
      }
      const hash = createHash('sha256').update(draft.content,'utf8').digest('hex')
      if (!copyDisk || !attempt.identity || copyDisk.identity !== attempt.identity ||
        (attempt.revision ? copyDisk.revision !== attempt.revision : !copyDisk.revision.endsWith(`:${hash}`))) {
        throw new Error('无法核对文件身份或正文，保留草稿和磁盘现状；请检查该路径。')
      }
      // Record the immutable revision before indexing, which can fail or be
      // retried on the next launch. A later file at the same path is not ours.
      if (!attempt.revision) this.db.prepare('UPDATE note_draft_copy SET revision=? WHERE draft_id=? AND version=?').run(copyDisk.revision, id, version)
    } catch (failure) {
      throw new Error(`无法核对本次草稿副本，请先检查：${path}。草稿已保留。${String(failure)}`)
    }
    try {
      const [copy] = this.refresh([path], [copyDisk], undefined, ([indexed])=>{
        const verified = this.readPath(path)
        if (!indexed || verified?.revision !== copyDisk.revision || verified.identity !== copyDisk.identity) {
          throw new Error('副本在核对时发生变化')
        }
        if (!this.draftDiscard(id, version)) throw new Error('草稿已变化，请重新核对')
        this.db.prepare('UPDATE note_draft_copy SET copy_id=? WHERE draft_id=? AND version=?').run(indexed.id, id, version)
      })
      this.pending.add(path)
      this.scheduleRefresh(350)
      this.onChanged(path, false)
      return this.open(copy!, copyDisk)
    } catch (failure) {
      throw new Error(`冲突副本已写入，请先检查：${path}。请重试核对同一副本。${String(failure)}`)
    }
  }

  private getDraft(id: string) {
    return this.db.prepare(`SELECT ${draftColumns} FROM note_draft WHERE note_id = ?`).get(id) as StoredDraft | undefined
  }

  private inspectDraft(draft: StoredDraft) {
    const { id, path, title, revision, version, writtenAt } = draft
    const row = this.db.prepare(`SELECT ${columns} FROM note WHERE id = ? AND path = ?`).get(id, path) as NoteSummary | undefined
    let disk: Snapshot | null = null
    let source: DraftSummary['source'] = 'missing'
    try {
      disk = this.readPath(path)
      if (disk) {
        const sameFile = row && disk.revision.split(':', 1)[0] === revision.split(':', 1)[0]
        source = sameFile && disk.content === draft.content ? 'same-content'
          : row && disk.revision === revision ? 'unchanged' : 'changed'
      }
    } catch { source = 'unavailable' }
    return { summary: { id, path, title, revision, version, writtenAt, source } satisfies DraftSummary, row, disk }
  }

  tags(): string[] {
    return (this.db.prepare('SELECT DISTINCT tag FROM note_tag ORDER BY tag').all() as { tag: string }[]).map(({ tag }) => tag)
  }

  list(filters: NoteFilters = {}): NoteSummary[] {
    return this.search(filters).map(({ note }) => note)
  }

  search(filters: NoteFilters = {}): SearchResult[] {
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) throw new Error('筛选条件无效')
    const predicates: string[] = []
    const params: string[] = []
    const add = (sql: string, value: string) => { predicates.push(sql); params.push(value) }
    if (filters.projectId !== undefined) { checkProject(filters.projectId); add('project_id = ?', filters.projectId) }
    if (filters.kind !== undefined) {
      if (filters.kind !== 'note' && filters.kind !== 'conflict') throw new Error('笔记类型无效')
      add('kind = ?', filters.kind)
    }
    if (filters.tags !== undefined && (!Array.isArray(filters.tags) || filters.tags.length > 64)) throw new Error('标签无效')
    for (const tag of new Set([...(filters.tags ?? []), ...(filters.tag === undefined ? [] : [filters.tag])])) {
      if (typeof tag !== 'string') throw new Error('标签无效')
      add('id IN (SELECT note_id FROM note_tag WHERE tag = ?)', tag.trim().replace(/^#/, '').normalize('NFKC').toLowerCase())
    }
    if (filters.linksTo !== undefined) {
      checkId(filters.linksTo)
      add('id IN (SELECT source_note_id FROM note_link WHERE target_note_id = ?)', filters.linksTo.toLowerCase())
    }
    if (filters.linkedFrom !== undefined) {
      checkId(filters.linkedFrom)
      add('id IN (SELECT target_note_id FROM note_link WHERE source_note_id = ?)', filters.linkedFrom.toLowerCase())
    }
    const rows = this.db.prepare(`SELECT ${columns} FROM note ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id`).all(...params) as NoteSummary[]
    if (filters.query !== undefined && typeof filters.query !== 'string') throw new Error('搜索文字无效')
    const query = (filters.query ?? '').trim().normalize('NFKC')
    if (!query) return rows.map((note) => ({ note }))
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
    return rows.flatMap((note): SearchResult[] => {
      const find = (field: SearchMatch['field'], text: string): SearchMatch | undefined => {
        const hit = pattern.exec(text)
        if (!hit) return
        const at = hit.index
        const end = at + hit[0].length
        const oneLine = (part: string) => part.replace(/\s+/gu, ' ')
        return {
          field, before: (at > 18 ? '…' : '') + oneLine(text.slice(Math.max(0, at - 18), at)),
          match: oneLine(text.slice(at, end)),
          after: oneLine(text.slice(end, end + 35)) + (text.length > end + 35 ? '…' : '')
        }
      }
      const match = find('title', note.title.normalize('NFKC')) ?? find('body', this.indexed.get(note.path)?.body ?? '')
      return match ? [{ note, match }] : []
    })
  }

  exportSource(scope:Scope) {
    if(!scope || (scope.kind!=='note' && scope.kind!=='project'))throw new Error('无效导出范围')
    const rows=this.list()
    if(scope.kind==='note')checkId(scope.id);else checkProject(scope.id)
    const selected=scope.kind==='project'?rows.filter(r=>r.projectId===scope.id):rows.filter(r=>r.id===scope.id)
    if(scope.kind==='note'&&!selected.length)throw new Error('索引中已没有该笔记')
    const project=this.projectDetails().find(p=>p.id===(scope.kind==='project'?scope.id:selected[0].projectId))
    if(!project)throw new Error('索引中已没有该项目')
    const catalog=linkCatalog(rows)
    const bindings=new Map(this.bindings().map(x=>[JSON.stringify([x.source,x.ref]),x.target]))
    const bytes=new Map<string,Buffer>()
    const items:SourceNote[]=[]
    const summaries:Source['rows']=[]
    const identities:string[]=[]
    let size=0
    for(const row of selected.sort((a,b)=>a.id<b.id?-1:1)) {
      try {
        if(!this.identify(row.path))throw new Error('源路径不在受管 Markdown 范围')
        const capture=runManaged(0,row.path)
        if(!capture.bytes || !isUtf8(capture.bytes))throw new Error('源文件缺失或不是有效 UTF-8')
        size+=capture.bytes.length
        if(size>128*1024*1024)throw new Error('单次可核对快照容量为 128 MiB，请分批导出')
        const text=capture.bytes.toString('utf8')
        const md=markdownSource(text)
        const links=scanWiki(text,true).links.map((l):WikiLink=>{
          const resolved=resolveLink(catalog,l.ref,bindings.get(JSON.stringify([row.id,l.ref])))
          return {raw:md.slice(l.from,l.to),resolution:resolved.status==='resolved'?{kind:'resolved',targetNoteId:resolved.note.id}:
            resolved.status==='ambiguous'?{kind:'ambiguous',candidateNoteIds:resolved.candidates.map(n=>n.id)}:{kind:'broken'}}
        })
        const digest=createHash('sha256').update(capture.bytes).digest('hex')
        const revision=JSON.stringify([capture.parent,capture.identity,capture.stamp,digest])
        identities.push(revision)
        const stored=this.getDraft(row.id)
        summaries.push({...row,revision:digest,recovery:stored?.version??null})
        bytes.set(row.id,capture.bytes)
        items.push({noteId:row.id,sourceRelativePath:relative(dirname(this.projectsDir),row.path).split(sep).join('/'),links})
      } catch(e) {
        throw new Error(row.path+'：'+(e instanceof Error?e.message:String(e)))
      }
    }
    const fingerprint=createHash('sha256').update(JSON.stringify([project,summaries.map(({updatedAt,...r})=>r),identities,items])).digest('hex')
    const display:Source={project,rows:summaries,fingerprint}
    return {display,items,bytes}
  }

  private bindings(): LinkBinding[] {
    return this.db.prepare('SELECT source_note_id AS source, ref, target_note_id AS target FROM note_link_binding ORDER BY source, ref')
      .all() as LinkBinding[]
  }

  links(removedRefs?:string[]): LinkIndex {
    return {
      nodes: this.list().map(note=>{
        const meta=this.indexed.get(note.path)?.metadata
        return meta ? {...note,preview:meta.preview,tags:[...meta.tags]} : note
      }),
      edges: this.db.prepare('SELECT source_note_id AS source, target_note_id AS target FROM note_link ORDER BY source, target').all() as NoteEdge[],
      bindings: this.bindings(), removedRefs
    }
  }

  private expected(id: string, revision?: string) {
    const value = revision === undefined ? this.opened.get(id)?.revision : revision
    if (typeof value !== 'string' || !value || value.length > 256) throw new Error('请先打开笔记再保存')
    return value
  }

  private open(row: NoteSummary, disk: Snapshot): Note {
    const opened = { ...row, revision: disk.revision }
    this.opened.set(row.id, opened)
    const revisions = this.readRevisions.get(row.id) ?? new Map<string, NoteSummary>()
    revisions.delete(disk.revision)
    revisions.set(disk.revision, row)
    if (revisions.size > 8) revisions.delete(revisions.keys().next().value!)
    this.readRevisions.set(row.id, revisions)
    return { ...opened, content: disk.content }
  }

  private get(id: string) {
    checkId(id)
    const row = this.db.prepare(`SELECT ${columns} FROM note WHERE id = ?`).get(id.toLowerCase()) as NoteSummary | undefined
    if (row) return row
    // A deleted file may still have an open editor. Keep its draft recoverable.
    const opened = this.opened.get(id.toLowerCase())
    if (opened) return opened
    throw new Error('笔记不存在')
  }

  private readPath(path: string) {
    if (!this.identify(path)) throw new Error('笔记路径不在项目目录内')
    try {
      if (!lstatSync(this.projectsDir).isDirectory() || !lstatSync(dirname(path)).isDirectory()) {
        throw new Error('项目路径不是普通目录')
      }
      return snapshot(path)
    } catch (error) { if (isMissing(error)) return null; throw error }
  }

  private effectiveProject(id:string|undefined) {
    return id && this.db.prepare('SELECT 1 FROM m43_removed_project WHERE id=?').get(id) ? DEFAULT_PROJECT : id
  }

  private ensureProject(id: string, name = id === DEFAULT_PROJECT ? '默认项目' : id, createDirectory=true) {
    checkProject(id)
    if(this.effectiveProject(id)!==id)throw new Error('原项目已移除')
    const dir = join(this.projectsDir, id)
    if (!lstatSync(this.projectsDir).isDirectory()) throw new Error('projects 必须是普通目录')
    if (createDirectory) mkdirSync(dir, { recursive: true })
    if (!lstatSync(dir).isDirectory()) throw new Error('项目路径不是普通目录')
    this.db.prepare(`INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path WHERE root_path <> excluded.root_path`)
      .run(id, name, dir, Date.now())
    return dir
  }

  private identify(path: string) {
    const [projectId, name, ...rest] = relative(this.projectsDir, path).split(sep)
    if (rest.length || !name) return null
    try { checkProject(projectId) } catch { return null }
    const stem = name.replace(/\.md$/, '')
    if (stem !== name && uuidV4.test(stem)) return { projectId, id: stem.toLowerCase(), kind: 'note' as const }
    if (conflictName.test(name)) return { projectId, id: null, kind: 'conflict' as const }
    return null
  }

  private conflictPath(dir: string, name: string, time: number) {
    const title = Array.from(name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '')).slice(0, 60).join('') || '笔记'
    const timestamp = new Date(time).toISOString().replace(/[-:.]/g, '')
    return join(dir, `${title}-conflict-${timestamp}.md`)
  }

  private keepBoth(row: NoteSummary, content: string): Extract<SaveResult, { status: 'conflict' }> {
    const dir = this.ensureProject(row.projectId)
    let time = Date.now()
    for (;;) {
      const path = this.conflictPath(dir, row.title, time++)
      try { writeNewFile(path, content) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      try {
        const copyDisk = this.readPath(path)
        const currentDisk = this.readPath(row.path)
        const [copy, current] = this.afterMutation([path, row.path], [copyDisk, currentDisk])
        if (!copy || !copyDisk) throw new Error('未读到副本索引')
        return {
          status: 'conflict',
          current: current && currentDisk ? this.open(current, currentDisk) : null,
          copy: this.open(copy, copyDisk)
        }
      } catch (failure) {
        throw new Error(`冲突副本已写入，请先检查：${path}。${String(failure)}`)
      }
    }
  }

  private indexWrite(path: string) {
    const disk = this.readPath(path)
    const [row] = this.afterMutation([path], [disk])
    if (!row || !disk) throw new Error('文件保存后已被外部程序移除')
    return this.open(row, disk)
  }

  private afterMutation(paths: string[], snapshots?: (Snapshot | null)[]) {
    // An external create/delete burst can occur before the watcher has ever
    // seen the file. Recheck our own writes after the watcher has settled.
    for (const path of paths) this.pending.add(path)
    this.scheduleRefresh(350)
    try {
      const rows = this.refresh(paths, snapshots)
      for (const path of paths) this.onChanged(path, false)
      return rows
    } catch (error) {
      console.error('文件操作已完成，索引写入失败：', error)
      throw new Error('磁盘操作已完成，索引正在重新同步。请检查磁盘文件后再试。')
    }
  }

  private scan(legacy?: LegacyLinks) {
    const paths = new Set((this.db.prepare('SELECT path FROM note').all() as { path: string }[]).map(({ path }) => path))
    for (const dir of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      try { checkProject(dir.name) } catch { continue }
      const path = join(this.projectsDir, dir.name)
      try {
        for (const file of readdirSync(path, { withFileTypes: true })) {
          if (file.isFile() && this.identify(join(path, file.name))) paths.add(join(path, file.name))
        }
      } catch (error) { if (!isMissing(error)) throw error }
    }
    const list = [...paths].filter(path => !this.pendingDraftCopy(path))
    const previous = new Map(this.indexed)
    this.refresh(list, undefined, legacy)
    return list.filter((path) => previous.get(path)?.revision !== this.indexed.get(path)?.revision)
  }

  private pendingDraftCopy(path: string) {
    return this.db.prepare(`SELECT 1 FROM note_draft_copy c JOIN note_draft d ON d.note_id=c.draft_id AND d.version=c.version
      WHERE c.path=? AND c.copy_id IS NULL`).get(path) !== undefined
  }

  private scheduleRefresh(delay = 80) {
    if (this.stopping || this.timer || this.startup.phase!=='ready') return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if(this.held())return
      if (this.scanNeeded) {
        try {
          const changed = this.scan()
          this.scanNeeded = false
          for (const path of changed) this.onChanged(path, true)
        } catch (error) { console.error('笔记目录同步失败，稍后重试：', error) }
      }
      const refreshPending = (paths: string[]) => {
        for (const path of paths) if (this.pendingDraftCopy(path)) this.pending.delete(path)
        paths = paths.filter(path => this.pending.has(path))
        const before = paths.map((path) => this.indexed.get(path)?.revision)
        this.refresh(paths)
        paths.forEach((path, i) => {
          this.pending.delete(path)
          if (before[i] !== this.indexed.get(path)?.revision) this.onChanged(path, true)
        })
      }
      try { if (this.pending.size) refreshPending([...this.pending]) }
      catch {
        for (const path of this.pending) {
          try { refreshPending([path]) }
          catch (error) { console.error('笔记索引同步失败，稍后重试：', error) }
        }
      }
      if (this.pending.size || this.scanNeeded) this.scheduleRefresh(2000)
    }, delay)
  }

  private refresh(paths: string[], snapshots?: (Snapshot | null)[], legacy?: LegacyLinks,
    commit?: (rows:(NoteSummary|null)[])=>void, publish?:{before:()=>void;after:()=>void}): (NoteSummary | null)[] {
    const lookup = this.db.prepare(`SELECT ${columns} FROM note WHERE path = ?`)
    const changes = new Map<string, IndexedNote | null>()
    const rows = paths.map((path, i) => {
      const file = this.identify(path)
      const old = this.indexed.get(path)
      const ignored = file?.id && this.db.prepare('SELECT 1 FROM m43_removed_note WHERE id=?').get(file.id)
      const disk = file && !ignored ? (snapshots ? snapshots[i] : this.readPath(path)) : null
      if (!file || !disk) {
        if (old || lookup.get(path)) changes.set(path, null)
        return null
      }
      if (old?.revision === disk.revision) return old.note
      const existing = old?.note ?? lookup.get(path) as NoteSummary | undefined
      const { body, ...metadata } = noteMetadata(disk.content, basename(path, '.md'))
      const note: NoteSummary = {
        id: file.id ?? existing?.id ?? randomUUID(), path, title: metadata.title,
        projectId: this.effectiveProject(file.projectId)!, kind: file.kind, createdAt: existing?.createdAt ?? disk.createdAt,
        updatedAt: disk.updatedAt
      }
      changes.set(path, { note, revision: disk.revision, body: body.normalize('NFKC'), metadata })
      return note
    })
    if (!changes.size && !legacy && !publish) {
      if(commit)this.db.transaction(()=>commit(rows))()
      return rows
    }

    const next = new Map(this.indexed)
    for (const [path, entry] of changes) {
      if (entry) next.set(path, entry)
      else next.delete(path)
    }
    const persist=this.db.transaction(() => {
      publish?.before()
      if (legacy) this.db.exec(`CREATE TABLE note_link_binding (
        source_note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
        ref TEXT NOT NULL,
        target_note_id TEXT,
        PRIMARY KEY (source_note_id, ref)
      )`)
      const remove = this.db.prepare('DELETE FROM note WHERE path = ?')
      for (const [path, entry] of changes) if (!entry) remove.run(path)
      const upsert = this.db.prepare(`INSERT INTO note VALUES (@id, @path, @title, @projectId, @kind, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path, title=excluded.title,
          project_id=excluded.project_id, kind=excluded.kind, updated_at=excluded.updated_at
        WHERE note.path IS NOT excluded.path OR note.title IS NOT excluded.title
          OR note.project_id IS NOT excluded.project_id OR note.kind IS NOT excluded.kind
          OR note.updated_at IS NOT excluded.updated_at`)
      const clearTags = this.db.prepare('DELETE FROM note_tag WHERE note_id = ?')
      const addTag = this.db.prepare('INSERT INTO note_tag VALUES (?, ?)')
      const oldTags = new Map<string,Set<string>>()
      if (publish) for (const { note_id, tag } of this.db.prepare('SELECT note_id, tag FROM note_tag').all() as {note_id:string;tag:string}[]) {
        const tags=oldTags.get(note_id)??new Set<string>()
        tags.add(tag); oldTags.set(note_id,tags)
      }
      const projects = new Set<string>()
      // If a UUID file was copied to another folder, the already-indexed path wins.
      const byId = new Map<string, IndexedNote>()
      for (const entry of next.values()) {
        const other = byId.get(entry.note.id)
        if (!other || this.indexed.has(entry.note.path)) byId.set(entry.note.id, entry)
      }
      for (const [path, entry] of changes) {
        if (!entry) continue
        const { note, metadata } = entry
        if (byId.get(note.id) !== entry) { next.delete(path); continue }
        if (!projects.has(note.projectId)) {
          this.ensureProject(note.projectId, undefined, !publish)
          projects.add(note.projectId)
        }
        upsert.run(note)
        const existing=oldTags.get(note.id)
        if (!publish || (existing?.size??0)!==metadata.tags.size || (existing && [...existing].some(tag=>!metadata.tags.has(tag)))) {
          clearTags.run(note.id)
          for (const tag of metadata.tags) addTag.run(note.id, tag)
        }
      }
      const oldEdges = new Map<string, NoteEdge>()
      if (publish) {
        for (const edge of this.db.prepare('SELECT source_note_id AS source, target_note_id AS target FROM note_link').all() as NoteEdge[])
          oldEdges.set(edge.source + ':' + edge.target, edge)
      } else this.db.exec('DELETE FROM note_link')
      const addLink = this.db.prepare('INSERT OR IGNORE INTO note_link VALUES (?, ?)')
      const resolvedEdges = new Set<string>()
      const catalog = linkCatalog(Array.from(next.values(), ({ note }) => note))
      const bindings = new Map(this.bindings().map((b) => [JSON.stringify([b.source, b.ref]), b.target]))
      const insertBinding = this.db.prepare('INSERT INTO note_link_binding VALUES (?, ?, ?)')
      const removeBinding = this.db.prepare('DELETE FROM note_link_binding WHERE source_note_id = ? AND ref = ?')
      for (const { note, metadata } of next.values()) {
        for (const ref of metadata.references) {
          const key = JSON.stringify([note.id, ref])
          let bound = bindings.get(key)
          if (bound === undefined && legacy && !isUuid(ref)) {
            const previous = legacy.catalog.byTitle.get(ref) ?? []
            // Reuse a verifiable unique legacy edge even if the target was
            // renamed or deleted while the previous version was closed.
            if (previous.length > 1 && legacy.catalog.byId.has(note.id)) bound = null
            else if (previous.length === 1 && legacy.edges.has(note.id + previous[0].id)) bound = previous[0].id
            if (bound !== undefined) insertBinding.run(note.id, ref, bound)
          }
          const resolution = resolveLink(catalog, ref, bound)
          if (resolution.status === 'resolved') {
            const edge=note.id + ':' + resolution.note.id
            if (!resolvedEdges.has(edge) && !oldEdges.delete(edge)) addLink.run(note.id, resolution.note.id)
            resolvedEdges.add(edge)
          }
          // Keep a missing target UUID as a tombstone. Also remember ambiguity:
          // removing a candidate must not decide a previously ambiguous link.
          if (bound === undefined && !isUuid(ref) && resolution.status !== 'missing') {
            insertBinding.run(note.id, ref, resolution.status === 'resolved' ? resolution.note.id : null)
          }
          bindings.delete(key)
        }
      }
      const removeLink=this.db.prepare('DELETE FROM note_link WHERE source_note_id = ? AND target_note_id = ?')
      for(const edge of oldEdges.values())removeLink.run(edge.source,edge.target)
      for (const key of bindings.keys()) removeBinding.run(...JSON.parse(key) as [string, string])
      commit?.(rows.map(row=>row ? next.get(row.path)?.note ?? null : null))
      publish?.after()
    })
    if (publish) persist.immediate()
    else persist()
    this.indexed.clear()
    for (const [path, entry] of next) this.indexed.set(path, entry)
    return rows.map((row) => row ? this.indexed.get(row.path)?.note ?? null : null)
  }
}
