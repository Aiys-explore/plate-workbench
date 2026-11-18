import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { SessionDashboard, SessionMessage, SessionStatus, SessionSummary } from '../../shared/sessions'
import { ResumeControls, resumeLog } from './resume'

const labels: Record<SessionStatus, string> = {
  PENDING: '等待中', ERROR: '错误', REVIEW: '待确认', STARTING: '启动中',
  DOING: '执行中', DONE: '已完成', PAUSED: '已暂停', UNKNOWN: '未知'
}
export const sessionAgentNames = { codex: 'Codex', deepseek: 'DeepSeek Harness', zcode: 'ZCode' }
const names = sessionAgentNames
const number = (value: number) => value.toLocaleString('zh-CN')
const dayTime = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false })
const keyOf = (s: Pick<SessionSummary, 'adapter' | 'id'>) => s.adapter + ':' + s.id
const groups = [
  { key: 'attention', name: '需要你', states: ['PENDING', 'ERROR'] },
  { key: 'review', name: '待看', states: ['REVIEW'] },
  { key: 'working', name: '工作中', states: ['STARTING', 'DOING'] },
  { key: 'done', name: '已完成', states: ['DONE'] },
  { key: 'other', name: '暂停与未知', states: ['PAUSED', 'UNKNOWN'] }
] as const
const groupOf = (status: SessionStatus) => groups.find(g => (g.states as readonly string[]).includes(status))!.key
const working = (s: SessionSummary) => groupOf(s.status) === 'working'
const validSession = (s: SessionSummary) => !!s && Object.hasOwn(names,s.adapter) && Object.hasOwn(labels,s.status) &&
  typeof s.id==='string' && !!s.id && !!s.usage && typeof s.usage==='object'

export function useSessionDashboard() {
  const [data, setData] = useState<SessionDashboard>()
  const [failed, setFailed] = useState(false)
  const [observedAt, setObservedAt] = useState<number>()
  const [reading,setReading]=useState(true)
  const retry=useRef<()=>void>(()=>{})
  useEffect(() => {
    let active = true
    let timer: number
    let request=0
    const poll = async (manual=false) => {
      clearTimeout(timer)
      const current=++request
      if (manual) setReading(true)
      try {
        const value = await window.workbench.sessions.dashboard()
        const ids=new Set<string>()
        if (!Array.isArray(value?.sessions) || !value.today) throw new Error('会话列表结构无效')
        const sessions=value.sessions.filter(s=>{
          if(!validSession(s) || ids.has(keyOf(s)))return false
          ids.add(keyOf(s));return true
        })
        if (active && current===request) { setData({...value,sessions}); setObservedAt(Date.now()); setFailed(false) }
      } catch { if (active && current===request) setFailed(true) }
      if (active && current===request) {
        setReading(false)
        timer = window.setTimeout(()=>void poll(), 750)
      }
    }
    const changed=()=>void poll(true)
    const removed=()=>{setData(undefined);changed()}
    window.addEventListener('p11-removed',removed)
    window.addEventListener('p11-unknown',removed)
    retry.current=changed
    void poll()
    return () => { active = false; clearTimeout(timer);window.removeEventListener('p11-removed',removed);window.removeEventListener('p11-unknown',removed) }
  }, [])
  return { data, failed, observedAt, reading, retry:retry.current }
}

function duration(session: SessionSummary, now: number) {
  const { turnStartedAt: start, turnStoppedAt: stop, status } = session
  if (start === null) return '未知'
  const end = working(session) || status === 'PENDING' ? now : stop
  if (end === null || end < start) return '未知'
  const seconds = Math.floor((end - start) / 1000)
  const rest = [Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':')
  return seconds >= 3600 ? Math.floor(seconds / 3600) + ':' + rest : rest
}

