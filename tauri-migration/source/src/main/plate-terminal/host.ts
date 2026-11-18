/**
 * Plate terminal host: owns the slot registry, streams slot output to the
 * renderer, and feeds PLATE-RECEIPT lines into the delivery ledger. Receipt
 * parsing is echo-guarded: a slot only becomes "armed" once the echo of the
 * envelope's closing marker has been seen, so our own pasted text never
 * confirms a delivery.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard, shell, type BrowserWindow } from 'electron'
import { TerminalPlugins } from './plugins'
import {
  parseReceipt,
  RECEIPT_PREFIX,
  plateTerminalIPC,
} from '../../shared/plate-terminal/contract'
import type {
  ContextPackage,
  PlateTerminalDataEvent,
  PlateTerminalDeliverInput,
  PlateTerminalDeliverResult,
  PlateTerminalExitEvent,
  PlateTerminalSlotOpenInput,
  PlateTerminalSlotOpenResult,
  RolePresetId,
  SlotIdentity,
  ProviderFlavor,
  TerminalPluginId,
} from '../../shared/plate-terminal/contract'
import { DeliveryLog } from './delivery'
import { discoverAgents } from './discovery'
import { SlotHost } from './pty'

const ENVELOPE_ECHO_MARKER = `[请回复：${RECEIPT_PREFIX}`

interface SlotSession {
  identity: SlotIdentity
  pending: Buffer
  armed: boolean
  unsubscribe: () => void
  provider: ProviderFlavor
  codexReady: boolean
  readyTail: string
  submit?: { timer: ReturnType<typeof setTimeout>; marker: string; echo: string; seen: boolean }
}

export interface PlateTerminalHostDeps {
  getWindow: () => BrowserWindow | null
  userDataDir: () => string
}

export function createPlateTerminalHost(deps: PlateTerminalHostDeps) {
  const log = new DeliveryLog(deps.userDataDir())
  const plugins = new TerminalPlugins(deps.userDataDir())
  let slots: SlotHost | null = null
  const sessions = new Map<number, SlotSession>()

  const pushData = (event: PlateTerminalDataEvent): void => {
    deps.getWindow()?.webContents.send(plateTerminalIPC.data, event)
  }
  const pushExit = (event: PlateTerminalExitEvent): void => {
    deps.getWindow()?.webContents.send(plateTerminalIPC.exit, event)
  }

  const getSlots = (): SlotHost => {
    slots ??= new SlotHost()
    return slots
  }

  /** Consumes complete lines; complete UTF-8 only, split chunks stay buffered. */
  const consumeLines = (session: SlotSession, chunk: Uint8Array): string[] => {
    session.pending = Buffer.concat([session.pending, Buffer.from(chunk)])
    const lines: string[] = []
    for (;;) {
      const index = session.pending.indexOf(0x0a)
      if (index < 0) break
      const line = session.pending.subarray(0, index).toString('utf8').replace(/\r$/, '')
      session.pending = session.pending.subarray(index + 1)
      lines.push(line)
    }
    if (session.pending.length > 65536) session.pending = session.pending.subarray(-8192)
    return lines
  }

  const handleLines = (slotId: number, session: SlotSession, lines: string[]): void => {
    for (const line of lines) {
      if (!session.armed) {
        if (line.includes(ENVELOPE_ECHO_MARKER)) session.armed = true
        continue
      }
      const receipt = parseReceipt(line)
      if (!receipt) continue
      const confirmed = log.observeLine(session.identity, line)
      if (!confirmed) log.observeMismatch(session.identity, line)
    }
    void slotId
  }

  const cancelSubmit = (session?: SlotSession) => {
    if (session?.submit) {
      clearTimeout(session.submit.timer)
      session.submit = undefined
    }
  }
  const candidateFor = (id: unknown) => discoverAgents().candidates.find(item => item.flavor === id)
  const zcode = () => {
    if (!plugins.has('zcode')) throw Error('请先安装 ZCode 插件')
    const candidate = candidateFor('zcode')
    if (candidate?.status !== 'desktop' || !candidate.executable) throw Error('未检测到 ZCode 桌面版，请重新检测')
    return candidate.executable
  }

  return {
    discover: () => ({ ...discoverAgents(), installed: plugins.list() }),
    catalog: (repository: string) => plugins.catalog(repository),
    install: (id: TerminalPluginId, repository?: string) => plugins.install(id, repository),
    remove: (id: TerminalPluginId) => {
      for (const session of sessions.values()) if (session.provider === id) cancelSubmit(session)
      return plugins.remove(id)
    },
    desktop: async () => {
      const error = await shell.openPath(zcode())
      if (error) throw Error('无法打开 ZCode 桌面版：' + error)
    },
    copyDesktopTask: (text: string) => {
      zcode()
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw Error('请选择不超过 8000 字符的笔记任务')
      clipboard.writeText(text)
    },

    open(input: PlateTerminalSlotOpenInput): PlateTerminalSlotOpenResult {
      if (!plugins.has(input?.provider)) throw Error('请先在插件中心安装此 Agent 插件')
      const candidate = candidateFor(input.provider)
      if (!candidate || candidate.status !== 'startable' || !candidate.argv || !candidate.executable) {
        throw Error('未发现可启动的终端，请重新检测')
      }
      if (!input.identity || typeof input.identity.missionId !== 'string'
        || typeof input.identity.slotId !== 'string' || typeof input.identity.roleLabel !== 'string'
        || input.identity.runtimeId !== candidate.flavor + ':' + candidate.executable) {
        throw new Error('槽位身份不完整')
      }
      const host = getSlots()
      const base = join(deps.userDataDir(), 'terminal-workspaces')
      mkdirSync(base, { recursive: true })
      const workingDirectory = mkdtempSync(join(base, 'slot-'))
      const { id, pid } = host.open({
        argv: candidate.argv,
        runAsNode: candidate.flavor === 'deepseek-harness' && candidate.bundledLauncher && candidate.env?.ELECTRON_RUN_AS_NODE === '1',
        cwd: workingDirectory,
        cols: input.cols,
        rows: input.rows,
      })
      const session: SlotSession = {
        identity: { ...input.identity, sessionId: null, processId: pid },
        pending: Buffer.alloc(0),
        provider: candidate.flavor,
        codexReady: false,
        readyTail: '',
        armed: false,
        unsubscribe: host.subscribe(id, {
          onData: (chunk) => {
            if (session.provider === 'codex') {
              const plain = chunk.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
              const waiting = session.submit
              if (waiting && !waiting.seen) {
                waiting.echo = (waiting.echo + chunk.toString('utf8')).slice(-32768)
                const echo = waiting.echo.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '')
                // Wait for the *end* of the prompt (or the large-paste placeholder).
                // A delay from WriteFile alone races the Windows console input queue.
                if (echo.includes(waiting.marker) || /\[Pasted(?:Content|text)\d+chars\]/i.test(echo)) {
                  waiting.seen = true
                  clearTimeout(waiting.timer)
                  waiting.timer = setTimeout(() => {
                    if (sessions.get(id) !== session || session.submit !== waiting) return
                    session.submit = undefined
                    if (getSlots().state(id)?.exited !== false) return
                    try { if (plugins.has(session.provider)) getSlots().write(id, '\r') } catch { /* Never retry an uncertain write. */ }
                  }, 250)
                }
              }
              session.readyTail = (session.readyTail + plain).slice(-768)
              if (/Ask Codex to do anything/i.test(session.readyTail)) {
                session.codexReady = true
                session.readyTail = ''
              }
            }
            pushData({ slotId: id, data: new Uint8Array(chunk) })
            handleLines(id, session, consumeLines(session, chunk))
          },
          onExit: (exitCode, dropped) => {
            cancelSubmit(session)
            session.codexReady = false
            pushExit({ slotId: id, exitCode, dropped })
          },
        }),
      }
      sessions.set(id, session)
      return { slotId: id, processId: pid }
    },

    write(slotId: number, data: string): void {
      if (typeof data !== 'string') throw new Error('终端输入必须是字符串')
      const session = sessions.get(slotId)
      // xterm also reports focus, hover and device queries on its data channel.
      // Those do not edit the input buffer and must not cancel the staged Enter.
      const isTerminalReport = /^(?:\x1b\[(?:[IO]|<35;\d+;\d+M|[?>]?[\d;]+[cRn]))+$/.test(data)
      if (!isTerminalReport) cancelSubmit(session)
      if (session && !isTerminalReport) {
        session.codexReady = false
        session.readyTail = ''
      }
      getSlots().write(slotId, data)
    },

    resize(slotId: number, cols: number, rows: number): void {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        throw new Error('终端尺寸无效')
      }
      getSlots().resize(slotId, cols, rows)
    },

    sigint(slotId: number): void {
      cancelSubmit(sessions.get(slotId))
      getSlots().sigint(slotId)
    },

    terminate(slotId: number): void {
      cancelSubmit(sessions.get(slotId))
      getSlots().terminate(slotId)
    },

    close(slotId: number): void {
      cancelSubmit(sessions.get(slotId))
      sessions.get(slotId)?.unsubscribe()
      sessions.delete(slotId)
      slots?.close(slotId)
    },

    deliver(input: PlateTerminalDeliverInput): PlateTerminalDeliverResult {
      if (!input || typeof input.text !== 'string' || input.text.length === 0) {
        throw new Error('投递资料不能为空')
      }
      const session = sessions.get(input.terminalSlotId)
      if (session && (session.identity.missionId !== input.target?.missionId ||
          session.identity.slotId !== input.target?.slotId || session.identity.runtimeId !== input.target?.runtimeId)) {
        throw new Error('当前槽位已变化，任务未写入其他终端')
      }
      const note = input.note
      if (note && (!/^[a-f0-9-]{36}$/i.test(note.id) || !/^[a-f0-9-]{36}$/i.test(note.requestId) ||
          typeof note.revision !== 'string' || !note.revision || note.revision.length > 2048 || input.text.length > 8000)) {
        throw new Error('笔记任务快照无效')
      }
      const preset: RolePresetId | null = input.preset ?? null
      const pkg: ContextPackage = {
        contextVersionId: note ? 'ctx-note-' + note.requestId : `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        contentHash: `sha256:${createHash('sha256').update(note ? JSON.stringify([note.id, note.revision, input.text]) : input.text, 'utf8').digest('hex')}`,
        createdAt: Date.now(),
        blocks: [{ noteId: note?.id ?? 'manual', blockId: note ? 'selection-' + note.requestId : 'manual-1', text: input.text }],
        preset,
      }
      const result = log.deliver({
        target: session?.identity ?? input.target,
        terminalSlotId: sessions.has(input.terminalSlotId) ? input.terminalSlotId : null,
        pkg,
        send: (envelope) => {
          if (!session) return { ok: false, reason: '槽位不在线，未写入终端' }
          try {
            const prompt = note || session.provider === 'codex'
              ? '请处理以下 Plate 笔记任务或文字选区：' + JSON.stringify(envelope).replace(/[\u0080-\u009f\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
              : envelope.replace(/\n/g, '\r')
            if (!plugins.has(session.provider)) return { ok: false, reason: '该 Agent 插件已移除' }
            const id = input.terminalSlotId
            if (session.provider === 'codex') {
              if (session.submit || !session.codexReady) {
                return { ok: false, reason: 'Codex 尚未进入可发送的空输入框；请等待当前操作结束，再发送任务。' }
              }
              session.codexReady = false
              session.readyTail = ''
              getSlots().write(id, prompt)
              const timer = setTimeout(() => {
                // No reliably observed draft. Leave it for the user to inspect; never resend.
                if (sessions.get(id) === session) session.submit = undefined
              }, 10000)
              session.submit = { marker: pkg.contentHash.slice(-22) + ']"', timer, echo: '', seen: false }
            } else {
              getSlots().write(id, prompt + '\r')
            }
            session.armed = false
            return { ok: true }
          } catch (error) {
            return { ok: false, reason: String(error) }
          }
        },
      })
      return { action: result.action, attempt: result.attempt }
    },

    attempts: () => log.list(),
  }
}
