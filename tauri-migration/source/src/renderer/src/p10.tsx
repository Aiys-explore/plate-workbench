import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { scanDelegation } from '../../shared/delegation-markdown'
import type { Action, ActionResult, Review, RunCard, RunState } from '../../shared/p10'
import type { EditorSurface } from './editor/surface'
import { DiagnosticPanel } from './delegation-diagnostic'
import { ResumeReview } from './resume'

export type RuntimeAction = (card: RunCard, action: Action, token?: string, line?: number) => Promise<ActionResult>
const labels: Record<RunState,string> = { STARTING:'启动中',DOING:'执行中',PENDING:'等待中',REVIEW:'待确认',
  DONE:'已完成',ERROR:'错误',PAUSED:'已暂停',UNKNOWN:'未知' }
const marks: Record<RunState,string> = { STARTING:'M7 3v5l3 2', DOING:'M5 3l6 4-6 4z', PENDING:'M5 4v6m4-6v6',
  REVIEW:'M3 7l3 3 5-6', DONE:'M3 7l3 3 5-6', ERROR:'M4 4l6 6m0-6-6 6', PAUSED:'M4 4h6v6H4z', UNKNOWN:'M5 5a2 2 0 1 1 3 2L7 8m0 2v1' }
const writeLabels = { none:'无可写结论', pending:'待回写', written:'已写入', conflict:'修订冲突', failed:'写入失败' }
const clock = (v: number | null) => {
  if (v === null || !Number.isFinite(v) || v < 0) return '未知'
  const s = Math.floor(v / 1000)
  const two = (n:number) => String(n).padStart(2,'0')
  return (s >= 3600 ? Math.floor(s/3600)+':' : '')+two(Math.floor(s/60)%60)+':'+two(s%60)
}
const local = (time?: number) => time === undefined ? '未知' :
  new Date(time).toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'})

export function useP10(noteId: string, action: RuntimeAction, ready: boolean) {
  const [cards,setCards] = useState<RunCard[]>([])
  const latest = useRef(action)
  latest.current = action
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const rows = await window.workbench.p10.list(noteId)
        if (!alive) return
        setCards(old => JSON.stringify(old) === JSON.stringify(rows) ? old : rows)
        if (ready) for (const row of rows) {
          if (!alive) break
          if (row.write === 'pending') await latest.current(row,'auto')
        }
      } catch { /* Last snapshot stays available. */ }
      finally { if (alive) timer = setTimeout(tick,1000) }
    }
    void tick()
    return () => { alive = false; clearTimeout(timer) }
  },[noteId,ready])
  return useMemo(()=>cards.filter(card=>card.noteId === noteId),[cards,noteId])
}

