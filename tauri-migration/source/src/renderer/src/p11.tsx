import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { projectColors, sessionKey, type Facts, type Identity, type Ownership, type Preview, type ProjectDetail,
  type ProjectFields, type Receipt, type Request, type SessionPlace, type SessionRef, type Subject, type TaskInfo, type TaskRef } from '../../shared/p11'
import type { AgentProfile } from '../../shared/agents'
import { NOTE_TEMPLATES, type NoteTemplate } from '../../shared/ipc'

type Open = {kind:'project';id?:string;op?:'archive'|'edit';saved:(p:ProjectDetail)=>Promise<void>|void;
  createNote?:(name:string,id:string,template:NoteTemplate)=>Promise<boolean>}
  | {kind:'ownership';session:SessionRef}
  | {kind:'binding';session?:SessionRef;task?:TaskRef;unbind?:boolean}
  | {kind:'impact';subject:Subject}
export const changed=()=>window.dispatchEvent(new Event('p11-changed'))
export const openP11=(request:Open,origin?:HTMLElement|null,restore?:()=>void)=>window.dispatchEvent(new CustomEvent('p11-open',{detail:{request,origin:origin??document.activeElement,restore}}))
export type DelegatePayload={task:TaskRef;profileId?:string;origin:HTMLElement}
export const delegateTask=(p:DelegatePayload)=>window.dispatchEvent(new CustomEvent('p11-delegate',{detail:p}))
export type BindingGuard=(notes:string[])=>Promise<'ready'|'again'|'stay'>
const api=()=>window.workbench.p11
const fresh:ProjectFields={name:'',root:'',color:'default'}
const msg=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
const taskKey=(t:TaskRef)=>t.noteId+':'+t.blockId
const sameTask=(a:TaskRef,b:TaskRef)=>taskKey(a)===taskKey(b)
const focus=(el?:HTMLElement|null)=>{if(el?.isConnected && el.getClientRects().length && !el.matches(':disabled'))el.focus({preventScroll:true})}
function later(el?:HTMLElement|null, fallback='.agent-panel-title, [data-editor-meta-title], .notes-search input') {
  requestAnimationFrame(()=>{focus(el);if(!el || document.activeElement!==el)focus(document.querySelector<HTMLElement>(fallback))})
}

export function usePlaces(input:unknown) {
  const [places,set]=useState<Record<string,SessionPlace>>({})
  useEffect(()=>{
    let alive=true,seq=0
    const read=()=>{const key=++seq;void api().places().then(p=>{if(alive && key===seq)set(p)},()=>{})}
    read()
    window.addEventListener('p11-changed',read)
    return()=>{alive=false;window.removeEventListener('p11-changed',read)}
  },[input])
  return places
}

export function SessionActions({session,place}: {session:SessionRef;place?:SessionPlace}) {
  return <div className="p11-inline" onKeyDown={e=>{if(e.key==='Escape'&&e.currentTarget.querySelector('details[open]')){
    const detail=e.currentTarget.querySelector('details')!;detail.open=false;detail.querySelector('summary')?.focus();e.stopPropagation()
  }}}>
    <span className="p11-literal">归属：{place?.name ?? '未核实'}{place?.archived?'（已归档）':''}{place?' · '+place.source:''}</span>
    <details><summary>会话操作</summary>
      <button type="button" onClick={e=>openP11({kind:'ownership',session},e.currentTarget)}>选择项目</button>
      <button type="button" onClick={e=>openP11({kind:'binding',session},e.currentTarget)}>绑定到任务</button>
      {place?.bound && <button type="button" onClick={e=>openP11({kind:'binding',session,unbind:true},e.currentTarget)}>解除绑定</button>}
      <button type="button" onClick={e=>openP11({kind:'impact',subject:{kind:'session',session}},e.currentTarget)}>移除会话…</button>
    </details>
    <button className="p11-drag-source" type="button" aria-label="拖动会话或选择任务"
      onPointerDown={e=>pointer(e,{kind:'session',session})}
      onClick={e=>{if(!suppressClick(e))openP11({kind:'binding',session},e.currentTarget)}}>拖动会话</button>
  </div>
}

