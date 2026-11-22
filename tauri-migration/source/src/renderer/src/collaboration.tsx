import { useEffect, useRef, useState } from 'react'
import type {
  ActivityEntry, CollaborationOverview, CollaborationRequestView, HandoffDraftInput,
  MaterialInput, ReviewDraftInput, SendChannel, SlotIdentity,
} from '../../shared/collaboration'
import { deliveryStatusLabels, slotAriaLabel, slotTitle } from '../../shared/collaboration'
import './styles/collaboration.css'

export interface PendingReview {
  materials: MaterialInput[]
  noteTitle?: string
  label?: string
}

const statusChip = (request: CollaborationRequestView) =>
  request.kind === 'handoff' && request.status === 'received' ? '已接手' : deliveryStatusLabels[request.status]

const materialLabel = (material: CollaborationRequestView['materials'][number]) => {
  if (material.kind === 'note-selection') {
    return `${material.noteTitle ?? material.noteId} 第 ${material.lineFrom}–${material.lineTo} 行` +
      (material.blockId ? `（块 ${material.blockId}）` : '（选区快照）')
  }
  return `画板卡片 ${material.cardIds?.length ?? 0} 张（板 ${material.boardId ?? '未知'}）`
}

function SlotTabs({ slots, active, onActivate }: {
  slots: SlotIdentity[]; active: string | null; onActivate: (slotId: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const move = (from: number, step: number) => {
    if (!slots.length) return
    const next = Math.min(slots.length - 1, Math.max(0, from + step))
    onActivate(slots[next].slotId)
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')
      buttons?.[next]?.focus({ preventScroll: true })
    })
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = slots.findIndex(slot => slot.slotId === active)
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowRight') { event.preventDefault(); move(index < 0 ? 0 : index, 1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(index < 0 ? 0 : index, -1) }
    else if (event.key === 'Home') { event.preventDefault(); move(slots.length, -slots.length) }
    else if (event.key === 'End') { event.preventDefault(); move(-1, slots.length) }
  }
  return <div className="collab-slot-tabs" role="tablist" aria-label="协作终端槽位" ref={listRef} onKeyDown={onKeyDown}>
    {slots.map(slot => (
      <button key={slot.slotId} type="button" role="tab" id={`collab-tab-${slot.slotId}`}
        aria-selected={slot.slotId === active} aria-label={slotAriaLabel(slot)}
        tabIndex={slot.slotId === active ? 0 : -1}
        data-slot-disambiguator={slot.shortIndex ?? undefined}
        onClick={() => onActivate(slot.slotId)}>
        <span className="collab-slot-name">{slotTitle(slot)}</span>
        <span className="collab-slot-state">未接入</span>
      </button>
    ))}
  </div>
}