function ContextReadout({ session }: { session: SessionSummary }) {
  const { contextWindow: windowSize, recentContext: recent, contextOccupancy: occupancy } = session
  const ratio = occupancy && Number.isSafeInteger(occupancy.window) && occupancy.window > 0 &&
    Number.isSafeInteger(occupancy.used) && occupancy.used >= 0 && occupancy.used <= occupancy.window
    ? occupancy.used / occupancy.window : null
  return <div className="session-context" title={[occupancy?.source, recent?.source, windowSize?.source].filter(Boolean).join(' / ')}>
    <span>上下文 <strong>{ratio === null ? '占用未知' : (ratio * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%'}</strong></span>
    {ratio !== null ? <><meter min={0} max={occupancy!.window} value={occupancy!.used} aria-label="已观测上下文占用" />
      <small>{number(occupancy!.used)} / {number(occupancy!.window)} · 已观测</small></> :
      (windowSize || recent) && <small>{recent && '最近请求 ' + number(recent.value)}{recent && windowSize && ' · '}
        {windowSize && '窗口 ' + number(windowSize.value)}</small>}
  </div>
}

export type ConversationMemory = {
  owner: string
  snapshot?: { revision: string; total: number; items: SessionMessage[] }
  full: boolean
  stale: boolean
  scroll: number
  anchor?: {offset:number;y:number}
  control?: string
}
function Chat({ session, available, scroller, memory }: {
  session: SessionSummary; available: boolean; scroller: React.RefObject<HTMLDivElement | null>
  memory: React.RefObject<ConversationMemory | undefined>
}) {
  const saved = memory.current?.owner === keyOf(session) ? memory.current : undefined
  const [snapshot, setSnapshot] = useState(saved?.snapshot)
  const [full, setFull] = useState(saved?.full ?? false)
  const [busy, setBusy] = useState(false)
  const [copying, setCopying] = useState(false)
  const [stale, setStale] = useState(saved?.stale || !!(saved?.snapshot && session.messageRevision && saved.snapshot.revision !== session.messageRevision))
  const [notice, setNotice] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const chatHeading = useRef<HTMLElement>(null)
  const active = useRef<symbol | null>(null)
  const copyRequest = useRef<symbol | null>(null)
  const position = useRef<{ offset: number; y: number; focus: boolean } | 'bottom' | undefined>(undefined)
  const interacted = useRef(false)
  const priorRevision = useRef(session.messageRevision)
  const { adapter, id, messageRevision } = session
  useLayoutEffect(() => { if (saved?.snapshot) interacted.current = true },[])
  useLayoutEffect(() => {
    if (memory.current?.owner !== keyOf(session)) return
    Object.assign(memory.current,{snapshot,full,stale})
  },[snapshot,full,stale,adapter,id,memory])
  useLayoutEffect(() => {
    if (priorRevision.current !== messageRevision) {
      priorRevision.current = messageRevision
      if (snapshot?.revision === messageRevision) setStale(false)
      else if (snapshot) setStale(true)
    }
  }, [messageRevision, snapshot])
  useLayoutEffect(() => {
    const pane = scroller.current
    const target = position.current
    position.current = undefined
    if (!pane || !target) return
    if (target === 'bottom') {
      pane.scrollTop = pane.scrollHeight
      return
    }
    const message = list.current?.querySelector<HTMLElement>(`[data-message-offset="${target.offset}"]`)
    if (!message) return
    pane.scrollTop += message.getBoundingClientRect().top - pane.getBoundingClientRect().top - target.y
    if (target.focus) message.focus({ preventScroll: true })
  }, [snapshot, scroller])

  const read = async (older = false, explicit = false) => {
    if (!available || active.current) return
    const before = older ? snapshot?.items[0]?.offset : undefined
    if (older && (!snapshot || before === undefined || before <= 1 || stale)) return
    const request = Symbol()
    active.current = request
    setBusy(true); setNotice('')
    try {
      const startingRevision = priorRevision.current
      const reloadControl = explicit && !older && document.activeElement instanceof HTMLElement && document.activeElement.dataset.chatControl==='reload'
        ? document.activeElement : undefined
      const pagingHadFocus = document.activeElement?.hasAttribute('data-page-older') === true
      const page = await window.workbench.sessions.messagePage(adapter, id,
        older && snapshot && before !== undefined ? { revision:snapshot.revision,before } : undefined)
      if (active.current !== request) return
      if (page.adapter !== adapter || page.id !== id || page.status !== 'ok' ||
        !/^[a-f0-9]{64}$/.test(page.revision) || !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.before !== (before ?? null) || !Array.isArray(page.items) || page.items.length !== Math.min(5, (before ?? page.total + 1) - 1) ||
        page.items.some((item, index) => !item || typeof item.text!=='string' || !['user','assistant'].includes(item.role) ||
          (item.at!==null && (typeof item.at!=='number' || !Number.isFinite(item.at) || Math.abs(item.at)>8.64e15)) ||
          item.offset !== (before ?? page.total + 1) - page.items.length + index) ||
        (older && (!snapshot || page.revision !== snapshot.revision || page.total !== snapshot.total ||
          (startingRevision !== priorRevision.current && priorRevision.current !== page.revision)))) {
        setStale(true)
        setNotice(page.status === 'missing' ? '会话已不可用。' : '无法核对分页快照，请重新读取最新消息。')
        return
      }
      const pane = scroller.current
      if (older && snapshot && pane) {
        const viewport = pane.getBoundingClientRect()
        const firstVisible = [...(list.current?.children ?? [])].find(el => {
          const rect = el.getBoundingClientRect()
          return rect.bottom > viewport.top && rect.top < viewport.bottom
        }) as HTMLElement | undefined
        const anchor = firstVisible ?? list.current?.firstElementChild as HTMLElement | undefined
        if (anchor) position.current = {
          offset: Number(anchor.dataset.messageOffset), y: anchor.getBoundingClientRect().top - viewport.top,
          focus: page.items[0]?.offset === 1 && pagingHadFocus && document.activeElement?.hasAttribute('data-page-older') === true
        }
      } else if (explicit || !interacted.current) position.current = 'bottom'
      setSnapshot({ revision:page.revision, total:page.total,
        items: older && snapshot ? [...page.items,...snapshot.items] : page.items })
      setFull(older)
      setStale(false)
      if(reloadControl && document.activeElement===reloadControl) chatHeading.current?.focus({preventScroll:true})
    } catch {
      if (active.current !== request) return
      if (!older && snapshot) setStale(true)
      setNotice(older ? '未能读取更早消息，请重试同一页。' : '无法读取最新消息，请重试。')
    } finally {
      if (active.current === request) { active.current = null; setBusy(false) }
    }
  }
  useLayoutEffect(() => {
    if (available && !snapshot) void read()
    else { setBusy(false); setCopying(false) }
    return () => { active.current = null; copyRequest.current = null }
  }, [adapter, id, available])
  const items = snapshot?.items ?? []
  const earlier = (items[0]?.offset ?? 0) > 1
  const copy = async () => {
    if (!available || busy || stale || copyRequest.current || !items.length) return
    const request = Symbol()
    copyRequest.current = request
    setCopying(true)
    try {
      await navigator.clipboard.writeText(items.map(m => (m.role === 'user' ? '用户' : 'Agent') + '\n' + m.text).join('\n\n'))
      if (copyRequest.current === request) setNotice(`已复制 ${items.length} 条已加载消息。`)
    } catch {
      if (copyRequest.current === request) setNotice('无法访问剪贴板，可直接选择正文复制。')
    } finally {
      if (copyRequest.current === request) { copyRequest.current = null; setCopying(false) }
    }
  }
  const bottom = () => {
    const message = list.current?.lastElementChild as HTMLElement | null
    if (!message || !scroller.current) return
    scroller.current.scrollTop = scroller.current.scrollHeight
    message.focus({ preventScroll:true })
    setNotice('已到最新加载位置。')
  }
  return <div className="session-chat" data-message-revision={snapshot?.revision} onPointerDown={()=>{interacted.current=true}}>
    <div className="session-chat-head"><strong tabIndex={-1} ref={chatHeading}>{full ? '可读对话' : '最近 5 条可读消息'}</strong>
      {available && (full || stale || !snapshot && (!!notice || busy)) &&
        <button type="button" data-chat-control="reload" onClick={() => void read(false,true)} aria-disabled={busy}>重新读取最新</button>}
      {items.length > 0 && <button type="button" disabled={!available || stale} aria-disabled={busy || copying}
        data-chat-control="copy" onClick={() => void copy()}>复制已加载的 {items.length} 条</button>}
    </div>
    {available && !snapshot && busy && <p role="status">正在读取消息…</p>}
    {snapshot && !items.length && <p>没有已识别的文本消息。</p>}
    {items.length > 0 && <small>已加载 {items.length} 条（第 {items[0].offset}–{items.at(-1)!.offset} 条，共 {snapshot!.total} 条）</small>}
    {stale && snapshot && <p role="status">会话记录可能已变化，以下为上次读取。请重新读取最新消息。</p>}
    {earlier && <button type="button" data-page-older data-chat-control="older" disabled={!available || stale} aria-disabled={busy}
      onClick={() => void read(true)}>{full ? '加载更早 5 条' : '查看完整可读对话'}</button>}
    {full && !earlier && <small>已到最早的可读消息</small>}
    <ol className="session-messages" ref={list}>{items.map(m => <li key={m.offset} data-message-offset={m.offset} data-chat-control={`message-${m.offset}`} tabIndex={-1}>
      <div><strong>{m.role === 'user' ? '用户' : 'Agent'}</strong> {m.at !== null ? <time dateTime={new Date(m.at).toISOString()}>{dayTime(m.at)}</time> : '时间未知'} · {m.source || `${names[adapter]} 本地日志`}</div>
      <MessageText text={m.text}/>
    </li>)}</ol>
    <small>只显示日志里的用户和 Agent 正文。图片、附件、推理和工具内容不在这里显示。</small>
    {items.length > 0 && <button type="button" data-chat-control="bottom" onClick={bottom}>回到底部</button>}
    {notice && <p role="status">{notice}</p>}
  </div>
}

function MessageText({text}: {text:string}) {
  // Preserve every fence and newline verbatim; never interpret log text as HTML.
  const parts: {code:boolean;text:string}[]=[]
  let start=0, cursor=0, fence:RegExpMatchArray|null=null
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []) {
    if (!line) continue
    const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/)
    if (match && !fence) {
      if (cursor>start) parts.push({code:false,text:text.slice(start,cursor)})
      fence=match; start=cursor
    } else if (match && fence && match[1][0]===fence[1][0] && match[1].length>=fence[1].length && !match[2].trim()) {
      parts.push({code:true,text:text.slice(start,cursor+line.length)})
      start=cursor+line.length;fence=null
    }
    cursor+=line.length
  }
  if (start<text.length) parts.push({code:!!fence,text:text.slice(start)})
  return <div className="session-message-text">{parts.map((part,i)=>part.code
    ? <pre key={i} className="session-code-text"><code>{part.text}</code></pre>
    : <span key={i}>{part.text}</span>)}</div>
}

