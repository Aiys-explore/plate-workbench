import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import type { Policy, Preview, Receipt, Scope, Source } from '../../shared/p12'
import './styles/p12-m4.4-style.css'

const pageSize=30
const labels=['已生成','跳过','失败','未开始','待核对'] as const
const detail=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')
export function P12({scope,dirtyId,unknownDraft,close,processDraft}:{scope:Scope|null;dirtyId?:string;unknownDraft?:boolean;close:()=>void;processDraft:()=>void}) {
  const api=window.workbench.p12
  const modal=useRef<HTMLDialogElement>(null)
  const title=useRef<HTMLHeadingElement>(null)
  const body=useRef<HTMLDivElement>(null)
  const guard=useRef(false)
  const live=useRef(true)
  const [current,setCurrent]=useState(scope)
  const [source,setSource]=useState<Source>()
  const [target,setTarget]=useState<{directory:string;token:string}>()
  const [policy,setPolicy]=useState<Policy>('number')
  const [saved,setSaved]=useState(false)
  const [preview,setPreview]=useState<Preview>()
  const [receipt,setReceipt]=useState<Receipt>()
  const [uncertain,setUncertain]=useState<string>()
  const [retry,setRetry]=useState<string>()
  const [limit,setLimit]=useState(pageSize)
  const [error,setError]=useState('')
  const [pending,setPending]=useState(false)
  const dirty=source?.rows.some(r=>r.id===dirtyId)??false
  const draft=dirty||source?.rows.some(r=>r.recovery)
  const blocked=dirty&&unknownDraft
  const lastMode=useRef('')
  const mode=receipt ? receipt.active?'progress':'result' : uncertain?'result':'plan'
  function action(fn:()=>Promise<void>) {
    if(guard.current)return
    guard.current=true;setPending(true);setError('')
    void fn().catch(e=>{if(live.current)setError(detail(e))}).finally(()=>{guard.current=false;if(live.current)setPending(false)})
  }
  function resetPlan() {
    if(preview)void api.release(preview.id).catch(()=>{})
    setPreview(undefined);setLimit(pageSize)
  }
  function read(scope:Scope) {
    resetPlan();setSource(undefined);setSaved(false)
    action(async()=>{const s=await api.scope(scope);if(live.current)setSource(s)})
  }
  useLayoutEffect(()=>{
    const el=modal.current!
    el.showModal();title.current?.focus()
    return()=>{el.close()}
  },[])
  useEffect(()=>{
    live.current=true
    if(scope)read(scope)
    else action(async()=>{const r=await api.receipt();if(live.current) {if(r)setReceipt(r);else setError('没有导出记录')}})
    return()=>{live.current=false}
  },[])
  useLayoutEffect(()=>{
    if(lastMode.current!==mode){
      lastMode.current=mode
      title.current?.focus({preventScroll:true})
      body.current?.scrollTo(0,0)
    }
  },[mode])
  useEffect(()=>{
    if(!receipt?.active)return
    let disposed=false
    let loading=false
    const timer=setInterval(()=>{
      if(loading)return
      loading=true
      void api.receipt(receipt.id).then(r=>{if(!disposed&&r)setReceipt(r)}).catch(e=>{if(!disposed){setError(detail(e));setUncertain(receipt.id);setReceipt(undefined)}})
        .finally(()=>{loading=false})
    },100)
    return()=>{disposed=true;clearInterval(timer)}
  },[receipt?.id,receipt?.active])
  const finish=()=>{if(!guard.current&&!receipt?.active){resetPlan();close()}}
  const choose=()=>action(async()=>{
    const result=await api.choose()
    if(result && live.current){setTarget(result);resetPlan()}
  })
  const busy=pending||!!receipt?.active
  const completed=receipt?.rows.filter(r=>r.status==='已生成'||r.status==='跳过').length??0
  const total=receipt?.rows.length??0
  const statuses=receipt?.rows??preview?.rows
  const needsCheck=receipt?.rows.some(r=>r.status==='待核对')
  const titleText=mode==='progress'?'正在导出 Markdown':mode==='result'?'Markdown 导出结果':'导出 Markdown'
  return <dialog ref={modal} className="p12-modal-frame p12-native-dialog" aria-labelledby="p12-heading"
    onCancel={e=>{e.preventDefault();finish()}}
    onKeyDown={e=>{
      if(e.key!=='Tab'||e.nativeEvent.isComposing)return
      const visible=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length)
      if(!visible.length)return
      const i=visible.indexOf(document.activeElement as HTMLElement)
      if(i<0 || (e.shiftKey?i===0:i===visible.length-1)) {
        e.preventDefault();visible[e.shiftKey?visible.length-1:0].focus()
      }
    }}>
    <div className="p12-modal">
      <header className="p12-modal-head"><h2 ref={title} id="p12-heading" className="p12-modal-title" tabIndex={-1}>{titleText}</h2></header>
      <div ref={body} className="p12-modal-body" tabIndex={0} aria-label="导出详情">
        {error&&<p className="p12-literal p12-error" role="alert">{error}</p>}
        {mode==='plan'&&current&&<>
          {source&&<section className="p12-group">
            <div className="p12-card"><b>{source.project.name}</b><p className="p12-literal">{source.project.id}{source.project.archivedAt?' · 已归档':''}</p></div>
            <p>{source.rows.length?source.rows.length+' 份已保存 Markdown':'范围内没有持久化 Markdown'}</p>
            {source.rows.slice(0,limit).map(r=><div key={r.id} className="p12-literal">
              <b>{r.title}{r.kind==='conflict'?' · 冲突副本':''}</b><br/>{r.path}
              {r.kind==='conflict'&&<small className="p12-literal"><br/>保存版本 SHA-256：{r.revision}</small>}
              {r.id===dirtyId&&<p className="p12-note">当前编辑器有未保存内容</p>}
              {r.recovery&&<p className="p12-note">有本地恢复稿</p>}
            </div>)}
            {draft&&<section className="p12-notice">
              <p>{blocked?'草稿检查未完成，暂不可导出。':'导出使用硬盘上已保存的版本。编辑缓冲和恢复稿会原样保留。'}</p>
              <label><input type="checkbox" checked={saved} disabled={busy||blocked} onChange={e=>{setSaved(e.target.checked);resetPlan()}}/> 只导出已保存版本</label>
              <button className="p12-btn" disabled={busy} onClick={()=>{resetPlan();processDraft()}}>返回处理草稿</button>
            </section>}
          </section>}
          {(!source&&!pending)&&<button className="p12-btn" onClick={()=>read(current)}>重新读取范围</button>}
          {source&&source.rows.length>0&&<section className="p12-group">
            <div className="p12-field-row"><p className="p12-literal">{target?.directory??'尚未选择目录'}</p>
              <button className="p12-btn" disabled={busy} onClick={choose}>选择目录</button></div>
            <div className="p12-choices">
              <label><input name="p12-naming" type="radio" checked={policy==='number'} disabled={busy} onChange={()=>{setPolicy('number');resetPlan()}}/> 保留两份（给新文件编号）</label>
              <label><input name="p12-naming" type="radio" checked={policy==='skip'} disabled={busy} onChange={()=>{setPolicy('skip');resetPlan()}}/> 跳过目标已有的文件</label>
            </div>
            {preview?.blockers.map(reason=><p role="status" className="p12-error" key={reason}>{reason}</p>)}
            {!preview&&error&&<button className="p12-btn" disabled={busy} onClick={()=>read(current)}>重新读取范围</button>}
          </section>}
        </>}
        {uncertain&&!receipt&&<section className="p12-group"><p className="p12-literal">操作 ID：{uncertain}</p><p role="status">结果尚未核实。请先核对结果。</p></section>}
        {receipt&&<section className="p12-group">
          <p className="p12-literal">{receipt.directory}</p>
          <div className="p12-literal">操作 ID：{receipt.id}</div>
          <p role="status" aria-live="polite">{receipt.phase}</p>
          {receipt.active&&<div className="p12-progress">
            <progress value={Math.min(completed,total)} max={total||1} aria-label="实际完成项"/>
            <p className="p12-progress-label">{completed} / {total} 项已生成或核实跳过</p>
          </div>}
          {!receipt.active&&<div className="p12-counts">{labels.map(s=><span key={s}>{s} {receipt.rows.filter(r=>r.status===s).length}</span>)}</div>}
        </section>}
        {statuses&&<div className="p12-map" aria-label="逐项去向">
          {statuses.slice(0,limit).map(r=><div className="p12-map-row" key={r.id}>
            <p className="p12-literal"><b>{r.source}</b></p>
            <p className="p12-literal">{r.target??'未生成'}</p>
            <p className="p12-note">{receipt?r.status:r.status==='未开始'?'计划生成':r.status}{r.reason?' · '+r.reason:''}</p>
            {r.check&&<p className="p12-literal p12-error">{r.check}</p>}
          </div>)}
        </div>}
        {Math.max(statuses?.length??0,mode==='plan'?source?.rows.length??0:0)>limit&&<button className="p12-btn"
          onClick={()=>setLimit(n=>n+pageSize)}>加载更多</button>}
      </div>
      <footer className="p12-modal-tail">
        <div className="p12-tail-actions">
          {receipt?.active?<button className="p12-btn" aria-disabled={receipt.stopping||pending} onClick={()=>{
            if(!receipt.stopping&&!pending)action(async()=>{await api.stop(receipt.id);const next=await api.receipt(receipt.id);if(next)setReceipt(next)})
          }}>取消导出</button>:<button className="p12-btn" disabled={pending} onClick={finish}>{receipt||uncertain?'关闭':'取消'}</button>}
          {mode==='plan'&&!preview&&<button className="p12-btn p12-btn--primary" disabled={busy||!source?.rows.length||!target||blocked||!!draft&&!saved}
            onClick={()=>action(async()=>{if(current&&target&&source)setPreview(await api.preview({
              scope:current,target:target.token,fingerprint:source.fingerprint,saved,policy,retry
            }))})}>预览导出</button>}
          {mode==='plan'&&preview&&<button className="p12-btn p12-btn--primary"
            disabled={busy||!!preview.blockers.length||preview.rows.length>limit||blocked||!!draft&&!saved}
            onClick={()=>action(async()=>{
              try {setReceipt(await api.confirm(preview.id));setPreview(undefined);setLimit(pageSize)}
              catch(e){
                resetPlan()
                try {const r=await api.receipt(preview.id);if(r){setReceipt(r);return}}
                catch {setUncertain(preview.id)}
                throw e
              }
            })}>确认导出</button>}
          {uncertain&&!receipt&&<button className="p12-btn" disabled={pending} onClick={()=>action(async()=>{
            const r=await api.receipt(uncertain)
            if(r)setReceipt(r);else {setUncertain(undefined);throw new Error('未查到该操作；请重新预览')}
          })}>核对结果</button>}
          {needsCheck&&mode==='result'&&<button className="p12-btn" disabled={pending}
            onClick={()=>action(async()=>{const r=await api.receipt(receipt!.id);if(r)setReceipt(r)})}>核对结果</button>}
          {receipt?.canRetry&&<button className="p12-btn p12-btn--primary" disabled={pending} onClick={()=>{
            setCurrent(receipt.scope);setRetry(receipt.id);setReceipt(undefined);setPolicy('number');setLimit(pageSize);read(receipt.scope)
          }}>预览剩余项</button>}
        </div>
      </footer>
    </div>
  </dialog>
}

