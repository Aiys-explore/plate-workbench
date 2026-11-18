import { useEffect, useRef, useState } from 'react'
import { usageFields, type Dimension, type Measure, type Totals, type UsageReport } from '../../shared/usage'
import './styles/usage.css'
import { EditorDialog } from './note-editor'

const fmt = new Intl.NumberFormat('zh-CN')
const fields = {input:'输入',output:'输出',cachedInput:'缓存读取',cacheWrite:'缓存写入',reasoning:'推理',total:'总 Token'}
const dimensions = {adapter:'Agent',model:'模型',project:'项目'} as const
const date = (at: number | null) => at === null ? '未知' : new Date(at).toLocaleString('zh-CN')
const value = (m: Measure) => (m.value === null ? '未知' : fmt.format(m.value)) + (m.missing ? ' · 缺 ' + fmt.format(m.missing) : '')
const row = (t: Totals) => [t.sessions,t.turns,t.calls,t.tokens.total]
export function UsageDialog({close}:{close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null)
  const [days,setDays]=useState<7|30>(7)
  const [dim,setDim]=useState<Dimension>('adapter')
  const [filter,setFilter]=useState<string>()
  const [report,setReport]=useState<UsageReport>()
  const [error,setError]=useState(false)
  const [edit,setEdit]=useState<string>()
  const [saveError,setSaveError]=useState(false)
  const [inputError,setInputError]=useState(false)
  const [saving,setSaving]=useState(false)
  const [refreshingWrite,setRefreshingWrite]=useState(false)
  const writeInProgress=useRef(false)
  const editButton=useRef<HTMLButtonElement>(null)
  const editInput=useRef<HTMLInputElement>(null)
  const clearButton=useRef<HTMLButtonElement>(null)
  const [revision,reload]=useState(0)
  const [activeDay,setActiveDay]=useState(0)
  const [tip,setTip]=useState<number>()
  const [clear,setClear]=useState(false)
  useEffect(()=>{ref.current?.showModal()},[])
  useEffect(()=>{
    let stale=false, running=false
    const fetch=async()=>{
      if(running)return
      running=true
      try {
        const r=await window.workbench.sessions.usage(days,dim,filter===undefined?undefined:JSON.parse(filter))
        if(!stale){setReport(r);setError(false);setRefreshingWrite(false)}
      }catch{if(!stale)setError(true)}finally{running=false}
    }
    void fetch(); const timer=setInterval(()=>void fetch(),4000)
    return ()=>{stale=true;clearInterval(timer)}
  },[days,dim,filter,revision])
  const save=async(limit:number|null)=>{
    if(writeInProgress.current)return
    if(limit!==null && (!Number.isSafeInteger(limit)||limit<1)){setInputError(true);return}
    writeInProgress.current=true
    setSaving(true);setSaveError(false)
    try{
      await window.workbench.sessions.manualLimit(limit)
      setEdit(undefined);setClear(false);setRefreshingWrite(true);reload(v=>v+1)
      requestAnimationFrame(()=>editButton.current?.focus())
    }
    catch{setSaveError(true)}
    finally{writeInProgress.current=false;setSaving(false)}
  }
  const peak=Math.max(1,...(report?.days.map(d=>d.totals.tokens.total.value??0)??[]))
  const unit=10**Math.floor(Math.log10(peak))
  const step=Math.max(1,unit/2)
  const max=Math.ceil(peak/step)*step
  const reset=(fn:()=>void)=>{setReport(undefined);setActiveDay(0);setTip(undefined);fn()}
  const cancelEdit=()=>{setEdit(undefined);setInputError(false);setSaveError(false);requestAnimationFrame(()=>editButton.current?.focus())}
  return <dialog ref={ref} className="session-detail usage-dialog" aria-labelledby="usage-heading" onCancel={e=>{
    e.preventDefault()
    if(saving)return
    if(edit!==undefined)cancelEdit()
    else close()
  }}>
    <header><h2 id="usage-heading">用量统计</h2><button type="button" disabled={saving} onClick={close}>关闭明细</button></header>
    <div className="usage-controls">
      <div role="group" aria-label="时间范围">{([7,30] as const).map(period => <button key={period} type="button" aria-pressed={days === period}
        onClick={() => { if (days !== period) reset(() => { setDays(period); setFilter(undefined) }) }}>近 {period} 日</button>)}</div>
      <label>分组维度 <select value={dim} onChange={e=>reset(()=>{setDim(e.target.value as Dimension);setFilter(undefined)})}>
        {Object.entries(dimensions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>筛选 <select value={filter??''} onChange={e=>reset(()=>setFilter(e.target.value||undefined))}>
        <option value="">全部</option>{filter!==undefined && !report && <option value={filter}>读取中</option>}
        {filter!==undefined && report && !report.filter.some(f=>JSON.stringify(f.key)===filter) &&
          <option value={filter}>当前范围无数据</option>}
        {report?.filter.map(f=><option key={JSON.stringify(f.key)} value={JSON.stringify(f.key)} title={f.key??undefined}>{f.label}{dim==='project'&&f.key?' · '+f.key:''}</option>)}</select></label>
    </div>
    {error && <p role="status">{refreshingWrite?'写入成功，报告未刷新。':report?'读取用量失败，以下为上次读取。':'读取用量失败。'}
      <button type="button" onClick={()=>reload(v=>v+1)}>重试读取</button></p>}
    {!report ? <p>正在读取本地用量…</p> : <>
      <p>{report.timeZone} · 截至 {date(report.through)} · 仅覆盖已读取日志。
        {report.undated>0&& ' '+report.undated+' 条无日期事件未计入。'}
        {report.badLines>0&& ' 有 '+report.badLines+' 条无法读取的日志。'}</p>
      <dl className="usage-totals">
        {(['活跃会话','已结束轮次','工具调用','总 Token']).map((label,i)=><div key={label}><dt>{label}</dt><dd>{value(row(report.total)[i])}</dd></div>)}
        {usageFields.filter(f=>f!=='total').map(f=><div key={f}><dt>{fields[f]}</dt><dd>{value(report.total.tokens[f])}</dd></div>)}
      </dl>
      <p>会话在窗口内去重；轮次按有标识的完成时间计；调用指可识别的工具开始。各 Token 字段按来源口径独立列示，缓存和推理不再加到原报总数。</p>
      <h3>每日趋势 · 已知总 Token</h3>
      <div className="usage-chart">
      <div className="usage-axis" aria-hidden="true">{[max,Math.round(max/2),0].map((n,i)=><span key={i}>{fmt.format(n)}</span>)}</div>
      <div className="usage-trend" role="group" aria-label="每日总 Token" onPointerLeave={()=>setTip(undefined)}
        onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setTip(undefined)}}
        onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key==='Escape' && tip!==undefined) {event.preventDefault(); event.stopPropagation();setTip(undefined);return}
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? report.days.length - 1 :
          Math.max(0, Math.min(report.days.length - 1, activeDay + (event.key === 'ArrowLeft' ? -1 : 1)))
        event.currentTarget.querySelectorAll('button')[next]?.focus()
      }}>
        {report.days.map((d,index)=>{const m=d.totals.tokens.total; const label = d.label+' · '+value(m)
          return <button key={d.key} type="button" aria-label={label} aria-describedby={tip===index?"usage-chart-tip":undefined} tabIndex={index === activeDay ? 0 : -1}
            onPointerEnter={()=>setTip(index)} onFocus={()=>{setActiveDay(index);setTip(index)}} onClick={()=>setTip(index)}>
          <span className="usage-bar-track" data-usage-state={m.value===null?'unknown':m.value===0?(m.missing?'partial-zero':'zero'):(m.missing?'partial':'known')}>
            {m.value===null ? <span className="usage-unknown">×</span> :
              m.value === 0 ? <span className={'usage-zero'+(m.missing?' partial-zero':'')}>○ 0</span> :
                <i className={m.missing?'partial':''} style={{height:m.value/max*100+'%'}}/>}</span>
          <small>{d.label.slice(5)}</small></button>})}
      </div>
      </div>
      {tip!==undefined && report.days[tip] && <p id="usage-chart-tip" className="usage-chart-tip" role="tooltip">
        {report.days[tip].label} · {value(report.days[tip].totals.tokens.total)}</p>}
      <p>× 未知 · ○ 已知零 · 斜纹为仅已知小计</p><details><summary>逐日数值</summary>
        <table><thead><tr><th>日期</th><th>会话</th><th>轮次</th><th>调用</th><th>总 Token</th></tr></thead><tbody>
          {report.days.map(d=><tr key={d.key}><th>{d.label}</th>{row(d.totals).map((m,i)=><td key={i}>{value(m)}</td>)}</tr>)}
        </tbody></table></details>
      <div className="usage-columns">
        <section><h3>按{dimensions[dim]}汇总</h3><table><thead><tr><th>{dimensions[dim]}</th><th>会话</th><th>轮次</th><th>调用</th><th>总 Token</th></tr></thead>
          <tbody>{report.groups.map(g=><tr key={g.key??''}><th title={g.key??undefined}>{g.label}</th>{row(g.totals).map((m,i)=><td key={i}>{value(m)}</td>)}</tr>)}</tbody></table>
          {!report.groups.length&&<p>没有可定位到此范围的事件。</p>}</section>
        <section><h3>模型分布</h3><p>分母：{report.modelDenominator===null?'未知':fmt.format(report.modelDenominator)} 个已知总 Token，含未归属模型，缺总数的记录不入分母。</p>
          <ul className="usage-distribution">{report.models.map(g=>{const m=g.totals.tokens.total, p=(report.modelDenominator??0)>0&&m.value!==null?m.value/report.modelDenominator!:null
            const percentage = p===null?'占比未知':p>0&&p<.001?'<0.1%':'约 '+(p*100).toFixed(1)+'%'
            return <li key={g.key??''}><span>{g.label}</span><span>{value(m)} · {report.total.tokens.total.missing&&p!==null?'仅已知小计占比 ':''}{percentage}</span>
              {p!==null&&<meter min={0} max={1} value={p} aria-label={g.label+' Token 占比'}/>}</li>})}</ul></section>
      </div>
      <section className="usage-quota"><h3>配额与重置</h3><p>最近一次本地报告 · 与上方用量筛选独立。API 余额：未知。</p>
        {!report.quota.length&&<p>官方上限、已用与重置：未知。</p>}
        {report.quota.map(q=><div key={q.scope+':'+q.slot}>
          <strong>{q.scope} · {q.slot==='primary'?'主窗口':q.slot==='secondary'?'次窗口':'日志 credits'}</strong>
          <span>{q.slot==='credits' ? '余额 '+q.balance+' '+q.unit :
            '已用 '+q.used+'% / '+q.limit+'% · 窗口 '+(q.windowMinutes===null?'未知':q.windowMinutes+' 分钟')+' · 重置 '+date(q.resetAt)}</span>
          <small>{q.source} · 更新 {date(q.at)}{q.resetAt!==null&&q.resetAt<=report.through?' · 已过重置时刻，等待新记录':''}</small>
        </div>)}
        <button type="button" ref={editButton} aria-expanded={edit!==undefined} disabled={saving} onClick={()=>{
          setEdit(String(report.manual?.limit??''));setInputError(false);setSaveError(false)
          requestAnimationFrame(()=>{editInput.current?.focus();editInput.current?.select()})
        }}>编辑参考</button>
        {report.manual&&<button type="button" ref={clearButton} disabled={saving} onClick={()=>{setSaveError(false);setClear(true)}}>清除</button>}
        {edit!==undefined && <form onSubmit={e=>{
          e.preventDefault()
          if(!/^\d+$/.test(edit)){setInputError(true);return}
          void save(Number(edit))
        }}>
          <label>手填参考上限（Token） <input ref={editInput} aria-label="手填参考上限" type="text" inputMode="numeric"
            aria-invalid={inputError} aria-describedby={inputError?"usage-limit-error":undefined} readOnly={saving} value={edit} onChange={e=>{setEdit(e.target.value);setInputError(false)}}/></label>
          <button type="submit" aria-disabled={saving}>保存上限</button><button type="button" disabled={saving} onClick={cancelEdit}>取消</button>
          {inputError&&<span id="usage-limit-error" role="alert">请输入 1 至 9007199254740991 的十进制整数。</span>}
          {saveError&&!clear&&<span role="alert">未能保存参考上限，请重试。</span>}
        </form>}
        <p>{report.manual?'手填上限 '+fmt.format(report.manual.limit)+' Token · 更新 '+date(report.manual.at)+' · ':''}手填已用、重置与余额：未知。</p>
      </section>
    </>}
    {clear && <EditorDialog title="清除手填参考上限" confirm close={() => {
      if(saving)return
      setClear(false);setSaveError(false);requestAnimationFrame(()=>clearButton.current?.focus())
    }}>
      <button type="button" aria-disabled={saving} onClick={() => void save(null)}>确认清除</button>
      {saveError&&<p role="alert">未能清除参考上限，请重试。</p>}
    </EditorDialog>}
  </dialog>
}

