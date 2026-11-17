import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const identity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
const stamp = (s: BigIntStats) => `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  a.isFile() && b.isFile() && identity(a) === identity(b) && stamp(a) === stamp(b)
const sameDir = (a: BigIntStats, b: BigIntStats) =>
  a.isDirectory() && b.isDirectory() && identity(a) === identity(b)
const changed = () => new Error('笔记目录或文件在读取期间发生变化，请重新开始')
const local = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s

export function pinIndexRoot(root: string, projects: string, database: string) {
  const dir = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isDirectory() || local(realpathSync.native(path)) !== local(resolve(path))) throw changed()
    return stat
  }
  const r = dir(root), p = dir(projects), db = lstatSync(database, { bigint: true })
  if (!db.isFile() || db.nlink !== 1n) throw changed()
  return () => {
    const current = lstatSync(database, { bigint: true })
    if (!sameDir(r, dir(root)) || !sameDir(p, dir(projects)) ||
      !current.isFile() || current.nlink !== 1n || identity(db) !== identity(current)) throw changed()
  }
}

export function fileSnapshot(bytes: Buffer, after: BigIntStats) {
  return {
    bytes, content: bytes.toString('utf8'), validUtf8: isUtf8(bytes),
    createdAt: Number(after.birthtimeMs), updatedAt: Number(after.mtimeMs),
    identity: identity(after),
    revision: `${stamp(after)}:${createHash('sha256').update(bytes).digest('hex')}`
  }
}
export type Snapshot = ReturnType<typeof fileSnapshot>

type Scope = { project(name: string): boolean; accepts(path: string): boolean; known: ReadonlySet<string> }
type Counts = { phase: 'collecting'; found: number } | { phase: 'reading'; found: number; read: number }

// No database, note-store mutation or watcher side effects in the reading phase.
export async function readStartupIndex(projects: string, scope: Scope, signal: AbortSignal, report: (counts: Counts) => void) {
  const dirs = new Map<string, { pin: BigIntStats; files: string[] }>()
  const files = new Map<string, Snapshot>()
  const pins = new Map<string, BigIntStats>()
  const projectPin = await lstat(projects, { bigint: true })
  if (!projectPin.isDirectory()) throw changed()
  const projectDirs = await readdir(projects, { withFileTypes: true })
  const knownDirs = new Set([...scope.known].map(path=>local(dirname(path))))
  const knownFiles = new Set([...scope.known].map(local))
  function pathsIn(dir: string, entries: Dirent[]) {
    return entries.flatMap(entry=>{
      const path=join(dir,entry.name)
      if (!scope.accepts(path)) return []
      if (entry.isFile()) return [path]
      if (knownFiles.has(local(path))) throw changed()
      return []
    })
  }
  function isProjectDir(entry: Dirent) {
    if (!scope.project(entry.name)) return false
    if (!entry.isDirectory() && knownDirs.has(local(join(projects,entry.name)))) throw changed()
    return entry.isDirectory()
  }
  let found = 0, read = 0
  for (const dir of projectDirs) {
    signal.throwIfAborted()
    if (!isProjectDir(dir)) continue
    const path = join(projects, dir.name)
    const pin = await lstat(path, { bigint: true })
    if (!pin.isDirectory()) throw changed()
    const candidates = pathsIn(path, await readdir(path, { withFileTypes: true }))
    dirs.set(path, { pin, files: candidates })
    found += candidates.length
    report({ phase: 'collecting', found })
  }
  report({ phase: 'reading', found, read })
  for (const [dir, { pin, files: names }] of dirs) {
    const guard = async () => {
      signal.throwIfAborted()
      if (!sameDir(projectPin, await lstat(projects, { bigint: true })) ||
        !sameDir(pin, await lstat(dir, { bigint: true }))) throw changed()
      signal.throwIfAborted()
    }
    for (let i = 0; i < names.length; i += 8) {
      await guard()
      // Wait for every handle in this batch to be closed, including on failure.
      const batch = await Promise.allSettled(names.slice(i, i + 8).map(async path => {
        signal.throwIfAborted()
        const before = await lstat(path, { bigint: true })
        if (!before.isFile()) throw changed()
        const fd = await open(path, 'r')
        try {
          if (!sameFile(before, await fd.stat({ bigint: true }))) throw changed()
          const bytes = await fd.readFile({ signal })
          const after = await fd.stat({ bigint: true })
          if (!sameFile(before, after) || !sameFile(after, await lstat(path, { bigint: true }))) throw changed()
          signal.throwIfAborted()
          return { path, after, disk: fileSnapshot(bytes, after) }
        } finally { await fd.close() }
      }))
      await guard()
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason
        const { path, after, disk } = result.value
        pins.set(path, after)
        files.set(path, disk)
        read++
      }
      report({ phase: 'reading', found, read })
    }
  }

  // Run as the last operation inside the publishing transaction. Recheck
  // membership as well as identities (including paths previously missing).
  function verify() {
    if (!sameDir(projectPin, lstatSync(projects, { bigint: true }))) throw changed()
    const paths = readdirSync(projects, { withFileTypes: true }).filter(isProjectDir).map(dir => join(projects, dir.name))
    if (paths.length !== dirs.size) throw changed()
    for (const dir of paths) {
      const recorded = dirs.get(dir)
      if (!recorded || !sameDir(recorded.pin, lstatSync(dir, { bigint: true }))) throw changed()
      const names = pathsIn(dir, readdirSync(dir, { withFileTypes: true }))
      if (names.length !== recorded.files.length) throw changed()
      for (const path of names) {
        const pin = pins.get(path)
        if (!pin || !sameFile(pin, lstatSync(path, { bigint: true }))) throw changed()
      }
    }
  }
  return { files, verify }
}
