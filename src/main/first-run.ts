import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { win32 as path, join } from 'node:path'
import { IPC } from '../shared/ipc'
import { STARTUP, type Candidate, type RebuildOffer, type StartupState } from '../shared/startup'
import { uuidV4 } from '../shared/link-resolution'
import { NoteStore } from './notes'
import manifest from '../../package.json'

const nativeSha = '8c18b785b4ac627360bd3a6f4b6eeb2943dc9fba1620d88e29fa0b9f9cf17534'
type Pin = { pin<T>(dir: string, write: number, use: (id: string) => T): T }
let native: Pin | undefined
function pin<T>(dir: string, write: boolean, use: (id: string) => T, homeAsParent = false): T {
  if (!native) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('当前平台尚未验证本机目录权限')
    const file = app.isPackaged ? join(process.resourcesPath, 'firstrun-directory.node')
      : join(app.getAppPath(), 'native', 'firstrun-directory.node')
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== nativeSha) throw Error('目录核验部件身份不符')
    native = require(file) as Pin
  }
  return native.pin(dir, Number(write) | (homeAsParent ? 2 : 0), use)
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const within = (a: string, b: string) => same(a, b) || b.toLowerCase().startsWith(a.toLowerCase() + '\\')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function local(value: string) {
  const input = value.replaceAll('/', '\\').replace(/\\$/u, '')
  if (!/^[a-z]:\\/i.test(input) || input.length > 32000) throw Error('需要本机磁盘上的完整绝对目录')
  for (const part of input.slice(3).split('\\')) {
    if (!part || part.length > 255 || /[<>:"|?*\x00-\x1f]|[. ]$/u.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part))
      throw Error('目录包含 Windows 不支持的名称')
  }
  return input
}
const stat = (p: string) => lstatSync(p, { bigint: true, throwIfNoEntry: false })
function file(p: string, optional = true) {
  const entry = stat(p)
  if (!entry && optional) return
  if (!entry?.isFile() || entry.nlink !== 1n) throw Error('无法核实普通本地文件：' + p)
  return entry
}
function read(p: string, count: number) {
  const initial = file(p, false)!
  const fd = openSync(p, 'r')
  try {
    const active = fstatSync(fd, { bigint: true })
    if (initial.ino !== active.ino || initial.dev !== active.dev || active.nlink !== 1n) throw Error('文件身份已变化：' + p)
    const bytes = Buffer.alloc(count)
    return bytes.subarray(0, readSync(fd, bytes, 0, count, 0))
  } finally { closeSync(fd) }
}
const rootFiles = ['index.sqlite', 'delegation.sqlite', 'm43-delete.sqlite', 'm43-gate.sqlite']
const profileFiles = ['agents.sqlite', 'sessions.sqlite', 'markdown-export.sqlite']
function databaseFiles(dir: string, names: string[]) {
  for (const name of names) for (const suffix of ['', '-wal', '-shm', '-journal'])
    file(path.join(dir, name + suffix))
}

// A readonly SQLite connection can still create -wal/-shm beside the source.
// Inspect a verified, checkpointed in-memory copy instead.
function inspectDatabase<T>(location: string, use: (db: Database.Database) => T): T {
  const stamp = file(location, false)!
  const requireCheckpoint = () => {
    if (['-wal', '-journal'].some(suffix => (file(location + suffix)?.size ?? 0n) > 0n))
      throw Error('这个目录有尚未保存到索引的记录。请先关闭仍在使用此目录的旧版，再重新检查。')
  }
  requireCheckpoint()
  if (stamp.size < 100n || stamp.size > 256n * 1024n * 1024n) throw Error('索引大小无法安全核验')
  const image = read(location, Number(stamp.size))
  requireCheckpoint()
  const after = file(location, false)!
  if (image.length !== Number(stamp.size) || after.ino !== stamp.ino || after.size !== stamp.size || after.mtimeNs !== stamp.mtimeNs)
    throw Error('索引正在变化，请重新检查')
  if (image.subarray(0, 16).toString('latin1') !== 'SQLite format 3\x00') throw Error('无法核实索引格式')
  // The detached copy has no WAL. Interpret the checkpointed base image as a rollback database.
  if (image[18] === 2 && image[19] === 2) { image[18] = 1; image[19] = 1 }
  const db = new Database(image, { readonly: true })
  try { return use(db) } finally { db.close() }
}

function recognize(root: string) {
  databaseFiles(root, rootFiles)
  const idx = path.join(root, 'index.sqlite')
  const projects = path.join(root, 'projects')
  if (!stat(idx) || !stat(projects)) return false
  if (read(idx, 16).toString('latin1') !== 'SQLite format 3\x00') return false
  return pin(projects, false, () => {
    const defaultProject = path.join(projects, 'default')
    if (!stat(defaultProject)) return false
    pin(defaultProject, false, () => {})
    const removed = path.join(root, '.workbench-removed')
    if (stat(removed)) pin(removed, false, () => {})
    return true
  })
}
class WorkspaceBindingError extends Error {
  constructor() { super('这个笔记目录属于另一份工作台档案。可以把笔记重建到新目录。') }
}
function verifyCoordinator(root: string, profile: string) {
  const file = path.join(root, 'm43-delete.sqlite')
  if (!stat(file)) return
  inspectDatabase(file, prior => {
    const record = prior.prepare('SELECT stores FROM m43_workspace').get() as { stores: string } | undefined
    const expected = JSON.stringify({ index: path.join(root, 'index.sqlite'), delegation: path.join(root, 'delegation.sqlite'),
      sessions: path.join(profile, 'sessions.sqlite'), agents: path.join(profile, 'agents.sqlite') })
    if (record?.stores !== expected) throw new WorkspaceBindingError()
  })
}

type Registration = { version: 1; path: string; identity: string; introSeen: boolean }
type Checked = Candidate & { identity: string; anchor: string; missing: string[] }
type Recovery = RebuildOffer & { identity: string }
type Live = { agent(): 'unconfigured' | 'unchecked'; startLogs(): Promise<void>; close(): Promise<void>; publish(): void }

export class StorageOpenError extends Error {
  constructor(error: unknown, readonly closing: Promise<void>) { super(message(error)) }
}

export class FirstRun {
  private state: StartupState = { phase: 'reading' }
  private registered?: Registration
  private candidate?: Checked
  private recovery?: Recovery
  private busy = false
  private started = false
  private readonly profile = local(app.getPath('userData'))
  private readonly record = path.join(this.profile, 'note-location-v1.json')
  private suggested?: string
  private readonly override = process.env[app.isPackaged ? 'PLATE_TRIAL_NOTES_ROOT' : 'NOTES_WORKBENCH_ROOT'] || undefined

  constructor(private readonly getWindow: () => BrowserWindow | null,
    private readonly activate: (root: string, scope: string) => Live,
    private readonly quitting: () => boolean) {}

  register() {
    const owner = (event: Electron.IpcMainInvokeEvent) => {
      const contents = this.getWindow()?.webContents
      if (this.quitting() || !contents || contents.isDestroyed() || event.sender !== contents ||
          event.senderFrame !== contents.mainFrame) throw Error('Unrecognized IPC sender')
    }
    ipcMain.handle(IPC.appInfo, (event, ...args: unknown[]) => {
      owner(event)
      if (args.length) throw Error('Invalid app info request')
      return { name: app.isPackaged ? app.getName() : manifest.productName,
        version: app.isPackaged ? app.getVersion() : manifest.version }
    })
    ipcMain.handle(STARTUP, (event, method: unknown, ...args: unknown[]) => {
      owner(event)
      if (method === 'submit' && args.length === 1 && typeof args[0] === 'string') return this.submit(args[0])
      if (method === 'rebuild' && args.length === 1 && typeof args[0] === 'string') return this.rebuild(args[0])
      if (args.length) throw Error('Invalid location request')
      switch (method) {
        case 'state':
          if (!this.started) {
            this.started = true
            setImmediate(() => void this.bootstrap())
          }
          return this.state
        case 'suggest': return this.selectDefault()
        case 'browse': return this.browse()
        case 'retry': return this.retry()
        case 'continue': return this.continue()
        case 'exit':
          if (!this.busy && this.state.phase !== 'ready') app.quit()
          return
        default: throw Error('Invalid location request')
      }
    })
  }

  private readRecord() {
    return pin(this.profile, false, () => {
      const entry = file(this.record)
      if (!entry) return undefined
      if (entry.size > 131072n) throw Error('本机笔记位置登记文件过大')
      const row = JSON.parse(read(this.record, Number(entry.size)).toString('utf8')) as Partial<Registration>
      if (row?.version !== 1 || typeof row.path !== 'string' || typeof row.identity !== 'string' ||
          !/^[0-9a-f]+:[0-9a-f]{32}:[0-9a-f]+$/u.test(row.identity) || typeof row.introSeen !== 'boolean')
        throw Error('本机笔记位置登记无法核实')
      return { version: 1, path: local(row.path), identity: row.identity, introSeen: row.introSeen } as Registration
    })
  }
  private writeRecord(row: Registration) {
    pin(this.profile, true, () => {
      file(this.record)
      const tmp = path.join(this.profile, '.note-location-' + randomUUID() + '.tmp')
      const fd = openSync(tmp, 'wx')
      try {
        try { writeFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(tmp, this.record)
      } finally { rmSync(tmp, { force: true }) }
    })
    this.registered = row
  }
  private check(raw: string, allowNew: boolean): Checked {
    const root = local(raw)
    if (within(root, this.profile) || within(this.profile, root)) throw Error('笔记位置不能与应用档案目录重叠')
    if (this.registered && !same(root, this.registered.path) &&
        (within(root, this.registered.path) || within(this.registered.path, root)))
      throw Error('不能在已登记笔记目录内外嵌套建立笔记库')
    // Pin the drive-relative chain before inspecting below the authorized anchor.
    // Ascending ENOENT is lexical only; the actual parent chain is validated by the native handle walk.
    const missing: string[] = []
    let anchor = root
    for (;;) {
      try {
        return pin(anchor, false, identity => {
          const token = randomUUID()
          if (missing.length) return { token, path: root, identity, anchor, missing, kind: 'new' }
          if (!readdirSync(root).length) return { token, path: root, identity, anchor, missing, kind: 'empty' }
          if (recognize(root)) return { token, path: root, identity, anchor, missing, kind: 'existing' }
          throw Error('普通非空目录不会导入散放的 Markdown 或更改其他文件。请选择空目录或已有工作台目录。')
        }, missing.length > 0)
      } catch (error) {
        if (!/（3 \/ 0xc000003[4a]）$/i.test(message(error))) throw error
        if (!allowNew) throw Error('已保存的笔记目录不存在')
        const parent = path.dirname(anchor)
        if (parent === anchor || parent === path.parse(anchor).root) throw Error('缺少可验证的本机父目录')
        missing.unshift(path.basename(anchor))
        anchor = parent
      }
    }
  }
  private public(c = this.candidate): Candidate | undefined {
    return c && { path: c.path, token: c.token, kind: c.kind }
  }
  private manual(error?: string): StartupState {
    const rebuild = this.recovery && { token: this.recovery.token, source: this.recovery.source }
    if (this.state.phase === 'blocked') return { ...this.state, candidate: this.public(), rebuild, error: error ?? this.state.error }
    return { phase: 'choose', suggested: this.suggested, candidate: this.public(), rebuild, error }
  }
  private blocked(error: unknown, path?: string, override = false) {
    this.state = { phase: 'blocked', path, override, error: message(error), candidate: this.public() }
    if (path) this.offerRecovery(error, path)
    this.state = this.manual()
  }
  private offerRecovery(error: unknown, root: string) {
    this.recovery = undefined
    if (!(error instanceof WorkspaceBindingError)) return
    try {
      const checked = this.check(root, false)
      if (checked.kind === 'existing')
        this.recovery = { token: randomUUID(), source: checked.path, identity: checked.identity }
    } catch { /* A location that failed identity validation cannot be copied. */ }
  }
  private suggestedLocation() {
    // The Windows Documents known folder may be unavailable. It is only a suggestion.
    let documents: string
    try { documents = app.getPath('documents') } catch { return undefined }
    return documents.trim() ? path.join(documents, app.isPackaged ? 'Plate-本地工作区' : '笔记+Agent工作台') : undefined
  }
  private async bootstrap() {
    if (this.busy || this.quitting()) return
    this.busy = true
    this.candidate = undefined
    this.recovery = undefined
    let target: string | undefined
    try {
      let invalid: unknown
      try { this.registered = this.readRecord() } catch (error) { this.registered = undefined; invalid = error }
      if (this.override) {
        target = this.override
        const checked = this.check(target, true)
        if (this.registered && same(checked.path, this.registered.path) &&
            (checked.kind !== 'existing' || checked.identity !== this.registered.identity))
          throw Error('环境指定的位置与登记身份不符')
        await this.open(checked, 'override')
      } else if (invalid) throw invalid
      else if (this.registered) {
        target = this.registered.path
        const checked = this.check(target, false)
        if (checked.kind !== 'existing' || checked.identity !== this.registered.identity) throw Error('已登记的目录或工作台文件身份不符')
        await this.open(checked, 'registered')
      } else {
        target = this.suggested = this.suggestedLocation()
        if (!target) {
          this.state = this.manual()
          return
        }
        // Missing default is a suggestion only; no library or directory is created.
        // A non-workbench default is also never automatically claimed.
        const checked = this.check(target, true)
        if (checked.kind === 'existing' && !app.isPackaged) {
          await this.open(checked, 'legacy')
          return
        }
        this.candidate = checked
        this.state = this.manual()
      }
    } catch (error) { this.blocked(error, target, !!this.override) }
    finally { this.busy = false }
  }
  private selectDefault() {
    if (this.busy || this.state.phase !== 'choose' || !this.suggested) return this.state
    try { this.candidate = this.check(this.suggested, true); this.recovery = undefined; this.state = this.manual() }
    catch (error) { this.state = this.manual(message(error)) }
    return this.state
  }
  private async browse() {
    const window = this.getWindow()
    if (!window || this.busy || !['choose','blocked'].includes(this.state.phase) ||
        (this.state.phase === 'blocked' && this.state.override)) return this.state
    this.busy = true
    const frame = window.webContents.mainFrame
    try {
      const result = await dialog.showOpenDialog(window, {
        title: '选择笔记位置', properties: ['openDirectory', 'dontAddToRecent']
      })
      if (window.isDestroyed() || this.getWindow() !== window || window.webContents.mainFrame !== frame || result.canceled)
        return this.state
      if (result.filePaths.length !== 1) throw Error('请选择一个本机目录')
      this.candidate = this.check(result.filePaths[0], false)
      this.recovery = undefined
      this.state = this.manual()
    } catch (error) {
      // Preserve the old recovery path/candidate but explicitly tell the user which selection failed.
      this.state = this.manual('核验所选目录失败：' + message(error))
    } finally { this.busy = false }
    return this.state
  }
  private async submit(token: string) {
    const selected = this.candidate
    if (this.busy || !selected || token !== selected.token || !['choose','blocked'].includes(this.state.phase) ||
        (this.state.phase === 'blocked' && this.state.override)) return this.state
    this.busy = true
    const previous = this.state
    try { await this.open(selected, 'chosen') }
    catch (error) {
      this.state = previous
      // New storage may have been created by the approved attempt. Require re-review if the directory shape changed.
      try { this.candidate = this.check(selected.path, true) } catch { this.candidate = undefined }
      this.offerRecovery(error, selected.path)
      this.state = this.manual(error instanceof WorkspaceBindingError ? message(error) : '打开或登记笔记位置失败：' + message(error))
    } finally { this.busy = false }
    return this.state
  }
  private async rebuild(token: string) {
    const r = this.recovery
    if (this.busy || !r || token !== r.token || !['choose', 'blocked'].includes(this.state.phase)) return this.state
    const previous = this.state
    const parent = path.dirname(r.source)
    const target = path.join(parent, 'Plate-重建-' + randomUUID().slice(0, 8))
    let created = false
    let destinationIdentity: string | undefined
    this.busy = true
    this.state = { phase: 'opening', path: target }
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (this.quitting()) throw Error('工作台正在关闭')
      const checked = this.check(r.source, false)
      if (checked.kind !== 'existing' || checked.identity !== r.identity) throw Error('原目录身份已变化，请重新选择')
      const projectNames = new Map<string, string>()
      pin(r.source, false, identity => {
        if (identity !== r.identity || !recognize(r.source)) throw Error('原目录身份已变化')
        const original = path.join(r.source, 'projects')
        const copies: { project: string; name: string; bytes: Buffer }[] = []
        const groups: string[] = []
        const ids = new Set<string>()
        let total = 0
        inspectDatabase(path.join(r.source, 'index.sqlite'), idx => {
          for (const row of idx.prepare('SELECT id, name FROM project LIMIT 2001').all() as { id: string; name: string }[]) {
            if (typeof row.name === 'string' && row.name.trim() && row.name.length <= 240) projectNames.set(row.id, row.name)
          }
        })
        pin(original, false, () => {
          for (const group of readdirSync(original, { withFileTypes: true })) {
            if (!group.isDirectory() || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(group.name) ||
                /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(group.name)) continue
            if (groups.length >= 2000) throw Error('分区数量超出单次重建上限')
            groups.push(group.name)
            const dir = path.join(original, group.name)
            pin(dir, false, () => {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.name.endsWith('.md')) continue
                const origin = path.join(dir, entry.name)
                const stamp = file(origin, false)!
                if (stamp.size > 16n * 1024n * 1024n || copies.length >= 5000 ||
                    total + Number(stamp.size) > 128 * 1024 * 1024) throw Error('笔记大小超出单次重建上限')
                const bytes = read(origin, Number(stamp.size))
                const after = file(origin, false)!
                if (bytes.length !== Number(stamp.size) || after.size !== stamp.size || after.ino !== stamp.ino ||
                    after.mtimeNs !== stamp.mtimeNs || !isUtf8(bytes)) throw Error('笔记正在变化或编码不是 UTF-8：' + entry.name)
                total += bytes.length
                const stem = entry.name.slice(0, -3).toLowerCase()
                const id = uuidV4.test(stem) && !ids.has(stem) ? stem : randomUUID()
                ids.add(id)
                const name = /-conflict-\d{8}T\d{9}Z\.md$/.test(entry.name) ? entry.name : id + '.md'
                copies.push({ project: group.name, name, bytes })
              }
            })
          }
        })
        pin(parent, true, () => {
          mkdirSync(target)
          created = true
          pin(target, true, identity => {
            destinationIdentity = identity
            const projects = path.join(target, 'projects')
            mkdirSync(projects)
            for (const group of groups) mkdirSync(path.join(projects, group))
            for (const item of copies) writeFileSync(path.join(projects, item.project, item.name), item.bytes, { flag: 'wx' })
          })
        }, true)
      })
      const seed = pin(target, true, identity => {
        if (identity !== destinationIdentity) throw Error('新目录身份已变化')
        return new NoteStore(target, () => {}, true)
      })
      await seed.close()
      pin(target, true, identity => {
        if (identity !== destinationIdentity) throw Error('新目录身份已变化')
        const index = new Database(localSqlitePath(path.join(target, 'index.sqlite')), { fileMustExist: true })
        try {
          const insert = index.prepare('INSERT INTO project(id,name,root_path,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
          index.transaction(() => {
            for (const entry of readdirSync(path.join(target, 'projects'), { withFileTypes: true })) {
              if (entry.isDirectory()) insert.run(entry.name, projectNames.get(entry.name) ?? (entry.name === 'default' ? '默认项目' : entry.name),
                path.join(target, 'projects', entry.name), Date.now())
            }
          })()
        } finally { index.close() }
      })
      const next = this.check(target, false)
      if (next.identity !== destinationIdentity) throw Error('新目录身份已变化')
      await this.open(next, 'chosen')
      this.recovery = undefined
    } catch (error) {
      this.state = previous
      this.state = this.manual('未能完成重建：' + message(error) + (created ? '。已保留新建目录：' + target : ''))
    } finally { this.busy = false }
    return this.state
  }
  private retry() {
    if (!this.busy && this.state.phase === 'blocked') {
      this.state = { phase: 'reading' }
      void this.bootstrap()
    }
    return this.state
  }
  private continue() {
    if (this.state.phase === 'ready' && this.state.intro && this.registered) {
      try {
        this.writeRecord({ ...this.registered, introSeen: true })
        this.state = { ...this.state, intro: false, error: undefined }
      } catch (error) {
        this.state = { ...this.state, error: '无法保存引导状态：' + message(error) }
      }
    }
    return this.state
  }
  private async open(proposed: Checked, mode: 'override' | 'registered' | 'legacy' | 'chosen') {
    this.state = { phase: 'opening', path: proposed.path }
    await new Promise<void>(resolve => setImmediate(resolve))
    if (this.quitting()) throw Error('工作台正在关闭')
    const next = this.check(proposed.path, proposed.kind === 'new')
    if (next.kind !== proposed.kind || next.identity !== proposed.identity || !same(next.anchor, proposed.anchor))
      throw Error('目录内容或身份已变化，请重新核对')
    let live: Live | undefined
    const ready: { current?: StartupState } = {}
    try {
      pin(next.anchor, true, anchorId => {
        if (anchorId !== next.identity) throw Error('目录身份已变化')
        const descend = (parent: string, depth: number, open: (identity: string) => void): void => {
          if (depth === next.missing.length) { pin(parent, true, open); return }
          const current = path.join(parent, next.missing[depth])
          mkdirSync(current)
          if (depth === next.missing.length - 1) pin(current, true, open)
          else pin(current, true, () => descend(current, depth + 1, open))
        }
        descend(next.anchor, 0, identity => {
          if (!next.missing.length && identity !== next.identity) throw Error('目录身份已变化')
          if (next.kind === 'existing' ? !recognize(next.path) : readdirSync(next.path).length > 0)
            throw Error('目录结构已变化')
          if (next.kind === 'existing') {
            inspectDatabase(path.join(next.path, 'index.sqlite'), prior => {
              const present = prior.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('project','note','note_tag','note_link')").get() as { n: number }
              if (present.n !== 4) throw Error('索引结构不是可识别的工作台数据库')
            })
          }
          const profile = this.scope(next, mode)
          pin(profile, true, () => {
            databaseFiles(profile, profileFiles)
            verifyCoordinator(next.path, profile)
            live = this.activate(next.path, profile)
            if (mode === 'legacy' || mode === 'chosen')
              this.writeRecord({ version: 1, path: next.path, identity, introSeen: false })
            let agent: 'unchecked' | 'unconfigured' | 'failed' = 'unchecked'
            try { agent = live.agent() } catch { agent = 'failed' }
            live.publish()
            ready.current = { phase: 'ready', path: next.path, agent,
              intro: mode !== 'override' && this.registered?.introSeen !== true }
          })
        })
      }, next.missing.length > 0)
    } catch (error) {
      if (live) await live.close()
      else if (error instanceof StorageOpenError) await error.closing
      throw error
    }
    this.state = ready.current!
    void live!.startLogs().catch(() => {
      if (this.state.phase === 'ready') this.state = { ...this.state, agent: 'failed' }
    })
  }
  private scope(root: Checked, mode: 'override' | 'registered' | 'legacy' | 'chosen') {
    const bank = path.join(this.profile, 'note-root-profiles')
    const scoped = path.join(bank, createHash('sha256').update(root.path.toLowerCase()).digest('hex'))
    if (stat(bank)) {
      const exists = pin(bank, false, () => !!stat(scoped))
      if (exists) return scoped
    }
    // Existing pre-P13 books retain their original coordinator path and profile dbs.
    // New recovery choices get independent stores so the old coordinator remains reopenable.
    if (stat(path.join(root.path, 'm43-delete.sqlite')) || mode === 'legacy' ||
        (mode === 'override' && !stat(this.record) && root.kind !== 'existing' && !stat(path.join(this.profile, 'agents.sqlite'))))
      return this.profile
    if (mode === 'registered') throw Error('笔记位置关联的档案目录缺失')
    pin(this.profile, true, () => {
      if (!stat(bank)) mkdirSync(bank)
      pin(bank, true, () => mkdirSync(scoped))
    })
    return scoped
  }
}
