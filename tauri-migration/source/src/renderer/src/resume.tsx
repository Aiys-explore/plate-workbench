import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ResumeAction, ResumeOrigin, ResumeView } from '../../shared/resume'
import type { SessionSummary } from '../../shared/sessions'

type Log = Extract<ResumeOrigin,{kind:'log'}>
export const ResumeConversation = createContext<((log:Log,origin:HTMLElement)=>boolean) | null>(null)
export const resumeLog = (s: SessionSummary): Log | undefined => s.messageRevision
  ? {kind:'log',adapter:s.adapter,id:s.id,revision:s.messageRevision} : undefined
const names: Record<string,string> = {codex:'Codex',deepseek:'DeepSeek Harness',zcode:'ZCode','grok-cli':'Grok CLI'}
const titles: Record<ResumeAction,string> = {
  desktop:'跳回客户端',terminal:'在独立终端继续','copy-id':'复制会话 ID','copy-command':'复制手动恢复命令'
}
const missing='暂时无法核对当前会话 ID。'
const changed='会话记录已变化。请重新核对。'
const closeTicket = (ticket?:string) => {
  if (ticket) void window.workbench.resume.close(ticket).catch(()=>{})
}

export function ResumeControls({origin, disabled, enterLabel='打开或复制会话'}:{
  origin?:ResumeOrigin; disabled?:boolean; enterLabel?:string
}) {
  const [open,setOpen]=useState(false)
  const button=useRef<HTMLButtonElement>(null), why=useId()
  return <>
    <button type="button" className="resume-open" aria-expanded={open} aria-controls={open ? why : undefined}
      aria-describedby={!origin ? why : undefined} disabled={disabled || !origin} ref={button}
      onClick={()=>setOpen(true)}>{enterLabel}</button>
    {!origin && <small className="resume-reason" id={why}>{missing}</small>}
    {open && <ResumeReview id={why} origin={disabled ? undefined : origin} close={()=>{
      setOpen(false)
      requestAnimationFrame(()=>button.current?.focus({preventScroll:true}))
    }}/>}
  </>
}

export function ResumeReview({origin,close,id}:{origin?:ResumeOrigin; close:()=>void; id?:string}) {
  const showConversation=useContext(ResumeConversation)
  const [view,setView]=useState<ResumeView>()
  const [feedback,setFeedback]=useState('')
  const [resultType,setResultType]=useState<'success'|'failure'>()
  const [working,setWorking]=useState(false)
  const [epoch,refresh]=useState(0)
  const [expired,setExpired]=useState(false)
  const title=useRef<HTMLElement>(null), status=useRef<HTMLDivElement>(null), request=useRef<symbol | null>(null), ticket=useRef<string | undefined>(undefined)
  const originKey=origin ? JSON.stringify(origin) : ''
  const last=useRef(originKey), current=useRef(origin)
  current.current=origin
  const hasChanged=last.current!==originKey
  useLayoutEffect(()=>{
    if (last.current===originKey) return
    last.current=originKey
    request.current=null
    closeTicket(ticket.current); ticket.current=undefined
    setView(undefined); setWorking(false); setExpired(true); setFeedback(changed);setResultType('failure')
    title.current?.focus({preventScroll:true})
  },[originKey])
  useLayoutEffect(()=>{ title.current?.focus({preventScroll:true}) },[])
  useLayoutEffect(()=>()=>{request.current=null; closeTicket(ticket.current); ticket.current=undefined},[])
  useEffect(()=>{
    const selection=current.current
    if (!selection || expired) return
    const nonce=Symbol()
    request.current=nonce
    setWorking(true);setFeedback('');setView(undefined);setResultType(undefined)
    closeTicket(ticket.current);ticket.current=undefined
    void window.workbench.resume.review(selection).then(result=>{
      if (request.current!==nonce) {closeTicket(result.ticket);return}
      ticket.current=result.ticket; setView(result)
    },()=>{if(request.current===nonce)setFeedback('暂时无法读取此会话的恢复方式。')}).finally(()=>{
      if(request.current===nonce){request.current=null;setWorking(false)}
    })
    return ()=>{
      if(request.current===nonce) request.current=null
    }
  },[epoch]) // An object change invalidates prior consent; only explicit recheck reads its successor.
  const act=async (action: ResumeAction)=>{
    if (request.current || expired || hasChanged || !ticket.current || !view?.methods.includes(action)) return
    const nonce=Symbol(), token=ticket.current
    request.current=nonce
    setWorking(true);setFeedback('');setResultType(undefined)
    try {
      const result=await window.workbench.resume.act(token,action)
      if(request.current!==nonce) { closeTicket(result.next?.ticket);return }
      ticket.current=result.next?.ticket
      if(result.state==='stale'){setExpired(true);setView(undefined)}
      else if(result.next) setView(result.next)
      setFeedback(result.message)
      setResultType(result.state==='copied' ? 'success' : result.state==='requested' ? undefined : 'failure')
      if(result.state==='stale' || !result.next?.methods.includes(action)) status.current?.focus({preventScroll:true})
    } catch {
      if(request.current===nonce) {
        closeTicket(ticket.current);ticket.current=undefined
        setView(undefined);setFeedback('操作结果无法核对。请检查客户端或剪贴板，再重新核对。')
      }
    } finally {
      if(request.current===nonce){request.current=null;setWorking(false)}
    }
  }
  const shown = hasChanged || expired ? undefined : view
  const finish = () => {
    request.current=null; closeTicket(ticket.current); ticket.current=undefined
    close()
  }
  return <div id={id} className={'resume-panel'+(origin?.kind==='run'?' task-resume-card':'')} data-design-id="M4.1.resume" onKeyDown={e=>{
    if(e.key==='Escape' && !e.nativeEvent.isComposing && e.keyCode!==229) {
      e.stopPropagation();e.preventDefault();finish()
    }
  }}>
    <strong tabIndex={-1} ref={title}>恢复当前会话</strong>
    {shown?.subject && <div className="session-identity-facts">
      <p className="session-identity-value">客户端：{Object.hasOwn(names,shown.subject.agent) ? names[shown.subject.agent] : shown.subject.agent}</p>
      <p className="session-identity-value" data-kind="path">目录：{shown.subject.cwd ?? '未知'}</p>
      <p className="session-identity-value" data-kind="id">会话 ID：{shown.subject.id}</p>
    </div>}
    <p className="resume-reason">{shown?.reason ?? (origin ? '' : missing)}</p>
    <div role="status" tabIndex={-1} ref={status} className="resume-reason session-copy-feedback" data-result={resultType}>{feedback || (working ? '正在核对当前会话…' : '')}</div>
    {shown?.ticket && <p className="resume-reason">只在你选择复制后写入剪贴板。</p>}
    <div className={origin?.kind==='run'?'task-resume-actions':'session-identity-actions'}>
      <button type="button" onClick={finish}>返回</button>
      {shown?.methods.map(method=>shown.ticket && <button key={method} type="button" aria-disabled={working}
        data-resume-action={method} onClick={()=>void act(method)}>{titles[method]}</button>)}
      {shown?.conversation && showConversation && <button type="button" aria-disabled={working}
        onClick={e=>{
          if (request.current) return
          if (!showConversation(shown.conversation!,e.currentTarget)) setFeedback('无法核对同一会话的只读内容。请手动查找。')
        }}>查看同会话的对话</button>}
      {origin && !shown?.ticket && !working && <button type="button" onClick={()=>{setExpired(false);refresh(x=>x+1)}}>重新核对会话</button>}
    </div>
  </div>
}