import { SessionActions, usePlaces } from './p11'
import {sessionKey} from '../../shared/p11'

function Card({session, detail}: {session: SessionSummary; detail: () => void}) {
  const {status, adapter, lastAt} = session
  const title = session.project ?? '未识别项目'
  const stamp=lastAt===null?null:new Date(lastAt)
  return <article className="session-row" data-session={keyOf(session)} data-status={status}>
    <button type="button" className="session-expand session-row-open" onClick={detail}>
      <span className="session-line" aria-hidden="true"/>
      <span className="session-row-label">
        <strong>{title}</strong>
        <small>{names[adapter]} · {labels[status]}{session.parentId?' · 子会话':''}{status==='DOING' && session.noProgress?' · 无进展':''}</small>
      </span>
      {stamp && <time title={dayTime(stamp.valueOf())} dateTime={stamp.toISOString()}>
        {stamp.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}
      </time>}
    </button>
  </article>
}

function SessionFacts({session, available, now}: {session:SessionSummary; available:boolean; now:number}) {
  const [notice,setNotice]=useState('')
  const [logs,setLogs]=useState<{path:string;source:string}[]>()
  const [logRead,setLogRead]=useState(false)
  const type=session.adapter==='deepseek'?'deepseek':session.adapter
  const copy=(path:string)=>void navigator.clipboard.writeText(path).then(()=>setNotice('已复制路径。'),()=>setNotice('无法访问剪贴板，可选择路径文字复制。'))
  return <details className="session-info" onToggle={event=>{
    if (!event.currentTarget.open || logRead || !available) return
    setLogRead(true)
    void window.workbench.agents.list().then(profiles=>setLogs(
      [...new Map(profiles.filter(p=>p.enabled && p.type===type && p.logPath).map(p=>[p.logPath,{path:p.logPath,source:p.logSource}])).values()]
    ),()=>setLogs([]))
  }}>
    <summary>会话信息与操作</summary>
    <div className="session-identity-facts">
      <p className="session-identity-value" data-kind="path">工作目录：{session.cwd ?? '未知'}
        {session.cwd && <button type="button" onClick={()=>copy(session.cwd!)}>复制工作目录</button>}</p>
      <p className="session-identity-value" data-kind="id">会话 ID：{session.id}</p>
      <div className="session-log-paths">
        <p>{type==='zcode'?'此 Agent 配置的会话数据库':'此 Agent 配置的日志目录'}（会话来源未逐条核对）</p>
        {logs?.length ? logs.map(log=><div key={log.path}><code>{log.path}</code><small>{log.source}</small>
          <button type="button" onClick={()=>copy(log.path)}>复制日志路径</button></div>) :
          <small>{!available || logs ? '无可显示的配置路径' : '正在读取档案…'}</small>}
      </div>
      <p className="session-model">{session.model ?? '模型未知'} · {session.effort ?? '强度未知'}</p>

    <div className="session-step" title={session.reason}>{session.status === 'PAUSED' || session.status === 'DONE' ? session.reason : session.step ?? session.reason}</div>
    {session.status === 'DOING' && session.noProgress && <div className="session-stall">无进展 · {session.lastAt === null ? '最后事件时间未知' : '最后事件 ' + dayTime(session.lastAt)}</div>}
    <div className="session-facts">
      <span>本轮用时 <strong className="session-timer">{duration(session, now)}</strong></span>
      <span title={session.usageBasis ?? undefined}>已记录 Token <strong>{session.usage.total !== undefined ? number(session.usage.total) : '总数未知'}</strong></span>
    </div>
    {session.usage.total === undefined && (session.usage.input !== undefined || session.usage.output !== undefined) &&
      <small>输入 {session.usage.input === undefined ? '未知' : number(session.usage.input)} · 输出 {session.usage.output === undefined ? '未知' : number(session.usage.output)}</small>}
    <ContextReadout session={session}/>

      {notice && <p role="status">{notice}</p>}
    </div>
    {available && <ConversationActions session={session}/>}
    <ResumeControls origin={available ? resumeLog(session) : undefined}/>
  </details>
}