type Slot = { card: RunCard; detail: HTMLElement; status: HTMLElement; region?: HTMLElement; located: boolean }
export function arrangeP10(editor: EditorSurface, cards: RunCard[], previous: Map<string,Slot>, allOpen: Set<string>) {
  if (editor.session.composing) return previous
  const doc = editor.host.ownerDocument
  const root = editor.host.querySelector<HTMLElement>('[data-editor-host=render]')
  if (!root) return previous.size ? new Map<string,Slot>() : previous
  const { raw, projection } = editor.session
  const parsed = scanDelegation(raw)
  const boxes = [...root.querySelectorAll<HTMLElement>('[data-editor-role=task], [data-editor-role=paragraph]')]
  const quotes = [...root.querySelectorAll<HTMLElement>('[data-editor-role=quote]')]
  for (const e of root.querySelectorAll<HTMLElement>('[data-p10-collapsed]')) e.removeAttribute('data-p10-collapsed')
  for (const e of boxes) e.removeAttribute('data-p10-line')
  const next = new Map<string,Slot>()
  const make = (kind: string) => {
    const el=doc.createElement('div')
    el.dataset.p10Slot=kind
    el.contentEditable='false'
    return el
  }
  let recovery: HTMLElement | undefined
  for (const card of cards) {
    const matches = parsed.anchors.filter(a=>a.blockId === card.blockId && a.claimedNoteId === card.noteId)
    const line = matches[0]?.line ?? 0
    const t = line && parsed.taskAt(line)
    const box = card.located && matches.length === 1 && t && !t.issue && t.blockId === card.blockId ?
      boxes.find(e=>Number(e.dataset.p10From) >= projection.lines[line-1] &&
        Number(e.dataset.p10From) < (projection.lines[line] ?? raw.length) &&
        Number(e.dataset.p10To) <= (projection.lines[line] ?? raw.length)) : undefined
    const detail = previous.get(card.runId)?.detail ?? make('detail')
    const status = previous.get(card.runId)?.status ?? make('status')
    if (!box) {
      recovery ??= root.querySelector<HTMLElement>('[data-p10-recovery]') ?? doc.createElement('div')
      recovery.dataset.p10Recovery=''
      if (!recovery.isConnected) root.prepend(recovery)
      if (detail.parentElement !== recovery) recovery.append(detail)
      if (status.parentElement !== detail) detail.prepend(status)
    } else {
      if (detail.previousElementSibling !== box) box.after(detail)
      if (status.parentElement !== box) box.append(status)
      const available = root.getBoundingClientRect().width
      const {anchor,head} = editor.session.selection
      const from = Number(box.dataset.p10From), to = Number(box.dataset.p10To)
      const selecting = root === doc.activeElement && Math.max(anchor,head) >= from && Math.min(anchor,head) <= to
      const contents = [...box.children].filter(e=>e !== status && !e.hasAttribute('data-editor-delegation'))
      const last = contents.at(-1)
      const range = last && doc.createRange()
      if (range && last) range.selectNodeContents(last)
      const edges = range && [...range.getClientRects()]
      const tail = edges?.at(-1)
      const width = status.getBoundingClientRect().width
      const fits = tail && edges?.every(r=>Math.abs(r.top-tail.top)<10) && width > 0 &&
        box.getBoundingClientRect().right - tail.right >= width + 8 && (last?.getBoundingClientRect().height ?? 99) <= 32
      if (available < 560 || selecting || !fits) box.dataset.p10Line=''

    }
    const regionMatch = box && card.region && parsed.resultRegions.find(r=>r.runId===card.region)
    const region = regionMatch ? quotes.find(e=>Number(e.dataset.p10From) >= projection.lines[regionMatch.startLine] &&
      Number(e.dataset.p10To) <= (projection.lines[regionMatch.endLine-1] ?? raw.length)) : undefined
    if (region && !allOpen.has(card.runId)) region.dataset.p10Collapsed=''
    next.set(card.runId,{card,detail,status,region,located:!!box})
  }
  for (const [key,slot] of previous) if (!next.has(key)) { slot.status.remove(); slot.detail.remove() }
  if (!recovery) root.querySelector('[data-p10-recovery]')?.remove()
  return previous.size === next.size && [...next].every(([id, slot])=>{
    const before=previous.get(id)
    return before?.card === slot.card && before.detail === slot.detail && before.status === slot.status &&
      before.region === slot.region && before.located === slot.located
  }) ? previous : next
}