export function TaskActions({task}: {task:TaskInfo}) {
  return <div className="p11-task-actions" data-p11-task-key={taskKey(task)} data-p11-note={task.noteId} data-p11-block={task.blockId}
    data-p11-reason={task.reason} data-p11-agent={task.agentId??''} role="group" aria-label={'任务：'+task.title}>
    <strong tabIndex={-1} className="p11-literal">{task.title}</strong>
    <span className="p11-literal">绑定：{task.externalId?task.agentId+' / '+task.externalId:'独立任务'}{task.reason&&task.reason!=='目标已有绑定'?' · '+task.reason:''}</span>
    <div className="p11-inline">
      <button type="button" onClick={e=>openP11({kind:'binding',task},e.currentTarget)}>绑定会话</button>
      {task.binding && <button type="button" onClick={e=>openP11({kind:'binding',session:task.binding,unbind:true},e.currentTarget)}>解除绑定</button>}
      <button type="button" className="p11-drag-source" onPointerDown={e=>pointer(e,{kind:'task',task})}
        onClick={e=>{if(!suppressClick(e))delegateTask({task,origin:e.currentTarget})}}>委派给 Agent</button>
      <button type="button" onClick={e=>openP11({kind:'impact',subject:{kind:'task',task}},e.currentTarget)}>移除任务…</button>
    </div>
    <span className="p11-drop-feedback" aria-hidden="true"/>
  </div>
}

export function AgentTargets({empty=false}: {empty?:boolean} = {}) {
  const [profiles,set]=useState<AgentProfile[]>([])
  useEffect(()=>{
    let live=true
    const refresh=()=>void window.workbench.agents.list().then(p=>{if(live)set(p.filter(q=>q.enabled))},()=>{})
    refresh()
    const timer=setInterval(refresh,3000)
    return()=>{live=false;clearInterval(timer)}
  },[])
  if(!profiles.length)return empty ? <p className="agent-targets-empty">没有已启用的档案。</p> : null
  return <div className="p11-agent-targets" aria-label="可委派的 Agent 档案">
    {profiles.map(p=><div className="p11-agent-target" key={p.id} data-p11-agent-target={p.id}
      title={p.id}><span>{p.name}</span><span className="p11-drop-feedback" aria-hidden="true"/></div>)}
  </div>
}