export type CardBookmark = { key: string; group: string; y: number; siblings: string[]; scroll?: number }
export type SessionPanelMemory = {
  folded: Set<string>; full: boolean; order: Record<string,string[]>;
  anchor?: CardBookmark; consumed?: {key:string;control?:string}
}
const cardEstimate = 60
const bufferCards = 3
const visibleElement = (element: HTMLElement) => element.getClientRects().length > 0

export function SessionPanel({ data, failed, observedAt, reading, retry, collapsed, detail, reveal, memory }: {
  data?: SessionDashboard; failed: boolean; observedAt?: number; reading:boolean; retry:()=>void; collapsed: boolean
  detail: (session: SessionSummary) => void; reveal?: { key: string; control?: string }
  memory: React.RefObject<SessionPanelMemory>
}) {
  const [folded,setFolded] = useState<Set<string>>(()=>memory.current.folded)
  const [full,setFull] = useState(()=>memory.current.full)
  const [safeFull,setSafeFull] = useState(typeof ResizeObserver !== 'function')
  const [geometry,setGeometry] = useState({ top:0, bottom:0 })
  const geometryFrame=useRef<number|undefined>(undefined)
  useEffect(()=>()=>cancelAnimationFrame(geometryFrame.current ?? 0),[])
  const [pins,setPins] = useState<string[]>([])
  const [selection,setSelection] = useState<Map<string,string>>(()=>new Map())
  const [measurement,refreshMeasurements] = useState(0)
  const [missingReveal,setMissingReveal]=useState<string>()
  const retryFocus=useRef(false)
  const order = useRef(memory.current.order)
  const [focusPin,setFocusPin]=useState<{key:string;group:string}>()
  const heights = useRef(new Map<string,number>())
  const anchor = useRef<CardBookmark | undefined>(memory.current.anchor)
  const focused = useRef<(CardBookmark & { control: string }) | undefined>(undefined)
  const panel = useRef<HTMLDivElement>(null)
  const pointer = useRef<number | null>(null)
  useEffect(()=>{
    let frame=0
    const end=(event:PointerEvent)=>{
      if (pointer.current!==event.pointerId) return
      cancelAnimationFrame(frame)
      frame=requestAnimationFrame(()=>{if (pointer.current===event.pointerId) pointer.current=null})
    }
    const blur=()=>{pointer.current=null}
    window.addEventListener('pointerup',end,true)
    window.addEventListener('pointercancel',end,true)
    window.addEventListener('blur',blur)
    return ()=>{
      cancelAnimationFrame(frame)
      window.removeEventListener('pointerup',end,true)
      window.removeEventListener('pointercancel',end,true)
      window.removeEventListener('blur',blur)
    }
  },[])
  const lists = useRef(new Map<string,HTMLDivElement>())
  const consumed = useRef<typeof reveal>(memory.current.consumed)
  const waiting = reveal !== consumed.current ? reveal : undefined
  const waitingSession = data?.sessions.find(s=>keyOf(s)===waiting?.key)
  const missingTarget=!!(reveal && data && !failed && !data.sessions.some(s=>keyOf(s)===reveal.key))
  const waitingGroup = waitingSession && (selection.get(keyOf(waitingSession)) ?? groupOf(waitingSession.status))

  const sessionsByGroup = groups.map(group => {
    const current = new Map(data?.sessions.filter(s => (selection.get(keyOf(s)) ?? (focusPin?.key===keyOf(s) ? focusPin.group : groupOf(s.status))) === group.key).map(s=>[keyOf(s),s]))
    const keys = [...new Set([...(order.current[group.key] ?? []).filter(key=>current.has(key)),...current.keys()])]
    return {group, keys, current, open: waitingGroup === group.key || !folded.has(group.key)}
  })
  const virtual = !full && !safeFull && sessionsByGroup.reduce((n,g)=>n+(g.open?g.keys.length:0),0)>40
  const cards = () => [...(panel.current?.querySelectorAll<HTMLElement>('[data-session]') ?? [])]
  const card = (key: string) => cards().find(el=>el.dataset.session===key && visibleElement(el))
  const header = (group:string) => panel.current?.querySelector<HTMLElement>(`[data-group="${group}"] .session-group-toggle`)
  const panelTitle=()=>panel.current?.parentElement?.querySelector<HTMLElement>('.agent-panel-title') ?? panel.current
  const fallback = (bookmark: CardBookmark) => {
    const i = bookmark.siblings.indexOf(bookmark.key)
    const current = sessionsByGroup.find(g=>g.group.key===bookmark.group)
    const key = i>=0 && current?.open && [...bookmark.siblings.slice(i+1),...bookmark.siblings.slice(0,i).reverse()]
      .find(key=>current.current.has(key))
    return { key, element: header(bookmark.group) ?? panelTitle() }
  }
  function remember() {
    const root = panel.current
    if (!root || !root.clientHeight) return
    const origin = root.getBoundingClientRect().top + root.clientTop
    const first = cards().find(el=>{
      const rect=el.getBoundingClientRect()
      return rect.bottom>origin && rect.top < origin+root.clientHeight
    })
    const group = first?.closest<HTMLElement>('[data-group]')?.dataset.group
    if (first && group) memory.current.anchor=anchor.current={key:first.dataset.session!,group,
      y:first.getBoundingClientRect().top-origin,siblings:order.current[group] ?? [],scroll:root.scrollTop}
  }
  function syncGeometry() {
    if (geometryFrame.current!==undefined) return
    geometryFrame.current=requestAnimationFrame(()=>{
      geometryFrame.current=undefined
      const root=panel.current
      if (!root) return
      const top=root.scrollTop, bottom=top+root.clientHeight
      setGeometry(previous=>Math.abs(previous.top-top)<=1 && Math.abs(previous.bottom-bottom)<=1 ? previous : {top,bottom})
    })
  }
  useLayoutEffect(() => {
    const root = panel.current
    if (!root || collapsed || safeFull || typeof ResizeObserver !== 'function') return
    let width = root.clientWidth
    const observer = new ResizeObserver(entries=>{
      if (width !== root.clientWidth) { width=root.clientWidth; heights.current.clear(); refreshMeasurements(n=>n+1) }
      for (const {target} of entries) {
        if (target===root) { syncGeometry(); continue }
        const element=target as HTMLElement
        const h=element.getBoundingClientRect().height
        if (!h && visibleElement(element)) { setSafeFull(true); continue }
        if (h>0 && Math.abs((heights.current.get(element.dataset.cardSlot!) ?? 0)-h)>.25) {
          heights.current.set(element.dataset.cardSlot!,h)
          refreshMeasurements(n=>n+1)
        }
      }
    })
    observer.observe(root)
    root.querySelectorAll('[data-card-slot]').forEach(slot=>observer.observe(slot))
    return ()=>observer.disconnect()
  },[collapsed,data,full,safeFull,geometry,measurement,folded,pins,selection,reveal])

  useEffect(()=>{
    const changed=()=>{
      const text=document.getSelection()
      const next=new Map<string,string>()
      if (text && !text.isCollapsed && panel.current) {
        for (const el of cards()) {
          const group=el.closest<HTMLElement>('[data-group]')?.dataset.group
          if (group && Array.from({length:text.rangeCount},(_,i)=>text.getRangeAt(i)).some(range=>range.intersectsNode(el)))
            next.set(el.dataset.session!,group)
        }
      }
      setSelection(old=>old.size===next.size && [...next].every(([key,group])=>old.get(key)===group) ? old : next)
    }
    document.addEventListener('selectionchange',changed)
    return ()=>document.removeEventListener('selectionchange',changed)
  },[])

  useLayoutEffect(() => {
    const root=panel.current
    if (!root || collapsed) return
    memory.current.folded=folded; memory.current.full=full
    for (const {group,keys} of sessionsByGroup) order.current[group.key]=keys
    if (missingTarget && missingReveal!==reveal?.key && visibleElement(root) && !root.closest('dialog:not([open])')) {
      if (waiting || root.contains(document.activeElement) || document.activeElement===document.body) panelTitle()?.focus({preventScroll:true})
      setMissingReveal(reveal?.key)
      if (waiting) memory.current.consumed=consumed.current=waiting
    } else if (!missingTarget && missingReveal) setMissingReveal(undefined)
    if (waiting && !missingTarget && data && !failed && visibleElement(root) && !root.closest('dialog:not([open])')) {
      if (waitingGroup && folded.has(waitingGroup)) setFolded(old=>new Set([...old].filter(k=>k!==waitingGroup)))
      const target=card(waiting.key)
      if (!target && waitingSession) return
      if (target) {
        target.scrollIntoView({block:'nearest'})
        target.querySelector<HTMLElement>(waiting.control ?? '.session-expand')?.focus({preventScroll:true})
      }
      memory.current.consumed=consumed.current=waiting
      remember(); syncGeometry()
      return
    }
    if (!waiting && anchor.current && pointer.current===null) {
      const saved=anchor.current
      const alternate = fallback(saved)
      const target=card(saved.key) ?? (alternate.key ? card(alternate.key) : alternate.element)
      // A browser scroll can happen before React receives the scroll event,
      // including focus, reveal and wheel scrolling. Adopt that new anchor.
      if ((saved.scroll===undefined || Math.abs(root.scrollTop-saved.scroll)<=1) && target && root.contains(target) && target!==root)
        root.scrollTop += target.getBoundingClientRect().top-root.getBoundingClientRect().top-root.clientTop-saved.y
    }
    if (focused.current && document.activeElement===document.body) {
      const old=focused.current, alternate=fallback(old)
      const next=card(old.key) ?? (alternate.key ? card(alternate.key) : undefined)
      const target=next?.querySelector<HTMLElement>(old.control) ??
        next?.querySelector<HTMLElement>('.session-expand') ?? alternate.element
      target?.focus({preventScroll:true})
    }
    if (!failed && retryFocus.current) {
      retryFocus.current=false
      if (document.activeElement===document.body) panelTitle()?.focus({preventScroll:true})
    }
    remember(); syncGeometry()
  })

  const previousAnchor=anchor.current
  const activeFocus=focused.current
  const pinned = new Set([...pins,...selection.keys(),waiting?.key,activeFocus?.key,previousAnchor?.key])
  for (const saved of [previousAnchor,activeFocus]) {
    if (saved && !sessionsByGroup.some(g=>g.open && g.current.has(saved.key))) {
      const next=fallback(saved).key
      if(next) pinned.add(next)
    }
  }
  return <div id="agent-content" hidden={collapsed} ref={panel} className="session-panel session-card-panel"
    tabIndex={-1} aria-label="Agent 会话列表" data-windowed={virtual}
    onPointerDownCapture={event=>{if(event.button===0 && event.isPrimary) pointer.current=event.pointerId}}
    onScroll={()=>{remember();syncGeometry()}}
    onKeyDown={event=>{
      if (event.nativeEvent.isComposing || event.keyCode===229) return
      const origin=event.target as HTMLElement
      if ((origin===event.currentTarget || origin.matches('.session-row-open')) &&
        ['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        const keys=sessionsByGroup.flatMap(group=>group.open ? group.keys : [])
        if (!keys.length) return
        const current=keys.indexOf(origin.closest<HTMLElement>('[data-session]')?.dataset.session ?? '')
        const targetIndex=event.key==='Home' ? 0 : event.key==='End' ? keys.length-1 :
          Math.max(0,Math.min(keys.length-1,current+(event.key==='ArrowUp' ? -1 : 1)))
        const next=keys[targetIndex]
        event.preventDefault()
        if (!card(next)) flushSync(()=>setPins([next]))
        if (!card(next)) flushSync(()=>setSafeFull(true))
        const element=card(next)
        element?.querySelector<HTMLElement>('.session-expand')?.focus({preventScroll:true})
        element?.scrollIntoView({block:'nearest'})
        return
      }
      if (!virtual || event.key!=='Tab') return
      const group=origin.closest<HTMLElement>('[data-group]')?.dataset.group
      const list=sessionsByGroup.find(g=>g.group.key===group)
      if (!list) return
      const item=origin.closest<HTMLElement>('[data-session]')
      const key=item?.dataset.session
      const controls=[...(item?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"])') ?? [])].filter(visibleElement)
      const index=key ? list.keys.indexOf(key) : -1
      const previous = sessionsByGroup.slice(0,sessionsByGroup.indexOf(list)).filter(g=>g.keys.length).at(-1)
      const next=event.shiftKey
        ? origin===controls[0] ? list.keys[index-1]
          : origin.matches('.session-group-toggle') && previous?.open ? previous.keys.at(-1) : undefined
        : origin===controls.at(-1) ? list.keys[index+1]
          : origin.matches('.session-group-toggle') && list.open ? list.keys[0] : undefined
      if (next && !card(next)) {
        flushSync(()=>setPins([next]))
        if (!card(next)) flushSync(()=>setSafeFull(true))
      }
    }}
    onFocus={event=>{
      const element = event.target as HTMLElement
      const key=element.closest<HTMLElement>('[data-session]')?.dataset.session
      const group=element.closest<HTMLElement>('[data-group]')?.dataset.group
      setFocusPin(key && group ? {key,group} : undefined)
      focused.current = key && group ? {key,group,y:0,siblings:order.current[group]??[],
        control:'.session-expand'} : undefined
    }} onBlur={event=>{ if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { focused.current=undefined;setFocusPin(undefined) } }}>
    
    {safeFull && <p className="session-empty">无法可靠测量卡片，已显示完整列表。</p>}
    {missingTarget && <p className="session-empty" role="status">目标会话已不在列表。</p>}
    {failed && <div className="session-empty"><span role="status">
      {data ? '刷新会话失败' : '首次读取本机会话失败'}{data && observedAt ? '。上次读取 ' + dayTime(observedAt) : ''}。
      {reading && '正在重试…'}</span>{' '}
      <button type="button" aria-disabled={reading}
        onFocus={()=>{retryFocus.current=true}} onBlur={event=>{if (event.relatedTarget) retryFocus.current=false}}
        onClick={()=>{if(!reading) retry()}}>{data?'立即重试刷新':'立即重试首次读取'}</button></div>}
    {!data ? !failed && <p className="session-empty">正在读取本机会话…</p>
      : !failed && !data.sessions.length && <p className="session-empty">{data.sources
        ? '当前筛选下没有会话，等待本地日志。' : '在设置中启用 Codex、DeepSeek Harness 或 ZCode 档案，即可查看本机会话。'}</p>}
    {data && data.badLines > 0 && <p className="session-empty">部分日志行无法读取（格式错误或超过 1 MiB），对话和统计可能缺失。</p>}
    {!collapsed && sessionsByGroup.map(({group,keys,current,open}) => {
      if (!keys.length) return null
      const list=lists.current.get(group.key)
      const root=panel.current
      const start=list && root && list.clientWidth
        ? list.getBoundingClientRect().top-root.getBoundingClientRect().top-root.clientTop+root.scrollTop : 0
      const offsets=[start]
      for (const key of keys) offsets.push(offsets.at(-1)!+(heights.current.get(key) ?? cardEstimate))
      let first=offsets.findIndex((_,i)=>offsets[i+1]>geometry.top)
      if(first<0) first=keys.length
      let end=offsets.findIndex(y=>y>=geometry.bottom)
      if(end<0) end=keys.length
      const children=[]
      for (let i=0;i<keys.length;) {
        const include=(index:number)=>!virtual || pinned.has(keys[index]) || index>=first-bufferCards && index<end+bufferCards
        if (!include(i)) {
          const from=i
          do {i++} while(i<keys.length && !include(i))
          children.push(<div key={'space:'+keys[from]} aria-hidden="true" data-card-spacer style={{height:offsets[i]-offsets[from]}}/>)
        } else {
          const key=keys[i++], session=current.get(key)!
          children.push(<div key={key} data-card-slot={key}><Card session={session} detail={()=>detail(session)}/></div>)
        }
      }
      return <section key={group.key} className="session-group" data-group={group.key} aria-labelledby={'session-group-' + group.key}>
        <h3 id={'session-group-' + group.key}><button className="session-group-toggle" type="button"
          aria-expanded={open} aria-controls={'session-cards-'+group.key} onClick={()=>setFolded(previous=>{
            if (!previous.has(group.key) && keys.some(key=>selection.has(key) || key===focusPin?.key)) return previous
            const next=new Set(previous)
            if (!next.delete(group.key)) next.add(group.key)
            return next
          })}>{group.name} <span>{keys.length}</span></button></h3>
        <div className="session-card-slots" id={'session-cards-'+group.key}
          ref={element=>{ if(element) lists.current.set(group.key,element); else lists.current.delete(group.key) }}
          hidden={!open}>{open && children}</div>
      </section>
    })}
    {(virtual || full) && !safeFull && <button type="button" className="session-full-list" aria-pressed={full}
      onClick={()=>setFull(value=>!value)}>{full?'恢复精简列表':'显示全部'}</button>}
  </div>
}

function ConversationActions({session}:{session:SessionSummary}) {
  const places=usePlaces(session)
  return <SessionActions session={session} place={places[sessionKey(session)]}/>
}
export function SessionConversation({ session, available, back, close, memory }: {
  session: SessionSummary; available: boolean; back: () => void; close: () => void
  memory: React.RefObject<ConversationMemory | undefined>
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const previous=memory.current?.control, saved=memory.current
    const anchor=saved?.anchor, scroll=saved?.scroll
    const restore=()=>{
      const pane=scroller.current, root=title.current?.closest('.session-conversation')
      if (!pane?.clientHeight || !root) return false
      const row=anchor && pane.querySelector<HTMLElement>(`[data-message-offset="${anchor.offset}"]`)
      if (row && anchor) pane.scrollTop+=row.getBoundingClientRect().top-pane.getBoundingClientRect().top-anchor.y
      else if (scroll!==undefined) pane.scrollTop=scroll
      const target=previous && root.querySelector<HTMLElement>(`[data-chat-control="${CSS.escape(previous)}"]:not([disabled])`)
      ;(target || title.current)?.focus({preventScroll:true})
      return true
    }
    const frame=restore()?undefined:requestAnimationFrame(restore)
    return()=>{if(frame!==undefined)cancelAnimationFrame(frame)}
  }, [])
  const conversation=useRef<HTMLElement>(null)
  useLayoutEffect(()=>{
    const host=conversation.current
    if(!host)return
    // A transient focused control (retry, older page) can disappear after a
    // successful read. Keep keyboard commands inside the active conversation.
    const keepFocus=(event:FocusEvent)=>{
      if(event.relatedTarget)return
      requestAnimationFrame(()=>{if(host.isConnected && document.activeElement===document.body)title.current?.focus({preventScroll:true})})
    }
    host.addEventListener('focusout',keepFocus)
    return()=>host.removeEventListener('focusout',keepFocus)
  },[])
  return <section ref={conversation} className="session-conversation" onFocus={event=>{
    const control=(event.target as HTMLElement).dataset.chatControl
    // Native dialog.showModal() may briefly focus its first button while changing hosts.
    if (memory.current && event.currentTarget.closest('dialog:not([open])')===null) memory.current.control=control
  }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode!==229) { event.preventDefault(); event.stopPropagation(); back() }
  }}>
    <div className="pane-heading session-conversation-heading">
      <button type="button" data-chat-control="back" onClick={back}>返回</button>
      <h2 ref={title} tabIndex={-1}>{names[session.adapter]} · {session.project ?? '未识别项目'}</h2>
      <button type="button" data-chat-control="close" onClick={close}>关闭</button>
    </div>
    <div id="agent-content" ref={scroller} className="session-panel" tabIndex={0} aria-label="会话正文"
      onScroll={event=>{
        const pane=event.currentTarget,saved=memory.current
        if (!saved || !pane.clientHeight || saved.owner!==keyOf(session)) return
        const top=pane.getBoundingClientRect().top
        const row=[...pane.querySelectorAll<HTMLElement>('[data-message-offset]')]
          .find(el=>el.getBoundingClientRect().bottom>top)
        saved.scroll=pane.scrollTop
        saved.anchor=row && {offset:Number(row.dataset.messageOffset),y:row.getBoundingClientRect().top-top}
      }}>
      {session.status === 'PENDING' && <p>{session.reason} · 日志未提供可读原文</p>}
      {session.status === 'ERROR' && <p>{session.reason} · 错误详情未记录</p>}
      {!available && <p role="status">会话已不可用，以下为上次读取。</p>}
      <Chat key={keyOf(session)} session={session} available={available} scroller={scroller} memory={memory}/>
      <SessionFacts key={keyOf(session)} session={session} available={available} now={Date.now()}/>
      <div className="session-disabled">
        <span><button type="button" aria-describedby="session-cancel-reason" disabled>取消运行</button>
          <small id="session-cancel-reason">当前为只读观察</small></span>
      </div>
    </div>
  </section>
}

