/**
 * ConPTY slot host. Loads the lazy-bound N-API addon (SHA-pinned) and wraps it
 * in a small manager with a poller. All handles belong to this process; when
 * this process dies every slot dies with it — the UI must say so, there is no
 * claim of keep-alive.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface AddonOpenOk { status: 'ok'; id: number; pid: number }
interface AddonOpenError { status: 'error'; op: string; win32: number }
interface AddonRead {
  status: 'ok'
  data: Uint8Array
  dropped: number
  produced: number
  exited: boolean
  exitCode: number
  pid: number
}
interface AddonError { status: 'error'; op: string; win32: number }
interface AddonOk { status: 'ok'; written?: number; exitCode?: number }
interface PlateTerminalAddon {
  open(options: { argv: string[]; cwd: string; cols: number; rows: number; runAsNode: number }): AddonOpenOk | AddonOpenError
  read(id: number, maxBytes: number): AddonRead | AddonError
  write(id: number, data: string | Uint8Array): AddonOk | AddonError
  sigint(id: number): AddonOk | AddonError
  resize(id: number, cols: number, rows: number): AddonOk | AddonError
  state(id: number): { status: 'ok'; exited: boolean; exitCode: number; pid: number } | AddonError
  terminate(id: number): AddonOk | AddonError
  close(id: number): AddonOk | AddonError
}

const here = typeof __dirname === 'string' && __dirname
  ? __dirname
  : dirname(fileURLToPath(import.meta.url))

export const addonPath = join(here, 'native', 'plate-terminal.node')
export const addonSha256Path = join(here, 'native', 'plate-terminal.sha256')

let cached: PlateTerminalAddon | null = null

/** Load once per process; refuses an addon whose bytes do not match the pin. */
export function loadAddon(): PlateTerminalAddon {
  if (cached) return cached
  const bytes = readFileSync(addonPath)
  const actual = createHash('sha256').update(bytes).digest('hex')
  const expected = readFileSync(addonSha256Path, 'utf8').trim()
  if (actual !== expected) throw new Error(`plate-terminal addon sha256 mismatch: ${actual}`)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const addon = require(addonPath) as PlateTerminalAddon
  for (const method of ['open', 'read', 'write', 'sigint', 'resize', 'state', 'terminate', 'close'] as const) {
    if (typeof addon[method] !== 'function') throw new Error(`plate-terminal addon missing ${method}`)
  }
  cached = addon
  return addon
}

export interface SlotEvents {
  onData(chunk: Buffer): void
  onExit(exitCode: number, droppedTotal: number): void
}

interface SlotEntry {
  id: number
  pid: number
  dropped: number
  exited: boolean
  exitCode: number
  listeners: Set<SlotEvents>
}

export class SlotHost {
  private readonly addon: PlateTerminalAddon
  private readonly slots = new Map<number, SlotEntry>()
  private pollTimer: NodeJS.Timeout | null = null
  private pollCount = 0

  constructor() {
    this.addon = loadAddon()
  }

  open(options: { argv: readonly string[]; cwd: string; cols?: number; rows?: number; runAsNode?: boolean }): { id: number; pid: number } {
    const result = this.addon.open({
      argv: [...options.argv],
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 25,
      runAsNode: options.runAsNode ? 1 : 0,
    })
    if (result.status === 'error') {
      throw new Error(`ConPTY open failed (${result.op}, win32=${result.win32})`)
    }
    this.slots.set(result.id, {
      id: result.id,
      pid: result.pid,
      dropped: 0,
      exited: false,
      exitCode: 0,
      listeners: new Set(),
    })
    this.ensurePoller()
    return { id: result.id, pid: result.pid }
  }

  subscribe(id: number, events: SlotEvents): () => void {
    const slot = this.slots.get(id)
    if (!slot) throw new Error(`unknown slot ${id}`)
    slot.listeners.add(events)
    this.ensurePoller()
    return () => {
      slot.listeners.delete(events)
      this.ensurePoller()
    }
  }

  write(id: number, data: string | Uint8Array): { written: number } {
    const result = this.addon.write(id, data)
    if (result.status === 'error') throw new Error(`write failed (win32=${result.win32})`)
    return { written: result.written ?? 0 }
  }

  sigint(id: number): void {
    const result = this.addon.sigint(id)
    if (result.status === 'error') throw new Error(`sigint failed (win32=${result.win32})`)
  }

  resize(id: number, cols: number, rows: number): void {
    const result = this.addon.resize(id, cols, rows)
    if (result.status === 'error') throw new Error(`resize failed (win32=${result.win32})`)
  }

  state(id: number): { pid: number; exited: boolean; exitCode: number; dropped: number } | null {
    const slot = this.slots.get(id)
    if (!slot) return null
    return { pid: slot.pid, exited: slot.exited, exitCode: slot.exitCode, dropped: slot.dropped }
  }

  /** Graceful stop: Ctrl+C first; the caller decides when to terminate. */
  stopRound(id: number): void {
    this.sigint(id)
  }

  terminate(id: number): void {
    const result = this.addon.terminate(id)
    if (result.status === 'error') throw new Error(`terminate failed (win32=${result.win32})`)
  }

  close(id: number): void {
    const slot = this.slots.get(id)
    if (!slot) return
    const result = this.addon.close(id)
    slot.exited = true
    if (result.status === 'ok' && typeof result.exitCode === 'number') slot.exitCode = result.exitCode
    for (const listener of slot.listeners) listener.onExit(slot.exitCode, slot.dropped)
    this.slots.delete(id)
    this.ensurePoller()
  }

  /** Snapshot of a live slot for reconnect: bounded tail is the caller's concern. */
  list(): { id: number; pid: number; exited: boolean; exitCode: number; dropped: number }[] {
    return [...this.slots.values()].map((s) => ({
      id: s.id,
      pid: s.pid,
      exited: s.exited,
      exitCode: s.exitCode,
      dropped: s.dropped,
    }))
  }

  private ensurePoller(): void {
    const needed = [...this.slots.values()].some((s) => s.listeners.size > 0 && !s.exited)
    if (needed && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), 15)
      this.pollTimer.unref?.()
    } else if (!needed && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private poll(): void {
    if (++this.pollCount > 100000) return
    for (const slot of this.slots.values()) {
      if (slot.exited || slot.listeners.size === 0) continue
      const result = this.addon.read(slot.id, 256 * 1024)
      if (result.status === 'error') continue
      slot.dropped = result.dropped
      if (result.data.length > 0) {
        const chunk = Buffer.from(result.data)
        for (const listener of slot.listeners) listener.onData(chunk)
      }
      if (result.exited) {
        slot.exited = true
        slot.exitCode = result.exitCode
        for (const listener of slot.listeners) listener.onExit(result.exitCode, result.dropped)
        this.ensurePoller()
      }
    }
  }
}