type Drag = {kind:'session';session:SessionRef}|{kind:'task';task:TaskInfo}
let clearDrag:(()=>void)|undefined, blockedClick:HTMLElement|undefined
function suppressClick(e:React.MouseEvent<HTMLElement>) {
  if(e.detail && blockedClick===e.currentTarget){blockedClick=undefined;return true}
  return false
}
function pointer(e:React.PointerEvent<HTMLButtonElement>,drag:Drag) {
  if(e.button!==0 || !e.isPrimary)return
  clearDrag?.()
  const origin=e.currentTarget,id=e.pointerId,x=e.clientX,y=e.clientY
  const sourceScroll=origin.closest<HTMLElement>('.session-panel,[data-editor-scroller]')
  let started=false,frame=0,lastX=x,lastY=y,hit:HTMLElement|null=null,why='',message=''
  const remembered=new Map<HTMLElement,number>()
  if(sourceScroll)remembered.set(sourceScroll,sourceScroll.scrollTop)
  const ghost=document.createElement('div');ghost.className='p11-drag-ghost';ghost.setAttribute('aria-hidden','true')
  ghost.textContent=drag.kind==='task'?drag.task.title:drag.session.id
  const announce=(s:string)=>{const live=document.querySelector('.p11-live');if(live && live.textContent!==s)live.textContent=s}
  const pick=()=>{
    const at=document.elementFromPoint(lastX,lastY)
    const target=at?.closest<HTMLElement>('[data-p11-task-key],[data-p11-agent-target]')??null
    const reason=target?(drag.kind==='task'?(target.dataset.p11AgentTarget?(drag.task.reason && !['目标已有绑定','任务 Agent 档案无法唯一核实'].includes(drag.task.reason)?drag.task.reason:!drag.task.eligibleAgents?.includes(target.dataset.p11AgentTarget)?'档案与任务不符':''):'需要 Agent 档案'):
      (target.dataset.p11TaskKey?target.dataset.p11Reason||'':'需要任务目标')):''
    const next=target?(reason||'放在此处预览'):''
    if(target!==hit || next!==message){
      hit?.removeAttribute('data-p11-drop');const old=hit?.querySelector('.p11-drop-feedback');if(old)old.textContent=''
      hit=target;why=reason;message=next
      if(hit){hit.dataset.p11Drop=why?'invalid':'valid';const out=hit.querySelector('.p11-drop-feedback');if(out)out.textContent=next}
      announce(next)
    }
    return at
  }
  const tick=()=>{
    const at=pick()
    const pane=at?.closest<HTMLElement>('.note-editor-body, .agent:has(.session-panel), .session-panel')
    const scroll=pane && [pane,...pane.querySelectorAll<HTMLElement>('[data-editor-scroller], .session-panel')].find(el=>el.scrollHeight>el.clientHeight)
    if(scroll){
      const rect=scroll.getBoundingClientRect()
      const delta=lastY-rect.top<32?-8:rect.bottom-lastY<32?8:0
      if(delta){if(!remembered.has(scroll))remembered.set(scroll,scroll.scrollTop);scroll.scrollTop+=delta}
    }
    frame=requestAnimationFrame(tick)
  }
  const move=(p:PointerEvent)=>{
    if(p.pointerId!==id)return
    lastX=p.clientX;lastY=p.clientY
    if(!started && Math.hypot(lastX-x,lastY-y)>=6){
      if(!origin.isConnected)return stop()
      try{origin.setPointerCapture(id)}catch{return stop()}
      started=true;document.body.append(ghost);frame=requestAnimationFrame(tick)
    }
    if(started){p.preventDefault();ghost.style.transform='translate('+ (lastX+12) +'px,'+(lastY+12)+'px)'}
  }
  const close=(keep:boolean)=>{
    clearDrag=undefined
    window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up)
    window.removeEventListener('pointercancel',lost);origin.removeEventListener('lostpointercapture',lost)
    window.removeEventListener('keydown',key,true);window.removeEventListener('blur',stop)
    cancelAnimationFrame(frame);ghost.remove()
    hit?.removeAttribute('data-p11-drop');const old=hit?.querySelector('.p11-drop-feedback');if(old)old.textContent=''
    if(started){
      blockedClick=origin;setTimeout(()=>{if(blockedClick===origin)blockedClick=undefined},250)
      if(origin.hasPointerCapture(id))origin.releasePointerCapture(id)
      if(!keep){for(const [el,pos] of remembered)el.scrollTop=pos;focus(origin)}
      announce('')
    }
  }
  const up=(p:PointerEvent)=>{
    if(p.pointerId!==id)return
    lastX=p.clientX;lastY=p.clientY
    if(started)pick()
    const target=started && !why && hit?.isConnected?hit:null
    close(!!target)
    if(!target)return
    if(drag.kind==='session' && target.dataset.p11Note && target.dataset.p11Block){
      openP11({kind:'binding',session:drag.session,task:{noteId:target.dataset.p11Note,blockId:target.dataset.p11Block}},origin)
    }else if(drag.kind==='task' && target.dataset.p11AgentTarget){
      delegateTask({task:drag.task,profileId:target.dataset.p11AgentTarget,origin})
    }
  }
  const stop=()=>close(false)
  const lost=(p:PointerEvent)=>{if(p.pointerId===id)stop()}
  const key=(k:KeyboardEvent)=>{if(k.key==='Escape' && started){k.preventDefault();k.stopImmediatePropagation();stop()}}
  clearDrag=stop
  window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up)
  window.addEventListener('pointercancel',lost);origin.addEventListener('lostpointercapture',lost)
  window.addEventListener('keydown',key,true);window.addEventListener('blur',stop)
}

export function P11Host({sessions,guard}: {sessions:SessionRef[];guard:React.RefObject<BindingGuard|undefined>}) {
  const [entry,setEntry]=useState<{request:Open;origin:HTMLElement;restore?:()=>void;generation:number}>()
  const generation=useRef(0), exclusive=useRef(false)
  useEffect(()=>{
    const show=(event:Event)=>{
      if(exclusive.current || document.querySelector('dialog:modal:not(.workbench-drawer)'))return
      exclusive.current=true
      const p=(event as CustomEvent<{request:Open;origin:HTMLElement;restore?:()=>void}>).detail
      setEntry({...p,generation:++generation.current})
    }
    window.addEventListener('p11-open',show)
    return()=>window.removeEventListener('p11-open',show)
  },[])
  return <><div className="p11-live" aria-live="polite"/>{entry && <Flow key={entry.generation} request={entry.request} origin={entry.origin}
    sessions={sessions} guard={guard} close={(target)=>{
      setEntry(undefined);exclusive.current=false
      if (entry.restore && (!target || target === entry.origin)) requestAnimationFrame(entry.restore)
      else later(target ?? entry.origin)
    }}/>}</>
}