const metrics = { turns: '今日结束轮次', tokens: '今日 Token', working: '正在工作', active: '今日活跃', waiting: '等待你' }
export type Metric = keyof typeof metrics
function metricValue(metric: Metric, data: SessionDashboard | undefined, failed: boolean): string {
  if (!data?.sources || failed) return '未知'
  switch (metric) {
    case 'working': case 'waiting':
      return data.sessions.length ? number(data.sessions.filter(s => metric === 'working' ? working(s) : s.status === 'PENDING').length) : '未知'
    case 'turns': case 'active': case 'tokens': {
      const m = metric === 'tokens' ? data.today.tokens.total : metric === 'turns' ? data.today.turns : data.today.sessions
      return m.value === null ? '未知' : number(m.value)
    }
  }
}
export function SessionCounts({ data, failed, open }: { data?: SessionDashboard; failed: boolean; open: (metric: Metric) => void }) {
  return <div className="session-sidebar-counts" aria-label="Agent 实时计数">
    <MetricChip metric="working" label="工作中" data={data} failed={failed} open={open} />
    <MetricChip metric="waiting" label="等待" data={data} failed={failed} open={open} />
  </div>
}

const unknownHint = '本地会话日志暂不可用；产生会话并核对后显示数字。'
function MetricChip({ metric, label, data, failed, open }: {
  metric: Extract<Metric, 'working' | 'waiting'>; label: string; data?: SessionDashboard; failed: boolean; open: (metric: Metric) => void
}) {
  const value = metricValue(metric, data, failed)
  const unknown = value === '未知'
  return <button type="button" className={`metric-chip metric-chip-${metric}`} onClick={() => open(metric)}
    title={unknown ? unknownHint : undefined}
    aria-label={unknown ? `${label}：${unknownHint}` : undefined}>
    <span className="metric-status-dot" data-unknown={unknown || undefined} aria-hidden="true" />
    <span>{label}</span>
    <strong data-unknown={unknown || undefined}>{unknown ? '待确认' : value}</strong>
  </button>
}