export function P10Cards({ slots, act, opened, changed, editor }: { slots: Map<string,Slot>; act: RuntimeAction;
  opened: Set<string>; changed: () => void; editor: EditorSurface | null }) {
  const [panel,setPanel] = useState<{ run: string; kind: 'done'|'cancel'|'write'|'resume'|'diagnostic'; review?: Review }>()
  const [feedback,setFeedback] = useState('')
  const [working,setWorking] = useState(false)
  const flight = useRef(false)
  const opener = useRef<HTMLElement | undefined>(undefined)
  const bookmark = useRef<ReturnType<EditorSurface['captureBookmark']> | undefined>(undefined)
  const title = useRef<HTMLElement | null>(null)
  const notice = useRef<HTMLElement | null>(null)
  const nextFocus = useRef<'title'|'notice'|undefined>(undefined)
  const leaving = panel && (!slots.has(panel.run) ||
    panel.kind === 'diagnostic' && !slots.get(panel.run)?.card.hasDiagnostic)
  useEffect(()=>{if(leaving && !working) {setPanel(undefined); editor?.focus()}},[leaving,working,editor])
  useLayoutEffect(()=>{
    if (nextFocus.current === 'title') title.current?.focus({preventScroll:true})
    if (nextFocus.current === 'notice') notice.current?.focus({preventScroll:true})
    nextFocus.current=undefined
  },[panel,feedback,working,slots])
  function back() {
    if (flight.current) return
    setPanel(undefined)
    requestAnimationFrame(()=>{
      if (opener.current?.isConnected && !opener.current.matches(':disabled') && opener.current.getClientRects().length) {
        opener.current.focus({preventScroll:true})
      } else if (bookmark.current) editor?.restoreBookmark(bookmark.current)
      else editor?.focus()
    })
  }
  async function run(card: RunCard, action: Action, token?:string, line?:number) {
    if (flight.current) return
    flight.current=true
    setWorking(true)
    try {
      const r = await act(card,action,token,line)
      setFeedback(r.message)
      if (action === 'inspect' || r.review) {
        nextFocus.current='title'
        setPanel({run:card.runId,kind:'write',review:r.review})
      } else {
        nextFocus.current='notice'
        setPanel(undefined)
      }
    } catch { setFeedback('暂时无法完成当前操作。') }
    finally { flight.current=false; setWorking(false) }
  }
  function enter(card: RunCard, kind: 'done'|'cancel'|'write'|'resume'|'diagnostic', button: HTMLElement) {
    if (flight.current || panel) return
    opener.current=button
    bookmark.current=editor?.captureBookmark()
    nextFocus.current='title'
    setFeedback('')
    setPanel({run:card.runId,kind})
    if (kind === 'write') void run(card,'inspect')
  }
  const empty = (e: React.SyntheticEvent) => { e.stopPropagation() }
  const statusText = [...slots.values()].map(s=>labels[s.card.state]).join('、')
  return <>
    <span className="p10m33-sr" aria-live="polite">{statusText}</span>
    {feedback && <span className="p10m33-feedback" tabIndex={-1} ref={notice} role="status">{feedback}</span>}
    {[...slots.values()].map(({card,detail,status,region,located})=>{
      const active = panel?.run === card.runId ? panel : undefined
      const wideIssue = !located || card.issue
      const show = opened.has(card.runId)
      const resultId = 'p10-result-'+card.runId
      const toggle = () => { if (show) opened.delete(card.runId); else opened.add(card.runId); changed() }
      const runLabel = labels[card.state]
      const buttonDisabled = working || !!panel
      const showResume = !located || ['PENDING','PAUSED','ERROR','UNKNOWN'].includes(card.state)
      return <FragmentPair key={card.runId}
        status={createPortal(<div className="p10m33-status" data-design-id="P10.status" data-run-state={card.state}>
          <span className={'p10m33-pill p10m33-pill--'+card.state.toLowerCase()}>
            <svg className="p10m33-pill-icon" aria-hidden="true" viewBox="0 0 14 14"><path d={marks[card.state]} /></svg>{runLabel}
          </span>
          <span className="p10m33-clock" data-design-id="P10.status.clock">用时 {clock(card.durationMs)}</span>
          <span className="p10m33-note">{card.clockSource ?? '来源未知'}{card.stale ? ' · 记录已过时' : ''}</span>
          {card.noProgress && <span className="p10m33-pill p10m33-pill--stall">无进展</span>}
        </div>,status)}
        detail={createPortal(<div className={'p10m33-detail'+(!located?' p10m33-confirm':'')} data-p10-run={card.runId}
          onCopy={empty} onKeyDown={event=>{
            if (event.key === 'Escape' && active && !working && !event.nativeEvent.isComposing && event.keyCode!==229) {
              event.preventDefault();event.stopPropagation();back()
            }
          }}>
          {!located && <strong>待定位的运行</strong>}
          <div className="p10m33-literal">{card.reason}</div>
          {card.lastAt !== undefined && <div className="p10m33-note">最后事件 {local(card.lastAt)}</div>}
          {wideIssue && <div className="p10m33-literal">{card.issue || '当前编辑文字无法唯一挂接原标记。'}</div>}
          <div className="p10m33-write" data-write-state={card.write}><span className="p10m33-note">回写：{writeLabels[card.write]}</span></div>
          {card.waits.map(w=><div className="p10m33-literal task-resume-raw" key={w.id}>
            <div>{w.kind === 'approval' ? '等待审批' : '等待回答'} · {local(w.at)}</div>
            <div>{w.text ?? '原文不可读取'}</div>
          </div>)}
          {showResume && <div className="task-resume-reason">
            {card.resumeRevision ? '可核对原会话并选择恢复方式。' : '暂时无法核对当前轮次的会话 ID。'}</div>}
          <div className="p10m33-confirm-actions">
            {card.hasDiagnostic && <button type="button" className="p10m33-btn-secondary" disabled={buttonDisabled}
              aria-expanded={active?.kind==='diagnostic'} onClick={e=>enter(card,'diagnostic',e.currentTarget)}>查看诊断</button>}
            {showResume && <button type="button" className="p10m33-btn-secondary" disabled={buttonDisabled || !card.resumeRevision}
              aria-expanded={active?.kind==='resume'} onClick={e=>enter(card,'resume',e.currentTarget)}>打开或复制会话</button>}
            {(!located || card.write !== 'none' && card.write !== 'written') &&
              <button type="button" className="p10m33-btn-secondary" disabled={buttonDisabled} onClick={e=>enter(card,'write',e.currentTarget)}>
                {located?'检查回写':'定位任务'}</button>}
            {located && (card.state === 'PAUSED' || card.state === 'ERROR') &&
              <button type="button" className="p10m33-btn-secondary" disabled={buttonDisabled} onClick={()=>void run(card,'reconcile')}>核对运行</button>}
            {card.cancellable && <button className="p10m33-btn-secondary" type="button" disabled={buttonDisabled}
              onClick={e=>enter(card,'cancel',e.currentTarget)}>取消运行</button>}
            {located && card.state === 'REVIEW' && <button className="p10m33-btn-secondary" type="button" disabled={buttonDisabled}
              onClick={e=>enter(card,'done',e.currentTarget)}>确认完成</button>}
            {card.basis?.summary && <button type="button" className="p10m33-btn-secondary" aria-controls={resultId}
              aria-expanded={show} onClick={toggle}>{show?'折叠结论':'展开结论'}</button>}
          </div>
          {active?.kind==='resume' && <ResumeReview origin={showResume && card.resumeRevision ?
            {kind:'run',noteId:card.noteId,blockId:card.blockId,runId:card.runId,revision:card.resumeRevision}:undefined} close={back}/>}
          {active?.kind==='diagnostic' && card.hasDiagnostic && <DiagnosticPanel target={{kind:'p10',
            key:{noteId:card.noteId,blockId:card.blockId,runId:card.runId}}} close={back}/>}
          {active && active.kind!=='resume' && active.kind!=='diagnostic' && <div className="p10m33-confirm">
            <strong className="p10m33-confirm-head" tabIndex={-1} ref={title}>
              {active.kind==='done'?'核对本轮完成':active.kind==='cancel'?'核对取消':'检查回写与定位'}
            </strong>
            <div className="p10m33-confirm-target">轮次 {card.runId} · 任务 {card.blockId}</div>
            {active.kind==='done' && <div>标记本轮已完成。正文、任务框和外部会话不会改变。</div>}
            {active.kind==='cancel' && <div>请求停止本应用正在管理的这一轮。停止后仍可核对记录。</div>}
            {active.review && <div className="p10m33-confirm-target">
              <div>{active.review.reason}</div>
              <div>磁盘修订：{active.review.revision ?? '不可核对'} · 草稿：{active.review.draft?'有':'未检测到'}</div>
              <div>当轮依据：{card.basis?.ref ?? '未知'}</div>
              {active.review.candidates.map(c=><div key={c.line} className="p10m33-candidate">
                <div>候选 · 第 {c.line} 行 · 笔记 {card.noteId}</div><pre>{c.context}</pre>
                <button type="button" className="p10m33-btn-secondary" disabled={working}
                  onClick={()=>void run(card,'inspect',undefined,c.line)}>重新核对此候选</button>
              </div>)}
              <div>当前内容</div><pre>{active.review.current || '无可核对内容'}</pre>
              <div>拟写内容{active.review.action === 'insert' ? ' · 插入' : active.review.action === 'update' ? ' · 仅替换生成区' : ''}</div>
              <pre>{active.review.proposed || '无拟写'}</pre>
            </div>}
            <div className="p10m33-confirm-actions">
              <button className="p10m33-btn-secondary" type="button" aria-disabled={working} onClick={back}>返回</button>
              {active.kind==='done' && <button className="p10m33-btn-primary" type="button" aria-disabled={working || card.state!=='REVIEW'}
                onClick={()=>{if(card.state==='REVIEW')void run(card,'done')}}>标为完成</button>}
              {active.kind==='cancel' && <button className="p10m33-btn-primary" type="button" aria-disabled={working || !card.cancellable}
                onClick={()=>{if(card.cancellable)void run(card,'cancel')}}>确认取消</button>}
              {active.kind==='write' && <>
                <button className="p10m33-btn-secondary" type="button" aria-disabled={working} onClick={()=>void run(card,'inspect')}>重新核对</button>
                {active.review?.token && <button className="p10m33-btn-primary" type="button" aria-disabled={working}
                  onClick={()=>void run(card,active.review?.action==='locate'?'locate':'apply',active.review?.token)}>
                  {active.review.action==='locate'?'确认定位':'应用回写'}</button>}
              </>}
            </div>
          </div>}
          {card.basis?.summary && <div className="p10m33-result" id={resultId} hidden={!show}>
            {!region && <blockquote className="p10m33-quote">{card.basis.summary}</blockquote>}
            <div className="p10m33-metrics">用时 {clock(card.durationMs)} · tokens {card.basis.tokens ?? '未知'}</div>
            <div className="p10m33-note">时间：{card.clockSource ?? '未知'} · 用量：{card.basis.tokenSource ?? '未知'}</div>
          </div>}
        </div>,detail)}
      />
    })}
  </>
}
function FragmentPair({status,detail}:{status:React.ReactNode;detail:React.ReactNode}) { return <>{status}{detail}</> }