function RequestCard({ request, onConfirm, onCancel, onCopy, onJump, onError }: {
  request: CollaborationRequestView
  onConfirm: (requestId: string, channel: SendChannel) => unknown
  onCancel: (requestId: string) => unknown
  onCopy: (requestId: string) => unknown
  onJump: (noteId: string) => void
  onError: (message: string) => void
}) {
  const busy = useRef(false)
  const act = async (run: () => unknown) => {
    if (busy.current) return
    busy.current = true
    try { await run() } catch (error) { onError(String(error)) } finally { busy.current = false }
  }
  return <article className="collab-request" data-status={request.status} data-kind={request.kind}>
    <header>
      <strong>{request.kind === 'handoff' ? '转交' : '发给审查'} · {statusChip(request)}</strong>
      <time>{new Date(request.createdAt).toLocaleString('zh-CN')}</time>
    </header>
    {request.kind === 'review'
      ? request.message && <p className="collab-request-message">{request.message}</p>
      : <p className="collab-request-message">已完成：{request.doneText} · 待继续：{request.todoText}
        {request.blockerNote ? ` · 阻塞：${request.blockerNote}` : ''}</p>}
    <ul className="collab-materials">
      {request.materials.map((material, index) => <li key={index}>
        <span>{materialLabel(material)}</span>
        {material.kind === 'note-selection' && material.noteId &&
          <button type="button" disabled={!request.sourceAvailableNow}
            data-tip={request.sourceAvailableNow ? '跳转到当前来源' : '来源已失效，仅保留发送快照'}
            onClick={() => material.noteId && onJump(material.noteId)}>查看当前来源</button>}
        <code title={material.snapshotText}>{material.snapshotText.length > 60
          ? material.snapshotText.slice(0, 60) + '…' : material.snapshotText}</code>
      </li>)}
    </ul>
    {request.artifact && <p className="collab-artifact">产物：{request.artifact.name}
      {request.artifact.availableNow ? '' : '（文件已不可用，仅保留哈希）'}</p>}
    <footer>
      {request.status === 'draft' && <>
        <button type="button" onClick={() => act(() => onConfirm(request.requestId, 'copy'))}>复制发送</button>
        <button type="button" data-tip="未接入已验证投递管道时会明确报错，不会伪造成已发出"
          onClick={() => act(() => onConfirm(request.requestId, 'pipe'))}>管道发送</button>
        <button type="button" onClick={() => act(() => onCancel(request.requestId))}>取消</button>
      </>}
      {(request.status === 'draft' || request.status === 'copied') &&
        <button type="button" onClick={() => act(async () => {
          const result = await window.workbench.collaboration.copyRequestText(request.requestId)
          if ('error' in result) onError(result.error)
        })}>复制文本</button>}
      {request.status === 'received' && request.receiptEvidence &&
        <small>回执：{request.receiptEvidence.slice(0, 24)}…</small>}
      {request.status === 'uncertain' && <small>发送不明：重启后不会自动补发。</small>}
    </footer>
  </article>
}