export function SessionFooter({ data, failed, open, drawer }: {
  data?: SessionDashboard; failed: boolean; open: (metric: Metric | 'usage') => void; drawer?: () => void
}) {
  const today=useRef<HTMLDetailsElement>(null)
  const trigger=useRef<HTMLElement>(null)
  const todayUnknown = failed || !data?.sources || data.today.sessions.value === null
  const collapse=(focus:boolean)=>{if(today.current)today.current.open=false;if(focus)trigger.current?.focus({preventScroll:true})}
  return <footer className="session-footer" aria-label="Agent 会话汇总">
    <div className="session-footer-track">
      <MetricChip metric="working" label="工作中" data={data} failed={failed} open={open} />
      <MetricChip metric="waiting" label="等待" data={data} failed={failed} open={open} />
      <details ref={today} className="session-today" onBlur={event=>{
        if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))collapse(false)
      }} onKeyDown={event=>{
        if(event.key==='Escape' && today.current?.open && !event.nativeEvent.isComposing) {
          event.stopPropagation();event.preventDefault();collapse(true)
        }
      }}>
        <summary ref={trigger}>
          <span className="metric-status-dot metric-status-today" data-unknown={todayUnknown || undefined} aria-hidden="true" />
          今日
        </summary>
        <div className="session-today-options" aria-label="今日会话明细">
          {(Object.keys(metrics) as Metric[]).map(metric=><button type="button" key={metric} onClick={()=>{collapse(true);open(metric)}}>
            {metrics[metric]} <strong>{metricValue(metric,data,failed)}</strong>
            {(metric==='tokens' && metricValue(metric,data,failed)!=='未知' || metric==='turns' && !!data?.today.turns.missing) && <small>部分</small>}
          </button>)}
          <button type="button" onClick={()=>{collapse(true);open('usage')}}>用量统计</button>
        </div>
      </details>
      {failed && <span className="session-scope" role="status">更新失败</span>}
    </div>
    {drawer && <button type="button" aria-label="打开 Agent 面板" onClick={drawer}>Agent</button>}
  </footer>
}

