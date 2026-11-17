import { lstat, open, type FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { digest, initialContext, normalize } from './adapters'
import type { Bad, Batch, Cursor, LocatedEvent, Source, ZstdFault } from './store'
import { decompressFrame, frameAt } from './zstd'
import { runtimeTurnStart } from './zcode-events'

const CHUNK = 256 * 1024, LINE_MAX = 1024 * 1024, FRAME_MAX = 16 * 1024 * 1024
const DECODE_BATCH_MAX = 2 * FRAME_MAX, ANCHOR = 128
const decoder = new TextDecoder('utf-8', { fatal: true })
const empty = (identity: string, source: Source): Cursor => ({
  identity, offset: 0, decoded: 0, line: '', lineAt: 0, dropping: false, frame: '',
  mode: source.compressed ? 'frames' : 'plain', size: 0, mtime: 0, ctime: 0, head: '', tail: '', context: initialContext(),
  bytesRead: 0, anchorBytesRead: 0, archive: source.archive,
  ...(source.compressed && { zstd: { boundary: 0 } })
})
export interface ScanMetrics {
  path: string; adapter: Source['adapter']; offsetBefore: number; offsetAfter: number
  bytes: number; anchorBytes: number; decodedBytes: number; frames: number; events: number; bad: number
  reset: boolean; mode: Cursor['mode']; pending: boolean
  zstdFault?: ZstdFault | 'zstd-legacy-snapshot'
  rowsRead?: number; sessionsRead?: number
}
type Change = { batch?: Batch; metrics: ScanMetrics }
async function read(file: FileHandle, offset: number, size: number) {
  const buffer = Buffer.allocUnsafe(size)
  let used = 0
  while (used < size) {
    const { bytesRead } = await file.read(buffer, used, size - used, offset + used)
    if (!bytesRead) break
    used += bytesRead
  }
  return buffer.subarray(0, used)
}
export async function scan(source: Source, before: Cursor | undefined, stable: boolean): Promise<Change> {
  const adapter = source.adapter
  const metrics: ScanMetrics = { path: source.path, adapter: source.adapter, offsetBefore: before?.offset ?? 0,
    offsetAfter: before?.offset ?? 0, bytes: 0, anchorBytes: 0, decodedBytes: 0, frames: 0, events: 0, bad: 0,
    reset: false, mode: before?.mode ?? (source.compressed ? 'frames' : 'plain'), pending: false }
  const unchanged = { metrics }
  const entry = await lstat(source.path, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe-log-file')
  const file = await open(source.path, 'r')
  try {
    const st = await file.stat({ bigint: true })
    if (!st.isFile() || st.ino !== entry.ino || st.dev !== entry.dev) throw new Error('changed-log-file')
    const identity = [st.dev, st.ino, st.birthtimeNs].join(':')
    const size = Number(st.size), mtime = Number(st.mtimeNs / 1000n), ctime = Number(st.ctimeNs / 1000n)
    const sample = async (start: number, count: number) => {
      const bytes = await read(file, start, count)
      metrics.anchorBytes += bytes.length
      return bytes
    }
    const anchor = async (start: number, count: number) => digest(await sample(start, count))
    const legacySnapshot = source.compressed && before?.mode === 'snapshot'
    const fault = legacySnapshot ? 'zstd-legacy-snapshot' : before?.zstd?.fault
    const sameStamp = before?.size === size && before.mtime === mtime && before.ctime === ctime
    if (before?.identity === identity && sameStamp && (fault || (before.offset === size && !before.zstd?.drain))) {
      metrics.zstdFault = fault
      return before.archive === source.archive ? unchanged : { metrics,
        batch: { source, cursor: { ...before, archive: source.archive }, reset: false, events: [], bad: [] } }
    }
    const buffered = source.compressed && before ? Buffer.from(before.frame, 'base64') : Buffer.alloc(0)
    const boundary = before ? before.zstd?.boundary ?? (legacySnapshot
      ? before.legacyZstdBoundary ?? before.offset : before.offset - buffered.length) : 0
    const busy = () => { metrics.pending = true; return unchanged }
    let reset = !before || before.identity !== identity || size < boundary
    let rewindFrame = false
    let resolvedZstdFault: ZstdFault | undefined
    if (before && !reset) {
      if (!source.compressed && before.offset === size) reset = true
      else if (!sameStamp && before.offset) {
        if (legacySnapshot) {
          // The old snapshot cursor anchored the observed EOF, not the decoded
          // prefix. Only use anchors that are known to cover proven bytes.
          const len = Math.min(ANCHOR, before.offset)
          if (len <= boundary && await anchor(0, len) !== before.head) reset = true
          if (!reset && boundary === before.offset && boundary > len &&
            await anchor(boundary - len, len) !== before.tail) reset = true
          if (boundary === 0 && size < before.size) reset = true
        } else if (source.compressed && !before.zstd && buffered.length) {
          // Reconstruct the old offset anchors using the saved bytes for the
          // uncommitted portion. Changes to a half frame alone cannot reset.
          const legacyAnchor = async (start: number, count: number) => {
            const prefix = Math.max(0, Math.min(count, boundary - start))
            const saved = buffered.subarray(start + prefix - boundary, start + count - boundary)
            return digest(prefix === count ? await sample(start, count)
              : Buffer.concat([await sample(start, prefix), saved]))
          }
          const len = Math.min(ANCHOR, before.offset)
          reset = await legacyAnchor(0, len) !== before.head ||
            (before.offset > len && await legacyAnchor(before.offset - len, len) !== before.tail)
        } else {
          const len = Math.min(ANCHOR, boundary)
          if (len) {
            const head = await anchor(0, len)
            const tail = boundary > len ? await anchor(boundary - len, len) : head
            reset = head !== before.head || tail !== before.tail
          }
        }
      }
      if (!reset && !sameStamp && buffered.length) {
        // Resume normal growth from the saved half frame. If the buffered
        // region shrank or was rewritten, discard it instead of splicing it.
        const n = Math.min(ANCHOR, buffered.length)
        rewindFrame = size <= before.size || size < before.offset ||
          !(await sample(boundary, n)).equals(buffered.subarray(0, n)) ||
          (buffered.length > n && !(await sample(before.offset - n, n)).equals(buffered.subarray(-n)))
      }
      if (!reset && fault) {
        if (!legacySnapshot && size === boundary) resolvedZstdFault = before.zstd!.fault
        else {
          // No magic search: growth after a bad frame is still blocked. Record
          // the observation so unchanged scans do no body or anchor reads.
          const end = await file.stat({ bigint: true })
          const finalEntry = await lstat(source.path, { bigint: true })
          if (end.size !== st.size || end.mtimeNs !== st.mtimeNs || end.ctimeNs !== st.ctimeNs ||
            !finalEntry.isFile() || finalEntry.ino !== st.ino || finalEntry.dev !== st.dev) return busy()
          metrics.zstdFault = fault
          return { metrics, batch: { source, cursor: { ...before, size, mtime, ctime, archive: source.archive,
            anchorBytesRead: before.anchorBytesRead + metrics.anchorBytes }, reset: false, events: [], bad: [] } }
        }
      }
    }
    if (source.compressed && before && reset && !stable) return busy()
    const c = reset ? empty(identity, source) : { ...before!, context: { ...before!.context } }
    if (source.compressed) {
      // Plain cursors are unchanged; old frame cursors gain this field on write.
      c.zstd = { boundary: reset ? 0 : boundary }
      if (rewindFrame) c.offset = boundary
    }
    const events: LocatedEvent[] = [], bad: Bad[] = []
    let line: Buffer = Buffer.from(c.line, 'base64'), frame: Buffer = reset || rewindFrame ? Buffer.alloc(0) : buffered
    const consume = (bytes: Buffer, physicalFrame: number | null) => {
      metrics.decodedBytes += bytes.length
      let start = 0
      while (start < bytes.length) {
        const nl = bytes.indexOf(10, start)
        const end = nl < 0 ? bytes.length : nl
        const fragment = bytes.subarray(start, end)
        if (!c.dropping && line.length + fragment.length > LINE_MAX) {
          bad.push({ offset: c.lineAt, space: 'decoded', reason: 'line-limit' })
          c.dropping = true; line = Buffer.alloc(0)
        }
        if (!c.dropping && fragment.length) line = Buffer.concat([line, fragment])
        c.decoded += end - start + (nl < 0 ? 0 : 1)
        if (nl < 0) break
        if (!c.dropping && line.length) {
          const offset = c.lineAt
          let raw: string | undefined
          try { raw = decoder.decode(line) } catch { bad.push({ offset, space: 'decoded', reason: 'utf8' }) }
          if (raw?.trim()) {
            let row: unknown
            // Skip unrelated diagnostic records without deserializing their payloads.
            if (adapter!=='zcode' || /"event"\s*:\s*"turn\.started"/.test(raw)) {
              try { row = JSON.parse(raw) } catch { bad.push({ offset, space: 'decoded', reason: 'json' }) }
            }
            if (adapter === 'zcode') {
              const found = runtimeTurnStart(row)
              if (found) events.push({session:found.sid,offset,frameAt:null,event:found.event})
            } else if (row !== undefined) {
              const normalized = normalize(adapter, row, c.context, digest(line))
              c.context = normalized.context
              if (c.context.sessionId) {
                for (const event of normalized.events) events.push({ session: c.context.sessionId, offset, frameAt: physicalFrame, event })
              }
            }
          }
        }
        line = Buffer.alloc(0); c.lineAt = c.decoded; c.dropping = false; start = end + 1
      }
    }
    const drain = source.compressed && !reset && !rewindFrame && before?.zstd?.drain
    const bytes = drain ? Buffer.alloc(0) :
      await read(file, c.offset, Math.min(adapter==='zcode' ? 4*CHUNK : CHUNK, size - c.offset))
    metrics.bytes += bytes.length
    c.offset += bytes.length
    if (source.compressed) {
      const state = c.zstd!
      const input = Buffer.concat([frame, bytes]), base = state.boundary
      let pos = 0
      while (pos < input.length) {
        // Reserve the worst case before starting another frame. Drain only
        // what was already read on the next scan, even at the observed EOF.
        if (metrics.decodedBytes > DECODE_BATCH_MAX - FRAME_MAX) { state.drain = true; break }
        let info: ReturnType<typeof frameAt>
        try { info = frameAt(input, pos) } catch (error) {
          const reason = (error as Error).message
          if (reason !== 'zstd-magic' && reason !== 'zstd-header' && reason !== 'zstd-block') throw error
          state.fault = reason
          break
        }
        if ((info ? info.end - pos : input.length - pos) > FRAME_MAX) {
          state.fault = 'zstd-frame-limit'
          break
        }
        if (!info) break
        if (!info.skip) {
          let raw: Buffer
          try { raw = decompressFrame(input.subarray(pos, info.end)) } catch (error) {
            state.fault = (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'zstd-output-limit' : 'zstd-decode'
            break
          }
          metrics.frames++
          consume(raw, base + pos)
        }
        pos = info.end
      }
      state.boundary = base + pos
      if (state.fault) {
        if (!stable) return busy()
        bad.push({ offset: state.boundary, space: 'physical', reason: state.fault })
        c.offset = state.boundary
        frame = Buffer.alloc(0)
      } else {
        frame = input.subarray(pos)
      }
    } else consume(bytes, null)
    c.line = line.toString('base64'); c.frame = frame.toString('base64')
    const anchored = c.zstd?.boundary ?? c.offset
    const len = Math.min(anchored, ANCHOR)
    c.head = await anchor(0, len)
    c.tail = anchored > len ? await anchor(anchored - len, len) : c.head
    const end = await file.stat({ bigint: true })
    if (Number(end.size) < size || (end.size === st.size && (end.mtimeNs !== st.mtimeNs || end.ctimeNs !== st.ctimeNs))) {
      metrics.pending = true
      return unchanged
    }
    const finalEntry = await lstat(source.path, { bigint: true })
    if (!finalEntry.isFile() || finalEntry.ino !== st.ino || finalEntry.dev !== st.dev) {
      metrics.pending = true
      return unchanged
    }
    c.size = size; c.mtime = mtime; c.ctime = ctime
    c.archive = source.archive
    c.bytesRead = (before?.bytesRead ?? 0) + metrics.bytes
    c.anchorBytesRead = (before?.anchorBytesRead ?? 0) + metrics.anchorBytes
    Object.assign(metrics, { offsetAfter: c.offset, reset, mode: c.mode, events: events.length, bad: bad.length,
      pending: !c.zstd?.fault && (c.offset < size || Boolean(c.zstd?.drain)), zstdFault: c.zstd?.fault })
    return { batch: { source, cursor: c, events, bad, reset, resolvedZstdFault }, metrics }
  } finally { await file.close() }
}