export function DeleteRecoveryNotice(){
  const [result,setResult]=useState<{id:string;detail:string;state:string}|null>(null)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let live=true
    const read=()=>void api().pending().then(r=>{if(live)setResult(r)},()=>{})
    read()
    window.addEventListener('p11-unknown',read)
    return()=>{live=false;window.removeEventListener('p11-unknown',read)}
  },[])
  if(!result)return null
  return <div className="p11-recovery-state" role="alert" aria-label="工作区结果待核对">
    <strong>工作区结果待核对</strong>
    <span className="p11-literal">操作 ID：{result.id} · {message||result.detail}</span>
    <button type="button" onClick={()=>{void api().receipt(result.id).then(r=>setMessage(r.message),e=>setMessage(msg(e)))}}>核对结果</button>
  </div>
}
const Btn=({children,onClick,disabled,primary,id,danger}: {children:ReactNode;onClick:()=>void;disabled?:boolean;primary?:boolean;id?:string;danger?:boolean})=>
  <button id={id} type="button" aria-disabled={disabled||undefined} className={'p11-btn '+(primary?'p11-btn--primary':'p11-btn--secondary')+(danger?' p11-btn--danger':'')}
    onClick={()=>{if(!disabled)onClick()}}>{children}</button>
const Dot=({color}: {color:string})=><span className="p11-project-dot" data-color={color} aria-hidden="true"/>
const IdentityCard=({title,value}: {title:string;value?:Identity|null})=><section className="p11-card">
  <strong>{title}</strong><div className="p11-literal">{value?.project??'独立会话'}</div>
  {value && <div className="p11-literal">笔记 {value.noteId}<br/>任务 {value.blockId}</div>}</section>
const FactsList=({data}: {data:Facts})=><section className="p11-card">
  <strong className="p11-title">{data.title}</strong><code className="p11-literal">{data.id}</code>
  <dl>{data.counts.map(r=><div key={r.label}><dt>{r.label}</dt><dd>{r.value??'未核实'}</dd></div>)}</dl>
  {data.details.map((r,i)=><div className="p11-literal" key={i}>{r}</div>)}</section>