const explanations: Record<Metric, string> = {
  turns: '按日志中本地今日观察到的本轮完成事件计数；待看也计入，未结束或中断不计。',
  tokens: '只加总今日有时间和总数的用量证据；子会话仅计独立响应。无法定位或重复的累计快照不计。',
  working: '包括启动中、工作中和仍无新进展的会话。等待你与待看不计入。',
  active: '本地今日至少有一条带时间的活动事件，每个会话只计一次。',
  waiting: '仅计日志明确等待审批或回答的会话。待看和出错分开显示。'
}
export function SessionDetail({ data, failed, metric, close, jump, openUsage }: {
  data?: SessionDashboard; failed: boolean; metric: Metric; close: () => void; jump: (session: SessionSummary) => void; openUsage: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  const rows = new Map(data?.day.map(d => [keyOf(d), d]))
  const list = !data?.sources || failed ? [] : data.sessions.filter(s => metric === 'working' ? working(s) : metric === 'waiting' ? s.status === 'PENDING'
    : metric === 'turns' ? ((rows.get(keyOf(s))?.endedTurns ?? 0) > 0 || !!rows.get(keyOf(s))?.turns.missing)
    : metric === 'active' ? rows.get(keyOf(s))?.sessions.value != null : rows.has(keyOf(s)))
  const value = metricValue(metric, data, failed)
  const empty: ReactNode = value === '未知' ? '没有足够的可用日志。' : '没有符合条件的会话。'
  return <dialog ref={ref} className="session-detail" aria-labelledby="session-detail-title" onCancel={e => { e.preventDefault(); close() }}>
    <header><h2 id="session-detail-title">{metrics[metric]} · {value}</h2><button type="button" onClick={close}>关闭明细</button></header>
    <p>{explanations[metric]}{data?.timeZone && ' 时区：' + data.timeZone + '。'} 仅覆盖已读取的本地日志。</p>
    {['tokens','turns','active'].includes(metric) && <button type="button" onClick={openUsage}>查看 7 / 30 日用量</button>}
    {list.length ? <ul>{list.map(s => {
      const row = rows.get(keyOf(s))
      const hint = metric === 'tokens' ? (row?.tokenTotal == null ? 'Token 未知' : number(row.tokenTotal) + ' Token' + (row.tokens.total.missing ? '（部分）' : ''))
        : metric === 'turns' ? (row?.endedTurns == null ? '轮次未知' : number(row.endedTurns) + ' 轮' + (row.turns.missing ? '（部分）' : '')) : labels[s.status]
      return <li key={keyOf(s)}><button type="button" onClick={() => jump(s)}>
        <strong>{names[s.adapter]} · {s.project ?? '未识别项目'}</strong><span>{hint}</span>
      </button></li>
    })}</ul> : <p>{empty}</p>}
  </dialog>
}
