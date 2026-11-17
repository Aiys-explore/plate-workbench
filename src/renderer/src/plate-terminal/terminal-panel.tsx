/**
 * Discovery panel, role presets and live slot panes over the plate-terminal
 * IPC. Delivery here is manual material entry with a host-fixed version; the
 * review-pipeline hookup is a later mission concern.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  DiscoveryResult,
  PlateTerminalDataEvent,
  PlateTerminalExitEvent,
  ProviderCandidate,
  RolePresetId,
  SlotIdentity,
} from '../../../shared/plate-terminal/contract'
import { rolePresets } from '../../../shared/plate-terminal/contract'
import { TerminalPane, type TerminalChannel } from './terminal-pane'
import type { Handoff } from '../home-handoff'
import './terminal-panel.css'

interface OpenSlot {
  slotId: number
  processId: number
  label: string
  identity: SlotIdentity
  exitedCode: number | null
}
export type TerminalActivity = { id: number; label: string; exited: boolean; flavor: string }
export type TerminalIntent = { id: string; flavor?: string; slot?: number; handoff?: Handoff }

const statusLabel: Record<ProviderCandidate['status'], string> = {
  startable: '可启动（登录状态未验证）',
  'not-installed': '未安装',
  desktop: '桌面版',
  'installed-not-wired': '已安装但未接入',
  'detect-failed': '检测失败',
}

export function PlateTerminalPanel({ onActivity, intent }: { onActivity?: (items: TerminalActivity[]) => void; intent?: TerminalIntent }) {
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [preset, setPreset] = useState<RolePresetId>('draft')
  const [slots, setSlots] = useState<OpenSlot[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [material, setMaterial] = useState('')
  const [deliverNote, setDeliverNote] = useState<string | null>(null)
  const [uncertainDelivery, setUncertainDelivery] = useState<{ label: string; id: string; evidence: string }>()
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null)
  const [queued, setQueued] = useState<{ slot: OpenSlot; task: Handoff }>()
  const consumed = useRef<string | undefined>(undefined)
  const sending = useRef(false)
  const channelsRef = useRef(new Map<number, TerminalChannel>())
  const slotCounter = useRef(0)

  useEffect(() => {
    onActivity?.(slots.map(slot => ({ id: slot.slotId, label: slot.label, exited: slot.exitedCode !== null,
      flavor: slot.identity.runtimeId.split(':', 1)[0] })))
  }, [onActivity, slots])

  useEffect(() => {
    let cancelled = false
    const discover = () => void window.workbench.plateTerminal.discover()
      .then((result) => { if (!cancelled) setDiscovery(result) })
      .catch((error: unknown) => { if (!cancelled) setDiscoveryError(error instanceof Error ? error.message : String(error)) })
    discover()
    window.addEventListener('plate-plugins-changed', discover)
    return () => { cancelled = true; window.removeEventListener('plate-plugins-changed', discover) }
  }, [])

  useEffect(() => {
    const offExit = window.workbench.plateTerminal.onExit((event: PlateTerminalExitEvent) => {
      setSlots((previous) => previous.map((slot) => (
        slot.slotId === event.slotId ? { ...slot, exitedCode: event.exitCode } : slot
      )))
    })
    return () => { offExit() }
  }, [])

  const channelFor = (slotId: number): TerminalChannel => {
    const existing = channelsRef.current.get(slotId)
    if (existing) return existing
    const channel: TerminalChannel = {
      write: (data) => {
        void window.workbench.plateTerminal.write(slotId, typeof data === 'string' ? data : new TextDecoder().decode(data))
          .catch(() => undefined)
      },
      resize: (cols, rows) => {
        void window.workbench.plateTerminal.resize(slotId, cols, rows).catch(() => undefined)
      },
      onData: (listener) => window.workbench.plateTerminal.onData((event: PlateTerminalDataEvent) => {
        if (event.slotId === slotId) listener(event.data)
      }),
      onExit: (listener) => window.workbench.plateTerminal.onExit((event) => {
        if (event.slotId === slotId) listener(event.exitCode)
      }),
    }
    channelsRef.current.set(slotId, channel)
    return channel
  }

  const openSlot = async (candidate: ProviderCandidate): Promise<OpenSlot> => {
    if (!candidate.argv || candidate.status !== 'startable' || !discovery?.installed?.some(plugin => plugin.id === candidate.flavor))
      throw new Error('该 Agent 未启用或没有可验证的启动入口')
    const roleLabel = rolePresets.find((p) => p.id === preset)?.label ?? preset
    slotCounter.current += 1
    const slotId = `slot-${slotCounter.current}`
    const identity: SlotIdentity = {
      missionId: 'mission-local',
      slotId,
      roleLabel,
      runtimeId: `${candidate.flavor}:${candidate.executable ?? 'unknown'}`,
      sessionId: null,
      processId: null,
    }
    const result = await window.workbench.plateTerminal.open({ provider: candidate.flavor, identity })
    const slot: OpenSlot = { slotId: result.slotId, processId: result.processId, label: `${candidate.displayName} · ${roleLabel}`, identity, exitedCode: null }
    setSlots(previous => [...previous, slot])
    setSelectedSlotId(result.slotId)
    setOpenError(null)
    return slot
  }
  const fail = (error: unknown) => setOpenError(error instanceof Error ? error.message : String(error))
  const sendTask = async (slot: OpenSlot, task: Handoff) => {
    if (sending.current) return
    sending.current = true
    setQueued(undefined)
    setDeliverNote('正在交接到终端…')
    setUncertainDelivery(undefined)
    try {
      const result = await window.workbench.plateTerminal.deliver({
        target: slot.identity, terminalSlotId: slot.slotId, text: task.text, preset: null,
        note: { id: task.noteId, revision: task.revision, requestId: task.id },
      })
      if (result.action === 'slot-offline') setDeliverNote('终端已离线 · 未写入')
      else if (result.action === 'failed') {
        setDeliverNote('未知 · 无法确认终端接收')
        setUncertainDelivery({ label: slot.label + ' · #' + slot.slotId, id: task.id, evidence: result.attempt.note })
      } else {
        setDeliverNote(result.action === 'sent' ? `已写入 ${slot.label} 的终端 · 未收到 Agent 回执` : '该任务已有交接记录')
      }
    } catch (error) {
      setDeliverNote('未知 · 无法确认终端接收')
      setUncertainDelivery({ label: slot.label + ' · #' + slot.slotId, id: task.id, evidence: String(error) })
    } finally {
      sending.current = false
    }
  }
  useEffect(() => {
    if (!intent || consumed.current === intent.id || (!discovery && intent.flavor)) return
    consumed.current = intent.id
    const run = async () => {
      if ((queued || sending.current) && intent.handoff) throw Error('请先处理上一份待交接任务')
      if (intent.slot !== undefined) {
        const slot = slots.find(item => item.slotId === intent.slot && item.exitedCode === null)
        if (!slot) throw Error('选中的终端已不在线，任务未发送')
        setSelectedSlotId(slot.slotId)
        if (intent.handoff) setQueued({ slot, task: intent.handoff })
      } else if (intent.flavor) {
        const candidate = discovery?.candidates.find(item => item.flavor === intent.flavor)
        if (!candidate) throw Error('未找到对应 Agent，请刷新检测')
        const slot = await openSlot(candidate)
        if (intent.handoff) setQueued({ slot, task: intent.handoff })
      }
    }
    void run().catch(fail)
  }, [intent, discovery, slots])

  const stopSlot = (slotId: number) => {
    void window.workbench.plateTerminal.sigint(slotId).catch(() => undefined)
  }

  const closeSlot = (slotId: number) => {
    void window.workbench.plateTerminal.close(slotId)
      .then(() => {
        channelsRef.current.delete(slotId)
        setSlots((previous) => previous.filter((slot) => slot.slotId !== slotId))
        setSelectedSlotId((previous) => (previous === slotId ? null : previous))
      })
      .catch((error: unknown) => setOpenError(error instanceof Error ? error.message : String(error)))
  }

  const deliverMaterial = () => {
    const slot = slots.find((s) => s.slotId === selectedSlotId && s.exitedCode === null)
    if (!slot) {
      setDeliverNote('先选择一个在线槽位')
      return
    }
    if (!material.trim()) {
      setDeliverNote('资料不能为空')
      return
    }
    window.workbench.plateTerminal.deliver({
      target: slot.identity,
      terminalSlotId: slot.slotId,
      text: material,
      preset,
    })
      .then((result) => {
        setDeliverNote(result.action === 'sent'
          ? `已投递 ${result.attempt.contextVersionId}，等待回执`
          : result.attempt.note)
      })
      .catch((error: unknown) => setDeliverNote(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className="plate-terminal-panel" data-plate-terminal-panel>
      <section className="plate-terminal-panel__discovery" aria-label="Agent 发现">
        <h2>Agent 发现</h2>
        {discoveryError ? <p className="plate-terminal-panel__error">{discoveryError}</p> : null}
        {discovery === null && !discoveryError ? <p>正在检测本机 Agent…</p> : null}
        {discovery && !discovery.installed?.some(plugin => plugin.id !== 'zcode') && <p>在左侧插件中心安装终端插件后，即可打开它。</p>}
        {discovery?.candidates.filter(candidate => candidate.flavor !== 'zcode' &&
          discovery.installed?.some(plugin => plugin.id === candidate.flavor)).map((candidate) => (
          <div key={candidate.flavor} className="plate-terminal-panel__candidate">
            <div className="plate-terminal-panel__candidate-head">
              <strong>{candidate.displayName}</strong>
              <span className={`plate-terminal-panel__status is-${candidate.status}`}>{statusLabel[candidate.status]}</span>
              {candidate.status === 'startable' && candidate.argv
                ? <button type="button" onClick={() => void openSlot(candidate).catch(fail)}>打开槽位</button>
                : null}
            </div>
            <p>{candidate.reason}</p>
          </div>
        ))}
      </section>

      <section className="plate-terminal-panel__presets" aria-label="角色预设">
        <h2>角色预设</h2>
        {rolePresets.map((role) => (
          <label key={role.id}>
            <input type="radio" name="plate-terminal-preset" checked={preset === role.id}
              onChange={() => setPreset(role.id)} />
            {role.label}
          </label>
        ))}
      </section>

      <section className="plate-terminal-panel__slots" aria-label="终端槽位">
        <h2>终端槽位</h2>
        {openError ? <p className="plate-terminal-panel__error">{openError}</p> : null}
        {slots.length === 0 ? <p>尚未打开槽位。</p> : null}
        {slots.map((slot) => (
          <div key={slot.slotId} data-slot-id={slot.slotId} className="plate-terminal-panel__slot"
            data-active={slot.slotId === selectedSlotId || undefined}>
            <div className="plate-terminal-panel__slot-head">
              <button type="button" onClick={() => setSelectedSlotId(slot.slotId)}>
                {slot.label}（pid {slot.processId}）
              </button>
              <span>槽位 #{slot.slotId}</span>
              {slot.exitedCode === null ? (
                <>
                  <button type="button" onClick={() => stopSlot(slot.slotId)}>Ctrl+C 停止</button>
                  <button type="button" onClick={() => closeSlot(slot.slotId)}>关闭</button>
                </>
              ) : <span>已退出（退出码 {slot.exitedCode}）</span>}
            </div>
            {slot.exitedCode === null
              ? <TerminalPane channel={channelFor(slot.slotId)} label={slot.label} />
              : null}
          </div>
        ))}
      </section>

      <section className="plate-terminal-panel__deliver" aria-label="资料投递">
        <h2>资料投递</h2>
        {queued && <div className="home-queued-task">
          <strong>待发送 · {queued.slot.label} · {queued.task.title}</strong>
          <pre>{queued.task.text}</pre>
          <p>等这个原生终端进入输入界面后，发送已选内容。</p>
          <button type="button" disabled={!slots.some(slot => slot.slotId === queued.slot.slotId && slot.exitedCode === null)}
            onClick={() => void sendTask(queued.slot, queued.task).catch(fail)}>发送已选任务</button>
          <button type="button" onClick={() => setQueued(undefined)}>取消</button>
        </div>}
        <textarea value={material} onChange={(event) => setMaterial(event.target.value)}
          rows={6} placeholder="输入要投递的资料文本（投递时固定版本与哈希）" />
        <div className="plate-terminal-panel__deliver-actions">
          <button type="button" onClick={deliverMaterial} disabled={!selectedSlotId}>投递到选中槽位</button>
          {deliverNote ? <span role="status">{deliverNote}</span> : null}
        </div>
        {uncertainDelivery && <details className="plate-delivery-evidence">
          <summary>查看去向与证据</summary>
          <dl><dt>目标终端</dt><dd>{uncertainDelivery.label}</dd><dt>请求 ID</dt><dd>{uncertainDelivery.id}</dd>
            <dt>记录</dt><dd>{uncertainDelivery.evidence}</dd></dl>
        </details>}
      </section>
    </div>
  )
}