export function CollaborationView({ pending, onConsumePending, onOpenNote }: {
  pending: PendingReview | null
  onConsumePending: () => void
  onOpenNote: (noteId: string) => void
}) {
  const [overview, setOverview] = useState<CollaborationOverview>()
  const [missionId, setMissionId] = useState<string | null>(null)
  const [slotId, setSlotId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'review' | 'handoff' | null>(null)
  const [rename, setRename] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [slotDraft, setSlotDraft] = useState({ role: '', providerFlavor: 'claude-code', providerName: '' })
  const [handoffDraft, setHandoffDraft] = useState({ from: '', to: '', done: '', todo: '', blocker: '', artifact: '' })
  const [reviewDraft, setReviewDraft] = useState<{ missionId: string; toSlotId: string; message: string }>()

  const refresh = async () => {
    const next = await window.workbench.collaboration.overview()
    setOverview(next)
    return next
  }
  useEffect(() => { void refresh() }, [])

  const task = overview?.tasks.find(entry => entry.missionId === missionId) ?? overview?.tasks[0] ?? null
  useEffect(() => {
    if (task && missionId !== task.missionId) { setMissionId(task.missionId); setSlotId(task.slots[0]?.slotId ?? null) }
    if (!task && missionId !== null) { setMissionId(null); setSlotId(null) }
  }, [task, missionId])
  const activeSlot = task?.slots.find(slot => slot.slotId === slotId) ?? task?.slots[0] ?? null
  useEffect(() => { setRename(activeSlot?.displayName ?? '') }, [activeSlot?.slotId, activeSlot?.displayName])

  useEffect(() => {
    if (!pending || pending.materials.length === 0 || dialog) return
    setDialog('review')
  }, [pending, dialog])

  const taskRequests = overview?.requests.filter(request => request.missionId === task?.missionId) ?? []
  const taskActivities = overview?.activities.filter(entry => entry.missionId === task?.missionId) ?? []

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setError('')
    try {
      await action()
      await refresh()
      after?.()
    } catch (cause) {
      setError(String(cause))
    }
  }

  const consumePending = (input: { missionId: string; toSlotId: string }): ReviewDraftInput | null => {
    if (!pending || pending.materials.length === 0) return null
    onConsumePending()
    return { missionId: input.missionId, toSlotId: input.toSlotId, message: reviewDraft?.message ?? '', materials: pending.materials }
  }

  const openHandoff = () => {
    const from = activeSlot?.slotId ?? task?.slots[0]?.slotId ?? ''
    const to = task?.slots.find(slot => slot.slotId !== from)?.slotId ?? ''
    setHandoffDraft({ from, to, done: '', todo: '', blocker: '', artifact: '' })
    setDialog('handoff')
  }

  return <section className="collaboration" aria-label="协作">
    <aside className="pane collab-tasks" aria-label="协作任务">
      <div className="pane-heading"><h2 tabIndex={-1}>协作任务</h2></div>
      <div className="collab-task-list">
        {overview?.tasks.map(entry => <button key={entry.missionId} type="button"
          aria-pressed={entry.missionId === task?.missionId}
          onClick={() => { setMissionId(entry.missionId); setSlotId(entry.slots[0]?.slotId ?? null) }}>
          <span>{entry.title}</span>
          <small>{entry.slots.length} 个槽位</small>
        </button>)}
        {overview && overview.tasks.length === 0 && <p className="collab-empty">暂无协作任务。先新建一个任务，再添加角色槽位。</p>}
      </div>
      <form className="collab-form" onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          const result = await window.workbench.collaboration.createTask(newTaskTitle)
          if ('error' in result) { setError(result.error); return }
          setNewTaskTitle('')
        })
      }}>
        <label htmlFor="collab-new-task">新建任务</label>
        <input id="collab-new-task" value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} maxLength={240} />
        <button type="submit" disabled={!newTaskTitle.trim()}>创建</button>
      </form>
    </aside>
    <div className="collab-detail">
      {!task ? <p className="collab-empty">选择或创建一个协作任务。</p> : <>
        <header className="collab-detail-head">
          <h2 tabIndex={-1}>{task.title}</h2>
          <div className="collab-actions">
            <button type="button" onClick={() => setDialog('review')}>发给…</button>
            <button type="button" disabled={task.slots.length < 2} data-tip={task.slots.length < 2 ? '至少两个槽位才能转交' : undefined} onClick={openHandoff}>转交给…</button>
          </div>
        </header>
        <SlotTabs slots={task.slots} active={activeSlot?.slotId ?? null}
          onActivate={next => { setSlotId(next); setError('') }}/>
        {activeSlot && <div className="collab-slot-detail" role="tabpanel" aria-labelledby={`collab-tab-${activeSlot.slotId}`}>
          <p className="collab-slot-status" role="status">状态：未接入真实终端（R3 待接入）。该槽位不显示任何合成日志。</p>
          <form className="collab-form collab-rename" onSubmit={event => {
            event.preventDefault()
            void run(async () => {
              const result = await window.workbench.collaboration.renameRole(
                activeSlot.missionId, activeSlot.slotId, rename, activeSlot.displayVersion)
              if ('error' in result) setError(result.error)
            })
          }}>
            <label htmlFor="collab-role-name">角色显示名（影响之后的显示，不重写历史活动）</label>
            <div>
              <input id="collab-role-name" value={rename} onChange={event => setRename(event.target.value)} maxLength={80} />
              <button type="submit" disabled={!rename.trim() || rename === activeSlot.displayName}>保存</button>
              <small>版本 v{activeSlot.displayVersion}</small>
            </div>
          </form>
        </div>}
        <form className="collab-form collab-add-slot" aria-label="添加槽位" onSubmit={event => {
          event.preventDefault()
          void run(async () => {
            const result = await window.workbench.collaboration.addSlot(task.missionId, slotDraft)
            if ('error' in result) { setError(result.error); return }
            setSlotDraft({ role: '', providerFlavor: slotDraft.providerFlavor, providerName: slotDraft.providerName })
          }, () => setSlotId(null))
        }}>
          <strong>添加槽位</strong>
          <div className="collab-add-slot-row">
            <label>角色<input aria-label="新槽位角色" value={slotDraft.role}
              onChange={event => setSlotDraft({ ...slotDraft, role: event.target.value })} maxLength={80}/></label>
            <label>提供方类型<select aria-label="新槽位提供方类型" value={slotDraft.providerFlavor}
              onChange={event => setSlotDraft({ ...slotDraft, providerFlavor: event.target.value })}>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="zcode">ZCode</option>
              <option value="deepseek-harness">DeepSeek Harness</option>
              <option value="other">其他</option>
            </select></label>
            <label>提供方显示名<input aria-label="新槽位提供方显示名" value={slotDraft.providerName}
              onChange={event => setSlotDraft({ ...slotDraft, providerName: event.target.value })} maxLength={80}/></label>
            <button type="submit" disabled={!slotDraft.role.trim() || !slotDraft.providerName.trim()}>添加槽位</button>
          </div>
        </form>
        <section className="collab-requests" aria-label="发送与转交记录">
          <h3>发送与转交</h3>
          {taskRequests.map(request => <RequestCard key={request.requestId} request={request} onError={setError}
            onConfirm={(id, channel) => void run(async () => {
              const result = await window.workbench.collaboration.confirmRequest(id, channel)
              if ('error' in result) setError(result.error)
            })}
            onCancel={id => void run(async () => {
              const result = await window.workbench.collaboration.cancelRequest(id)
              if ('error' in result) setError(result.error)
            })}
            onCopy={id => void run(async () => {
              const result = await window.workbench.collaboration.copyRequestText(id)
              if ('error' in result) setError(result.error)
            })}
            onJump={onOpenNote}/>)}
          {taskRequests.length === 0 && <p className="collab-empty">还没有发送或转交记录。</p>}
        </section>
        <section className="collab-activity" aria-label="任务活动">
          <h3>活动</h3>
          <ul>
            {taskActivities.map(entry => <ActivityRow key={entry.id} entry={entry}/>)}
            {taskActivities.length === 0 && <li className="collab-empty">暂无活动。</li>}
          </ul>
        </section>
      </>}
      {error && <div role="alert" className="collab-error">{error}</div>}
    </div>
    {dialog === 'review' && task && <dialog className="collab-dialog" aria-label="发给指定角色审查" open
      onClose={() => setDialog(null)}
      onCancel={event => { event.preventDefault(); setDialog(null); onConsumePending() }}>
      <form onSubmit={event => {
        event.preventDefault()
        const target = reviewDraft
        if (!target) return
        const input = consumePending(target)
        if (!input) { setError('待发材料为空'); return }
        void run(async () => {
          const result = await window.workbench.collaboration.prepareReview(input)
          if ('error' in result) { setError(result.error); return }
          setDialog(null)
          setMessage('草稿已创建，请在「发送与转交」中确认发送。')
        }, () => setReviewDraft(undefined))
      }}>
        <h2 id="collab-review-title">发给指定角色审查</h2>
        <p className="collab-hint">主进程会核对磁盘版本与选区；未保存的修改不会发送。</p>
        <label>任务
          <select value={reviewDraft?.missionId ?? task.missionId} onChange={event =>
            setReviewDraft({ missionId: event.target.value, toSlotId: '', message: reviewDraft?.message ?? '' })}>
            {overview?.tasks.map(entry => <option key={entry.missionId} value={entry.missionId}>{entry.title}</option>)}
          </select>
        </label>
        <label>接收角色
          <select required value={reviewDraft?.toSlotId ?? ''}
            onChange={event => setReviewDraft({
              missionId: reviewDraft?.missionId ?? task.missionId, toSlotId: event.target.value, message: reviewDraft?.message ?? ''
            })}>
            <option value="" disabled>选择角色槽位</option>
            {(overview?.tasks.find(entry => entry.missionId === (reviewDraft?.missionId ?? task.missionId))?.slots ?? [])
              .map(slot => <option key={slot.slotId} value={slot.slotId}>{slotTitle(slot)}</option>)}
          </select>
        </label>
        <label>说明<textarea value={reviewDraft?.message ?? ''}
          onChange={event => setReviewDraft({
            missionId: reviewDraft?.missionId ?? task.missionId, toSlotId: reviewDraft?.toSlotId ?? '', message: event.target.value
          })}/></label>
        <fieldset>
          <legend>待发材料（{pending?.materials.length ?? 0}）</legend>
          <ul>{pending?.materials.map((material, index) => <li key={index}>
            {material.kind === 'note-selection' ? `文档选区 ${material.lineFrom}–${material.lineTo} 行` : '画板卡片'}</li>)}</ul>
        </fieldset>
        <div className="collab-dialog-actions">
          <button type="submit" disabled={!reviewDraft?.toSlotId || !pending?.materials.length}>保存为草稿</button>
          <button type="button" onClick={() => { setDialog(null); onConsumePending() }}>取消</button>
        </div>
      </form>
    </dialog>}
    {dialog === 'handoff' && task && <dialog className="collab-dialog" aria-label="转交给指定角色" open
      onCancel={event => { event.preventDefault(); setDialog(null) }}>
      <form onSubmit={event => {
        event.preventDefault()
        const input: HandoffDraftInput = {
          missionId: task.missionId, fromSlotId: handoffDraft.from, toSlotId: handoffDraft.to,
          doneText: handoffDraft.done, todoText: handoffDraft.todo, blockerNote: handoffDraft.blocker,
          materials: pending?.materials ?? [], artifactPath: handoffDraft.artifact.trim() || null
        }
        if (input.materials.length === 0 && !input.artifactPath) { setError('转交需要附上材料或产物引用'); return }
        void run(async () => {
          const result = await window.workbench.collaboration.prepareHandoff(input)
          if ('error' in result) { setError(result.error); return }
          onConsumePending()
          setDialog(null)
          setMessage('交接草稿已创建，请在「发送与转交」中确认发送。')
        })
      }}>
        <h2 id="collab-handoff-title">转交给指定角色</h2>
        <p className="collab-hint">交接记录不可变；只有确凿的接手回执才显示「已接手」，也不会自动关闭原槽位。</p>
        <div className="collab-dialog-grid">
          <label>交接人
            <select required value={handoffDraft.from} onChange={event =>
              setHandoffDraft({ ...handoffDraft, from: event.target.value })}>
              <option value="" disabled>选择槽位</option>
              {task.slots.map(slot => <option key={slot.slotId} value={slot.slotId}>{slotTitle(slot)}</option>)}
            </select>
          </label>
          <label>接手人
            <select required value={handoffDraft.to} onChange={event =>
              setHandoffDraft({ ...handoffDraft, to: event.target.value })}>
              <option value="" disabled>选择槽位</option>
              {task.slots.filter(slot => slot.slotId !== handoffDraft.from)
                .map(slot => <option key={slot.slotId} value={slot.slotId}>{slotTitle(slot)}</option>)}
            </select>
          </label>
        </div>
        <label>已完成<textarea required value={handoffDraft.done}
          onChange={event => setHandoffDraft({ ...handoffDraft, done: event.target.value })}/></label>
        <label>待继续<textarea required value={handoffDraft.todo}
          onChange={event => setHandoffDraft({ ...handoffDraft, todo: event.target.value })}/></label>
        <label>阻塞说明（可选）<input value={handoffDraft.blocker}
          onChange={event => setHandoffDraft({ ...handoffDraft, blocker: event.target.value })}/></label>
        <label>产物文件路径（可选，须在任务许可目录内）<input value={handoffDraft.artifact}
          onChange={event => setHandoffDraft({ ...handoffDraft, artifact: event.target.value })}/></label>
        <fieldset>
          <legend>附带材料（{pending?.materials.length ?? 0}）</legend>
          <ul>{pending?.materials.map((material, index) => <li key={index}>
            {material.kind === 'note-selection' ? `文档选区 ${material.lineFrom}–${material.lineTo} 行` : '画板卡片'}</li>)}</ul>
        </fieldset>
        <div className="collab-dialog-actions">
          <button type="submit" disabled={!handoffDraft.from || !handoffDraft.to}>保存为交接草稿</button>
          <button type="button" onClick={() => setDialog(null)}>取消</button>
        </div>
      </form>
    </dialog>}
    {message && <div role="status" className="collab-status">{message}</div>}
  </section>
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const identity = (role: string | null, provider: string | null) =>
    role && provider ? `${role} · ${provider}` : '（用户）'
  return <li data-event={entry.event}>
    <span>{new Date(entry.at).toLocaleString('zh-CN')}</span>
    <strong>{entry.summary}</strong>
    <small>{identity(entry.senderRoleDisplay, entry.senderProvider)} → {identity(entry.recipientRoleDisplay, entry.recipientProvider)}</small>
  </li>
}