function Flow({request,origin,sessions,guard,close}: {request:Open;origin:HTMLElement;sessions:SessionRef[];
  guard:React.RefObject<BindingGuard|undefined>;close:(target?:HTMLElement|null)=>void}) {
  const [project,setProject]=useState<ProjectDetail>()
  const [fields,setFields]=useState<ProjectFields>(fresh)
  const [taskChoices,setTasks]=useState<TaskInfo[]>()
  const [owner,setOwner]=useState<Ownership>()
  const [preview,setPreview]=useState<Preview>()
  const [intent,setIntent]=useState<Request>()
  const [error,setError]=useState('')
  const [fieldError,setFieldError]=useState<Record<string,string>>({})
  const [diff,setDiff]=useState('')
  const [conflicts,setConflicts]=useState<string[]>([])
  const [phase,setPhase]=useState<'idle'|'reading'|'writing'|'unknown'>('idle')
  const [operation,setOperation]=useState('')
  const [nextNote,setNextNote]=useState<ProjectDetail>()
  const [noteTitle,setNoteTitle]=useState('')
  const [template,setTemplate]=useState<NoteTemplate>('blank')
  const dialog=useRef<HTMLDialogElement>(null), head=useRef<HTMLHeadingElement>(null)
  const dirtyGuard=useRef(false), mounted=useRef(true), seq=useRef(0), token=useRef<string|undefined>(undefined)
  const phaseRef=useRef(phase)
  const composing=useRef(false)
  const opener=useRef(origin)
  const errorRef=useRef<HTMLDivElement>(null)
  const write=(p:typeof phase)=>{phaseRef.current=p;setPhase(p)}
  const form=request.kind==='project' && request.op!=='archive'
  const binding=request.kind==='binding'?request:undefined
  const title=nextNote?'新建笔记':request.kind==='project'?request.op==='archive'?(project?.archivedAt?'恢复项目':'归档项目'):request.id?'编辑项目':'新项目':
    request.kind==='ownership'?'选择项目':request.kind==='impact'?'移除影响预览':preview?.action??(binding?.unbind?'解除绑定':'选择绑定目标')
  const cancelPreview=()=>{if(token.current){void api().cancel(token.current).catch(()=>{});token.current=undefined}}
  const exit=(target?:HTMLElement|null)=>{if(phaseRef.current==='writing')return;seq.current++;cancelPreview();close(target??opener.current)}
  useLayoutEffect(()=>{
    const d=dialog.current!;d.showModal();focus(form?head.current:d.querySelector<HTMLElement>('#p11-cancel'))
    return()=>{mounted.current=false;seq.current++;cancelPreview();if(d.open)d.close()}
  },[])
  useLayoutEffect(()=>{
    if(nextNote)focus(dialog.current?.querySelector('#note-title'))
    else if(preview)focus(dialog.current?.querySelector('#p11-cancel'))
  },[preview,nextNote])
  const read=async(job:()=>Promise<void>)=>{
    const id=++seq.current
    write('reading');setError('')
    try{await job()}catch(e){if(seq.current===id && mounted.current)setError(msg(e))}
    finally{if(seq.current===id && mounted.current)write('idle')}
  }
  const accept=async(input:Request,identity=seq.current)=>{
    if(input.type==='binding'){
      const from=await api().ownership(input.session)
      if(!mounted.current || seq.current!==identity)return
      const notes=[input.target?.noteId,from.place.noteId].filter((x):x is string=>!!x)
      dirtyGuard.current=true
      try{
        const status=await guard.current?.(notes)
        if(status==='stay')return
      }finally{dirtyGuard.current=false}
    }
    if(!mounted.current || seq.current!==identity)return
    const p=await api().preview(input)
    if(!mounted.current || seq.current!==identity){void api().cancel(p.token);return}
    cancelPreview();token.current=p.token;setIntent(input);setPreview(p)
  }
  useEffect(()=>{
    void read(async()=>{
      const identity=seq.current
      if(request.kind==='project' && request.id){
        const p=await api().project(request.id)
        if(!mounted.current || seq.current!==identity)return
        setProject(p);setFields(p)
        if(request.op==='archive')await accept({type:'archive',id:p.id,revision:p.revision,archived:p.archivedAt===null},identity)
      } else if(request.kind==='impact'){
        setIntent({type:'remove',subject:request.subject})
        await accept({type:'remove',subject:request.subject},identity)
      } else if(request.kind==='ownership'){
        const r=await api().ownership(request.session)
        if(mounted.current && seq.current===identity)setOwner(r)
      } else if(binding?.session && (binding.unbind || binding.task)){
        await accept({type:'binding',session:binding.session,target:binding.unbind?null:binding.task!},identity)
      } else if(binding?.session){
        const [tasks,session]=await Promise.all([api().tasks(),api().ownership(binding.session)])
        if(mounted.current && seq.current===identity){setOwner(session);setTasks(tasks)}
      } else if(binding?.task){
        const [task]=await api().tasks(binding.task.noteId).then(t=>t.filter(t=>sameTask(t,binding.task!)))
        if(mounted.current && seq.current===identity)setTasks(task?[task]:[])
      }
    })
  },[])
  function requestPreview(input:Request) {
    if(phaseRef.current!=='idle')return
    cancelPreview();setPreview(undefined);setIntent(input)
    void read(()=>accept(input))
  }
  function inputChanged(k:keyof ProjectFields,value:string) {
    setFields(old=>({...old,[k]:value}));setConflicts(prev=>prev.filter(x=>x!==k))
    setFieldError(prev=>({...prev,[k]:''}));setError('')
  }
  function localError(k:keyof ProjectFields){
    if(k==='name' && (!fields.name.trim() || fields.name.length>120 || /[\r\n\0]/.test(fields.name)))return '请输入 1–120 个字符的单行项目名称'
    if(k==='root' && fields.root.trim() && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(fields.root.trim()))return '请输入 Windows 绝对目录'
    return ''
  }
  async function rereadProject(){
    if(request.kind!=='project'||!request.id)return
    const p=await api().project(request.id)
    if(!mounted.current)return
    const keys=(['name','root','color'] as const).filter(k=>project && project[k]!==p[k])
    setConflicts(keys);setDiff(keys.length?keys.map(k=>k+'：'+project?.[k]+' → '+p[k]).join('\n'):'已读取项目现况。')
    setProject(p)
    if(request.op==='archive')await accept({type:'archive',id:p.id,revision:p.revision,archived:p.archivedAt===null})
  }
  function applyResult(r:Receipt) {
    if(r.status==='missing'){setError(r.message);write('unknown');window.dispatchEvent(new Event('p11-unknown'));return}
    setOperation('')
    write('idle')
    token.current=undefined;setPreview(undefined)
    if(r.status==='unchanged'){setError(r.message);return}
    changed()
    if(r.removed){
      window.dispatchEvent(new CustomEvent('p11-removed',{detail:r.removed}))
      exit()
      return
    }
    if(request.kind==='project' && r.project){
      const refreshed=Promise.resolve(request.saved(r.project))
      void refreshed.catch(e=>{if(mounted.current)setError(msg(e))})
      if(!request.id && request.createNote){setNextNote(r.project);setError('');return}
      setError('')
      close(origin)
      void refreshed.then(()=>requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('p11-focus-project',{detail:{id:r.project!.id,archive:r.project!.archivedAt!==null}}))),()=>{})
      return
    }
    if(request.kind==='binding'){
      const t=preview?.target
      const s=preview?.session
      const selector=t?'[data-p11-task-key="'+CSS.escape(t.noteId+':'+t.blockId)+'"] strong':
        s?'[data-session="'+CSS.escape(s.adapter+':'+s.id)+'"] .session-expand':undefined
      exit(selector?document.querySelector<HTMLElement>(selector):origin);return
    }
    exit()
  }
  async function submit(p:Preview){
    if(phaseRef.current!=='idle' || dirtyGuard.current)return
    if(p.blocked && intent?.type!=='remove')return
    if(intent?.type==='binding'||intent?.type==='remove'){
      dirtyGuard.current=true
      try{
        const target=(p.affectedNotes??[p.source?.noteId,p.target?.noteId]).filter((x):x is string=>!!x)
        const result=await guard.current?.(target)??'ready'
        if(!mounted.current || result==='stay')return
        if(result==='again'){
          cancelPreview();setPreview(undefined)
          void read(()=>accept(intent))
          return
        }
      }catch(e){setError(msg(e));return}
      finally{dirtyGuard.current=false}
    }
    if(p.blocked){setError(p.blocked);return}
    const id=crypto.randomUUID();setOperation(id);write('writing');setError('')
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      const timed=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('响应超时。请按操作 ID 核对持久结果。')),8000)})
      const result=await Promise.race([api().confirm(p.token,id),timed])
      if(mounted.current)applyResult(result)
    }catch(e){if(mounted.current){setError(msg(e));write('unknown');window.dispatchEvent(new Event('p11-unknown'))}}
    finally{clearTimeout(timer)}
  }
  const saveFields=()=>{
    if(composing.current || !form || phaseRef.current!=='idle' || conflicts.length)return
    const input={type:'project' as const,id:project?.id,revision:project?.revision,fields}
    const name=localError('name'),root=localError('root')
    if(name||root){setFieldError({name,root});focus(dialog.current?.querySelector('#p11-'+(name?'name':'root')));return}
    const current=++seq.current
    write('reading');setError('')
    void api().preview(input).then(p=>{
      if(!mounted.current || seq.current!==current){void api().cancel(p.token);return}
      token.current=p.token;setIntent(input);write('idle');void submit(p)
    },e=>{
      if(!mounted.current||seq.current!==current)return
      const m=msg(e);setError(m);write('idle')
      const k=m.startsWith('根目录')?'root':m.startsWith('名称')?'name':null
      if(k){setFieldError(old=>({...old,[k]:m}));focus(dialog.current?.querySelector('#p11-'+k))}
    })
  }
  const locked=phase==='writing'||phase==='unknown'
  const ready=phase==='idle'
  const listBack=!!preview && (request.kind==='ownership' || binding?.session && !binding.unbind && !binding.task || binding?.task && !binding.session)
  useLayoutEffect(()=>{if(error && phase==='unknown')focus(errorRef.current)},[error,phase])
  return createPortal(<dialog className="p11-native p11-modal-frame" ref={dialog} aria-labelledby="p11-heading" aria-describedby="p11-context"
    onCancel={e=>{e.preventDefault();if(!dirtyGuard.current)exit()}}
    onKeyDown={e=>{
      if(e.nativeEvent.isComposing || e.keyCode===229){if(e.key==='Escape')e.preventDefault();return}
      if(e.key!=='Tab')return
      const items=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(el=>el.getClientRects().length)
      const index=items.indexOf(document.activeElement as HTMLElement)
      if(e.shiftKey && index<=0 || !e.shiftKey && index===items.length-1){
        e.preventDefault();focus(e.shiftKey?items.at(-1):items[0])
      }
    }}>
    <div className="p11-modal">
      <header className="p11-modal-head"><h2 id="p11-heading" className="p11-modal-title" tabIndex={-1} ref={head}>{title}</h2></header>
      <div className="p11-modal-body" tabIndex={form&&!nextNote?-1:0} aria-label="核对详情">
        <span className="p11-live" id="p11-context">{request.kind==='impact'?'核对完整影响后可明确移除。默认取消。':request.kind==='binding'?'核对会话和原、目标任务后可确认。':'核对详情和操作。'}</span>
        {error && <div className="p11-error p11-literal" tabIndex={-1} ref={errorRef} role="alert">{error}</div>}
        {operation && locked && <code className="p11-literal">操作 ID：{operation}</code>}
        {nextNote && <div className="p11-form" onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}}>
          <div className="p11-literal">归属：{nextNote.name} · {nextNote.id}</div>
          <label className="p11-field" htmlFor="note-title">笔记标题<input id="note-title" data-design-id="P02.form.name" className="p11-input"
            value={noteTitle} onChange={e=>setNoteTitle(e.target.value)} maxLength={240} readOnly={!ready}/></label>
          <label className="p11-field">模板<select className="p11-select" value={template} disabled={!ready}
            onChange={e=>setTemplate(e.target.value as NoteTemplate)}>{Object.entries(NOTE_TEMPLATES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></label>
        </div>}
        {form && !nextNote && (!request.id || project) && <>
          {project && <div className="p11-card p11-literal"><Dot color={project.color}/>{project.name} · {project.id}<br/>{project.archivedAt?'已归档':'活动项目'}</div>}
          {diff && <p className="p11-literal">{diff}{conflicts.length?'\n请重新选择有变动的字段。':''}</p>}
          <div className="p11-form" onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}}>
            {(['name','root'] as const).map(k=><label className="p11-field" htmlFor={'p11-'+k} key={k}>
              <span className="p11-label">{k==='name'?'名称':'根目录（可空）'}</span>
              <span className="p11-field-row"><input id={'p11-'+k} className="p11-input" value={fields[k]}
                onChange={e=>inputChanged(k,e.target.value)} onBlur={()=>setFieldError(old=>({...old,[k]:localError(k)}))}
                readOnly={!ready} aria-invalid={!!fieldError[k]} aria-describedby={fieldError[k]?'p11-field-'+k:undefined}/>
                {k==='root' && <Btn disabled={!ready} onClick={()=>{
                  const browse=document.activeElement as HTMLElement
                  void read(async()=>{const path=await api().browse();if(!mounted.current)return;if(path!==null)inputChanged('root',path);later(browse)})
                }}>浏览</Btn>}</span>
              {fieldError[k] && <span id={'p11-field-'+k} className="p11-error">{fieldError[k]}</span>}
              {conflicts.includes(k) && <Btn onClick={()=>inputChanged(k,fields[k])}>保留我的值</Btn>}
              {conflicts.includes(k) && project && <Btn onClick={()=>inputChanged(k,project[k])}>采用最新值</Btn>}
            </label>)}
            <p className="p11-note">根目录仅用于建议归属。设置根目录不会改变文件位置或写入授权。</p>
            <label className="p11-field">颜色<select aria-label="颜色" className="p11-select" value={fields.color} disabled={!ready}
              onChange={e=>inputChanged('color',e.target.value)}>
                {Object.entries(projectColors).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
            <div className="p11-color-preview"><Dot color={fields.color}/>{projectColors[fields.color]}</div>
            {conflicts.includes('color') && project && <div className="p11-inline"><Btn onClick={()=>inputChanged('color',fields.color)}>保留我的颜色</Btn>
              <Btn onClick={()=>inputChanged('color',project.color)}>采用最新颜色</Btn></div>}
          </div>
        </>}
        {preview?.facts && <FactsList data={preview.facts}/>}
        {preview?.blocked && <p className="p11-error" role="alert">{preview.blocked}</p>}
        {listBack && <div><Btn disabled={!ready} onClick={()=>{cancelPreview();setPreview(undefined);requestAnimationFrame(()=>focus(dialog.current?.querySelector('.p11-candidate button')))}}>改选</Btn></div>}
        {error && phase==='idle' && request.kind==='project' && request.id && <div><Btn onClick={()=>{cancelPreview();setPreview(undefined);void read(rereadProject)}}>重新读取</Btn></div>}
        {owner && !preview && <div className="p11-card p11-literal">
          会话 {owner.session.adapter} / {owner.session.id}<br/>Agent 档案 {owner.agentId}<br/>观测目录 {owner.cwd??'未知'}<br/>
          当前归属 {owner.place.name} · {owner.place.source}<br/>{request.kind==='ownership' && owner.suggestion}
        </div>}
        {request.kind==='ownership' && owner && !preview && !owner.place.bound && <div className="p11-candidates">
          <div><Btn disabled={!ready} onClick={()=>requestPreview({type:'ownership',session:owner.session,projectId:null})}>保持未归属</Btn></div>
          {owner.candidates.map(({project:p,evidence})=><div className="p11-candidate" key={p.id}>
            <strong><Dot color={p.color}/>{p.name}</strong><code className="p11-literal">{p.id}</code>
            <div className="p11-literal">{p.root || '未配置根目录'} · {evidence}</div>
            <Btn disabled={!ready} onClick={()=>requestPreview({type:'ownership',session:owner.session,projectId:p.id})}>选择此项目</Btn>
          </div>)}
        </div>}
        {binding?.session && taskChoices && !preview && <div className="p11-candidates">
          {!taskChoices.length && <p>没有带稳定标记的任务。请在笔记中的委派入口保存任务标记。</p>}
          {taskChoices.map((t,i)=><div className="p11-candidate" key={taskKey(t)+':'+i}>
            <strong>{t.title}</strong><div className="p11-literal">{t.project.name} · {t.project.id}<br/>{t.note} · {t.noteId}<br/>{t.blockId}</div>
            {t.reason && <div className="p11-note">{t.reason}</div>}
            <Btn disabled={!ready || !!t.reason && t.reason!=='任务不可写或有草稿'} onClick={()=>requestPreview({type:'binding',session:binding.session!,target:t})}>选此目标</Btn>
          </div>)}
        </div>}
        {binding?.task && !binding.session && taskChoices && !preview && <div className="p11-candidates">
          <div className="p11-literal">{taskChoices[0]?.title??'任务无法核实'} · {binding.task.blockId}</div>
          {!sessions.length && <p>没有可供核对的外部会话。</p>}
          {sessions.map(s=><div className="p11-candidate" key={sessionKey(s)}><div className="p11-literal">{s.adapter} · {s.id}</div>
            <Btn disabled={!ready || !!taskChoices[0]?.reason && taskChoices[0]?.reason!=='任务不可写或有草稿' || !taskChoices.length}
              onClick={()=>requestPreview({type:'binding',session:s,target:binding.task!})}>选此会话</Btn></div>)}
        </div>}
        {preview?.session && <div className="p11-card p11-literal">会话 {preview.session.adapter} / {preview.session.id}<br/>
          登记档案 {preview.agentId}<br/>观测 cwd {preview.cwd??'未知'}{preview.destination && <><br/>去向 {preview.destination}</>}</div>}
        {preview && (preview.source!==undefined || preview.target!==undefined) && <>
          <div className="p11-identity"><IdentityCard title="原位置" value={preview.source}/>
            <IdentityCard title="目标位置" value={preview.target}/></div>
          <p className="p11-note">原任务、已有结论、运行历史与外部日志保留在原处。待回写仍按原轮锚点核对。</p>
        </>}
      </div>
      <footer className="p11-modal-tail">
        <div className="p11-tail-hint" role="status">{phase==='reading'?'正在读取':phase==='writing'?'正在提交 '+title:phase==='unknown'?'结果未确认':error?'请核对正文':''}</div>
        <div className="p11-tail-actions">
          {phase==='unknown' && <Btn onClick={()=>{void api().receipt(operation).then(r=>{if(mounted.current)applyResult(r)},e=>{if(mounted.current)setError(msg(e))})}}>核对结果</Btn>}

          {error && phase==='idle' && intent && request.kind!=='project' && <Btn onClick={()=>requestPreview(intent)}>重新读取</Btn>}
          <Btn id="p11-cancel" disabled={phase==='writing'} onClick={()=>{if(!dirtyGuard.current)exit()}}>{phase==='unknown'?'关闭':'取消'}</Btn>
          {form && !nextNote && !locked && <Btn primary disabled={!ready||!!conflicts.length||!!request.id&&!project} onClick={saveFields}>保存项目</Btn>}
          {nextNote && <Btn primary disabled={!ready||!noteTitle.trim()} onClick={()=>{
            if(request.kind!=='project'||!request.createNote || dirtyGuard.current || composing.current)return
            dirtyGuard.current=true
            void request.createNote(noteTitle,nextNote.id,template).then(ok=>{if(ok && mounted.current)exit(document.querySelector<HTMLElement>('[data-editor-meta-title]'))},
              e=>{if(mounted.current)setError(msg(e))}).finally(()=>{dirtyGuard.current=false})
          }}>创建笔记</Btn>}
          {preview && !locked && <Btn primary danger={intent?.type==='remove'} disabled={!ready || !!preview.blocked && !preview.blocked.includes('P03 保存或放弃')} onClick={()=>void submit(preview)}>{preview.action}</Btn>}
        </div>
      </footer>
    </div>
  </dialog>,document.body)
}

