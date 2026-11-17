import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  capabilityKeys, capabilityLabels, checkAgentInput, defaultInput, presets, probeLabels, type AgentFieldErrors, type AgentInput, type AgentProfile, type Evidence, type Icon
} from '../../shared/agents'
import { EditorDialog } from './note-editor'

const status = { supported: '已验证支持', unsupported: '已验证不支持', unknown: '未知' }
const icons: Record<Icon, [string, string]> = {
  terminal: ['终端', 'M5 7l5 5-5 5m8 0h6'],
  wave: ['浪形', 'M2 15c4 0 4-7 8-7 3 0 4 3 4 5 2 0 4-1 7-4M4 18h14'],
  spark: ['星形', 'M12 2v20M2 12h20M5 5l14 14m0-14L5 19'],
  robot: ['机器人', 'M7 8h10a3 3 0 013 3v6H4v-6a3 3 0 013-3zm5 0V4m-4 8v1m8-1v1']
}
const fields = [
  ['name', '名称'], ['executable', '可执行文件绝对路径'], ['model', '模型'], ['effort', '强度（effort）'],
  ['permission', '权限模式'], ['workdir', '工作目录'], ['logOverride', '日志目录覆盖']
] as const

const commonFields = fields.filter(([key])=>key==='name'||key==='model'||key==='effort')
const advancedFields = fields.filter(([key])=>key!=='name'&&key!=='model'&&key!=='effort')
const advancedKeys = new Set<keyof AgentInput>(['type', ...advancedFields.map(([key])=>key),'extraArgv','icon','color','timeoutMs'])
const fieldOrder = ['type',...fields.map(([key])=>key),'extraArgv','icon','color','timeoutMs','enabled'] as const
const fieldHelp: Record<keyof AgentInput,string> = {
  name:'必填，最多 100 字符。', type:'小写字母开头，最多 64 字符。',
  executable:'可留空；填写本机绝对路径。', model:'可留空；仅保存配置。', effort:'可留空；仅保存配置。',
  permission:'可留空；仅保存配置。', workdir:'可留空；填写本机绝对路径。',
  logOverride:'可留空；填写本机绝对路径。', extraArgv:'保持原顺序与空格；最多 32 项。',
  icon:'仅用于装饰。', color:'仅用于装饰。', timeoutMs:'100–30000 ms 的整数。', enabled:'启用后才可探测。'
}
type Uncertain = {id:string; deleting?:boolean; creation?:AgentInput; update?:AgentInput; reportedWritten?:boolean; enabled?:boolean}
let pendingCreation: Uncertain | undefined

function Mark({ icon, color }: { icon: Icon; color: string }) {
  return <svg aria-label={icons[icon][0]} role="img" width="25" height="25" viewBox="0 0 24 24"
    fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={icons[icon][1]} /></svg>
}
const evidenceDate = (date: string | null) => date ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(date)) : '—'

function profileQualifiers(profiles: AgentProfile[]) {
  const byName = new Map<string, AgentProfile[]>()
  for (const profile of profiles) {
    const group = byName.get(profile.name) ?? []
    group.push(profile)
    byName.set(profile.name, group)
  }
  const qualifiers = new Map<string, string>()
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const suffixCounts = new Map<string, number>()
    for (const { id } of group) {
      const suffix = id.slice(-8)
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1)
    }
    for (const { id, type } of group) {
      const suffix = id.slice(-8)
      const identifier = suffixCounts.get(suffix) === 1 ? suffix : id
      qualifiers.set(id, `${type} · ${identifier}`)
    }
  }
  return qualifiers
}

export function AgentSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const qualifiers = useMemo(() => profileQualifiers(profiles), [profiles])
  const qualify = (profile: AgentProfile, label: string) => {
    const qualifier = qualifiers.get(profile.id)
    return qualifier ? `${label}（${qualifier}）` : label
  }
  const menuLabel = (profile: AgentProfile) => qualify(profile, `${profile.name}档案操作`)
  const [selected, setSelected] = useState<AgentProfile | null>(null)
  const [form, setForm] = useState<AgentInput>(()=>pendingCreation?.creation ?? defaultInput())
  const [argv, setArgv] = useState(()=>JSON.stringify(pendingCreation?.creation?.extraArgv ?? []))
  const [paths, setPaths] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteIssue,setDeleteIssue]=useState('')
  const [detail, setDetail] = useState(!!pendingCreation)
  const [discovering,setDiscovering] = useState<string>()
  const discovery = useRef<string | undefined>(undefined)
  const [discoveryResults,setDiscoveryResults] = useState<Record<string,number>>({})
  const returnTo = useRef<{ id?:string; trigger?:HTMLElement }>({})
  const heading = useRef<HTMLHeadingElement>(null)
  const focusAfterDelete=useRef(false)
  const [pendingPreset, setPendingPreset] = useState<string>()
  const [leave, setLeave] = useState<{proceed: () => void; discard?: () => void}>()
  const [rowMenu,setRowMenu] = useState<{profile:AgentProfile; anchor:HTMLElement}>()
  const rowMenuRef=useRef<HTMLDivElement>(null)
  const [readIssue,setReadIssue]=useState('')
  const [uncertain,setUncertain]=useState<Uncertain|undefined>(()=>pendingCreation)
  const advanced = useRef<HTMLDetailsElement>(null)
  const diagnostics = useRef<HTMLDetailsElement>(null)
  const [fieldErrors,setFieldErrors]=useState<AgentFieldErrors>({})
  const creationId=useRef<string|undefined>(pendingCreation?.id)
  const windows=navigator.userAgent.includes('Windows')
  const [evidence,setEvidence] = useState<{key:typeof capabilityKeys[number]; item:Evidence; historical:boolean}>()
  const taskActive = useRef(false)
  const evidenceOrigin = useRef<HTMLElement | null>(null)
  const preset = presets.find((item) => item.type === form.type)
  const api = window.workbench.agents
  useEffect(() => {
    dialog.current?.showModal()
    heading.current?.focus()
    void task(async()=>{
      try { setProfiles(await api.list()) }
      catch (e) {setReadIssue(String(e))}
    })
    return ()=>{const id=discovery.current;discovery.current=undefined;if(id)void api.cancelDiscover(id).catch(()=>{})}
  }, [api])
  const beforeLeave = (action: () => void, discard?: () => void) => {
    if (busy || uncertain || discovery.current) return
    if (dirty) setLeave({proceed:action,discard})
    else action()
  }
  const close = () => {
    if (busy || discovery.current || (uncertain && !uncertain.creation)) return
    if (uncertain?.creation || !dirty) onClose()
    else setLeave({proceed:onClose})
  }
  const task = async (run: () => Promise<void>) => {
    if (taskActive.current) return
    taskActive.current = true
    setBusy(true); setMessage('')
    try { await run() } catch (e) { setMessage(String(e)) } finally { taskActive.current=false;setBusy(false) }
  }
  const select = (profile: AgentProfile | null) => {
    setSelected(profile); setForm(profile ?? defaultInput()); setArgv(JSON.stringify(profile?.extraArgv ?? [], null, 2))
    setDirty(false); setPaths([]); setMessage(''); setDeleting(false);setDeleteIssue('');setFieldErrors({})
    creationId.current=undefined
  }
  const showDetail = (profile:AgentProfile|null, trigger?:HTMLElement, presetType?:string) => {
    select(profile)
    if (advanced.current) advanced.current.open=false
    if (diagnostics.current) diagnostics.current.open=false
    returnTo.current={id:profile?.id,trigger}
    if(presetType){setForm(defaultInput(presetType));setDirty(true)}
    setDetail(true);focusField('name')
  }
  const showGrid = (deleted = false) => {
    const origin=returnTo.current
    setDetail(false);select(null)
    if(deleted){focusAfterDelete.current=true;setMessage('档案已删除；原入口已失效。')}
    requestAnimationFrame(()=>{
      const row=origin.id ? dialog.current?.querySelector<HTMLElement>(`[data-runtime-id="${CSS.escape(origin.id)}"] .agent-profile-row`) : undefined
      const target=(deleted && origin.id) ? heading.current : [origin.trigger,row,heading.current].find(el=>
        el?.isConnected && el.getClientRects().length>0 && !el.matches(':disabled'))
      if(origin.id && !row?.getClientRects().length && !deleted) setMessage('原档案入口已失效，已返回运行时。')
      target?.focus()
    })
  }
  useEffect(()=>{
    if(busy || detail || deleting || !focusAfterDelete.current)return
    const frame=requestAnimationFrame(()=>{
      focusAfterDelete.current=false
      heading.current?.focus({preventScroll:true})
    })
    return()=>cancelAnimationFrame(frame)
  },[busy,detail,deleting])
  function clearField(key: keyof AgentInput) {
    setFieldErrors(old=>old[key]?{...old,[key]:undefined}:old)
  }
  function associate(key: keyof AgentInput) {
    return { id:'agent-field-'+key, 'aria-invalid':!!fieldErrors[key],
      'aria-describedby':fieldErrors[key]?'agent-error-'+key:'agent-help-'+key }
  }
  function describe(key: keyof AgentInput) {
    return fieldErrors[key]
      ? <span role="alert" id={'agent-error-'+key}>{fieldErrors[key]}</span>
      : <small className="agent-field-help" id={'agent-help-'+key}>{fieldHelp[key]}</small>
  }
  const focusField=(key:keyof AgentInput)=>requestAnimationFrame(()=>{
    if(advancedKeys.has(key) && advanced.current) advanced.current.open=true
    dialog.current?.querySelector<HTMLElement>('#agent-field-'+key)?.focus()
  })
  function change<K extends keyof AgentInput>(key: K, value: AgentInput[K]) {
    setForm((old) => ({ ...old, [key]: value }))
    setDirty(true)
    clearField(key)
    if (key === 'type' || key === 'executable') setPaths([])
  }
  const update = async (profile: AgentProfile, note: string) => {
    select(profile); setProfiles(await api.list()); setMessage(note)
  }
  const readProfiles=()=>void task(async()=>{
    let next:AgentProfile[]
    try { next=await api.list() }
    catch(error) {setReadIssue(String(error));return}
    setProfiles(next);setReadIssue('')
    if (!uncertain && selected && !next.some(p=>p.id===selected.id)) {
      if (dirty) setMessage('原档案已不存在；当前未保存的修改仍保留。')
      else showGrid()
    }
    if (uncertain) {
      const confirmed=next.find(p=>p.id===uncertain.id)
      if (uncertain.enabled !== undefined) {
        setUncertain(undefined)
        if (selected?.id===uncertain.id && !dirty) select(confirmed??null)
        setMessage(!confirmed?'原档案入口已失效，已返回运行时。':confirmed.enabled === uncertain.enabled
          ? '已核对启用状态；日志来源同步状态仍待确认。' : '启用状态未写入；已恢复已保存的状态。')
        requestAnimationFrame(()=>{
          const id=CSS.escape(uncertain.id)
          const trigger=dialog.current?.querySelector<HTMLElement>(`[data-runtime-id="${id}"] [role=switch]`)
          ;(trigger?.getClientRects().length?trigger:heading.current)?.focus()
        })
      } else if (uncertain.update && (!confirmed || fieldOrder.some(key=>JSON.stringify(confirmed[key])!==JSON.stringify(uncertain.update![key])))) {
        setUncertain(undefined)
        setMessage(confirmed?'没有核对到刚才的修改；已保留表单，可重试。':'档案已不存在；未保存的修改仍保留。')
        focusField('name')
      } else if (uncertain.deleting ? !confirmed : confirmed) {
        pendingCreation=undefined
        select(confirmed??null);setUncertain(undefined)
        if(uncertain.deleting) showGrid(true)
        setMessage(confirmed?'已核对写入的档案；日志来源同步状态仍待确认。':'已核对档案已删除。')
        requestAnimationFrame(()=>{if(confirmed)focusField('name');else heading.current?.focus()})
      } else if (uncertain.creation && !uncertain.reportedWritten) {
        pendingCreation=undefined
        setUncertain(undefined)
        setDirty(true)
        setMessage('未找到本次创建的档案。可用同一档案 ID 再试；不会重复创建。')
        requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('button[type=submit]')?.focus())
      } else if(uncertain.deleting && confirmed) {
        setUncertain(undefined);setMessage('已核对档案仍存在，可重试删除。')
      } else setMessage('无法核对上次提交，请检查档案列表。')
    }
  })
  const toggleProfile = (profile:AgentProfile, trigger:HTMLElement, openDetails = false) => {
    if (uncertain || taskActive.current || discovery.current) return
    const enabled=!profile.enabled
    void task(async()=>{
      let saved:AgentProfile
      try {saved=await api.setEnabled(profile.id,enabled)}
      catch(error){
        setUncertain({id:profile.id,enabled})
        requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('.agent-read-retry')?.focus())
        throw error
      }
      setProfiles(old=>old.map(item=>item.id===saved.id?saved:item))
      if(openDetails) showDetail(saved,trigger)
      setMessage(enabled?'档案已启用':'档案已停用')
      if(!openDetails) requestAnimationFrame(()=>{
        if(trigger.isConnected&&trigger.getClientRects().length)trigger.focus({preventScroll:true})
        else {heading.current?.focus();setMessage('档案状态已保存。原入口已失效，已返回运行时。')}
      })
    })
  }
  const discoverPaths = async () => {
    if (discovery.current || taskActive.current || uncertain) return
    const id=crypto.randomUUID(), type=form.type
    discovery.current=id;setDiscovering(id);setPaths([]);setMessage('正在查找本机 CLI…')
    requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('.agent-stop-discovery')?.focus())
    try {
      const found=await api.discover(type,id)
      if(discovery.current!==id)return
      setPaths(found);setDiscoveryResults(old=>({...old,[type]:found.length}))
      setMessage(found.length?'请选择一个候选路径':'未发现原生 CLI，可手填绝对路径')
    } catch(error) {if(discovery.current===id)setMessage('查找本机 CLI 失败：'+String(error))}
    finally {if(discovery.current===id) finishDiscovery()}
  }
  function finishDiscovery(cancel = false) {
    const id=discovery.current
    if(!id)return
    discovery.current=undefined;setDiscovering(undefined)
    if(cancel){void api.cancelDiscover(id).catch(()=>{});setMessage('已取消本次查找。')}
    requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('.agent-start-discovery')?.focus())
  }
  const writeProfile=async (id:string|null, input:AgentInput, message:string) => {
    if (uncertain) return
    let saved:AgentProfile
    const attempt=id===null ? (creationId.current ??= crypto.randomUUID()) : undefined
    try {saved=await api.save(id,input,attempt)}
    catch (error) {
      const reason=String(error)
      const written=/档案已写入（([a-f0-9-]+)）/.exec(reason)
      const field=/字段无效：([A-Za-z]+) · ([^\r\n]+)/.exec(reason)
      const key=fieldOrder.find(key=>key===field?.[1])
      if (key && field) {setFieldErrors(old=>({...old,[key]:field[2]}));focusField(key)}
      else if (written || attempt || id) {
        const state={id:written?.[1] ?? attempt ?? id!, creation:attempt ? input : undefined, update:id ? input : undefined, reportedWritten:!!written}
        if (attempt) pendingCreation=state
        setUncertain(state)
        requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>('.agent-read-retry')?.focus())
      }
      throw error
    }
    select(saved)
    setProfiles(previous=>[...previous.filter(profile=>profile.id!==saved.id),saved])
    try {setProfiles(await api.list());setMessage(message)}
    catch(error) {setReadIssue(String(error));setMessage(message+'；列表未刷新，请重试读取。')}
  }
  const saveProfile = async () => {
    if (uncertain || discovery.current) return false
    let extraArgv:unknown
    try { extraArgv = JSON.parse(argv) } catch { extraArgv=null }
    const {normalized,errors}=checkAgentInput({...form,extraArgv:extraArgv as string[]},windows)
    setFieldErrors(errors)
    const first=fieldOrder.find(key=>errors[key])
    if (first) {
      focusField(first)
      return false
    }
    await writeProfile(selected?.id ?? null, normalized, '档案已保存')
    return true
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    void task(async()=>{await saveProfile()})
  }
  const applyPreset = (type: string) => { setForm(defaultInput(type)); setArgv('[]'); setPaths([]); setFieldErrors({}); setDirty(true) }
  const dismissMenu=(restore=true)=>{
    const anchor=rowMenu?.anchor
    setRowMenu(undefined)
    if (restore) requestAnimationFrame(()=>{
      if (anchor?.isConnected && anchor.getClientRects().length) anchor.focus({preventScroll:true})
      else {heading.current?.focus();setMessage('原档案入口已失效，已返回运行时。')}
    })
  }
  useLayoutEffect(()=>{
    if(rowMenu && (!rowMenu.anchor.isConnected || !rowMenu.anchor.getClientRects().length)) dismissMenu()
  },[rowMenu,profiles,detail])
  useLayoutEffect(()=>{
    const menu=rowMenuRef.current, anchor=rowMenu?.anchor
    if (!menu || !anchor) return
    const rect=anchor.getBoundingClientRect(), host=dialog.current!.getBoundingClientRect()
    const width=menu.offsetWidth,height=menu.offsetHeight
    menu.style.left=Math.max(host.left+8,Math.min(rect.right-width,host.right-width-8))+'px'
    menu.style.top=Math.max(host.top+8,Math.min(host.bottom-height-8,rect.bottom+height>host.bottom-8?rect.top-height:rect.bottom))+'px'
    menu.querySelector('button')?.focus()
    const cancel=(e:PointerEvent)=>{if (e.target instanceof Node && !menu.contains(e.target) && !anchor.contains(e.target)) dismissMenu(false)}
    document.addEventListener('pointerdown',cancel)
    return()=>document.removeEventListener('pointerdown',cancel)
  },[rowMenu])
  const undiscovered=profiles.filter(profile=>profile.probe?.status==='missing')
  const configured=profiles.filter(profile=>profile.probe?.status!=='missing')
  const presetsWithoutProfile=presets.filter(item=>!profiles.some(profile=>profile.type===item.type))
  const notFoundPresets=presetsWithoutProfile.filter(item=>discoveryResults[item.type]===0)
  const openFor=(profile:AgentProfile|null,trigger:HTMLElement,presetType?:string)=>beforeLeave(()=>showDetail(profile,trigger,presetType))
  const cell=(profile:AgentProfile)=>{
    const state=profile.enabled ? profile.probe?.status ?? 'unprobed' : 'off'
    return <li className="runtime-cell" key={profile.id} data-runtime-id={profile.id}>
      <button type="button" className="agent-profile-row" aria-label={qualify(profile, profile.name)}
        aria-describedby={'runtime-state-'+profile.id}
        aria-current={selected?.id===profile.id} disabled={busy}
        onContextMenu={event=>{event.preventDefault();setRowMenu({profile,anchor:event.currentTarget})}}
        onKeyDown={event=>{if ((event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')) && !event.nativeEvent.isComposing) {
          event.preventDefault();setRowMenu({profile,anchor:event.currentTarget})
        }}} onClick={event=>openFor(profile,event.currentTarget)}>
        <span className="runtime-label"><strong>{profile.name}</strong>
          <small id={'runtime-state-'+profile.id} data-probe={state}>
          {state==='off'?'已关闭':state==='unprobed'?'未探测':probeLabels[state]}
        </small></span>
      </button>
      <button type="button" className="runtime-menu" disabled={busy} aria-label={menuLabel(profile)} aria-haspopup="menu"
        aria-expanded={rowMenu?.profile.id===profile.id} onClick={event=>setRowMenu({profile,anchor:event.currentTarget})}>⋯</button>
      <button type="button" className="runtime-switch" role="switch" aria-checked={profile.enabled}
        aria-label={qualify(profile, '启用 '+profile.name)} aria-disabled={busy||!!uncertain} onClick={event=>toggleProfile(profile,event.currentTarget)}><span/></button>
    </li>
  }
  const candidate=(item:typeof presets[number], missing=false)=><li className="runtime-cell" key={item.type}>
    <button type="button" className="agent-profile-row" aria-label={'为 '+item.name+' 新建档案'} disabled={busy}
      onClick={event=>openFor(null,event.currentTarget,item.type)}>
      <span className="runtime-label"><strong>{item.name}</strong><small>{missing?'未发现':discoveryResults[item.type]?'有候选路径 · 未验证':'待配置 · 未验证'}</small></span>
    </button>
  </li>
  const renderField=([key,label]:typeof fields[number])=><div className="agent-field" key={key}>
    <label htmlFor={'agent-field-'+key}>{label}</label>
    <input {...associate(key)} required={key === 'name'} value={form[key]} onChange={event=>change(key,event.target.value)}/>
    {describe(key)}
  </div>
  return <dialog ref={dialog} className="agent-settings" aria-label="设置 · Agent 档案" data-detail={detail}
    onCancel={(event) => {
      // Nested dialogs bubble React cancel events through this host.
      if(event.target!==event.currentTarget)return
      event.preventDefault()
      if (rowMenu) dismissMenu()
      else if(discovery.current)finishDiscovery(true)
      else if(detail && !uncertain)beforeLeave(showGrid)
      else close()
    }}>
    <header><h2 id="agent-settings-title" tabIndex={-1} ref={heading}>{detail ? selected?.name || '新建 Agent' : 'Agent'}</h2><button onClick={close} disabled={busy||!!discovering||!!uncertain&&!uncertain.creation}>关闭设置</button></header>
    <div className="agent-settings-body">
      <div className="agent-settings-scroll">
        {(readIssue || uncertain) && <p role="status">{readIssue?'档案列表读取失败：'+readIssue:'请先核对上次提交。'}
          <button className="agent-read-retry" disabled={busy} type="button" onClick={readProfiles}>重试读取档案</button></p>}
        <p className="agent-settings-message" role="status">{busy ? '处理中…' : message}</p>
        <section className="runtime-overview" hidden={detail} aria-label="运行时档案">
          <p className="runtime-intro">选择本机 Agent。启用后仍需验证能力。</p>
          <div className="agent-settings-actions">
            <button type="button" className="button-primary" disabled={busy||!!uncertain} onClick={event=>openFor(null,event.currentTarget)}>新建档案</button>
            <button type="button" disabled={busy} onClick={readProfiles}>刷新档案</button>
          </div>
          {configured.length>0 ? <ul className="runtime-grid" aria-label="已配置的档案">{configured.map(cell)}</ul>
            : !busy && !readIssue && !profiles.length && <p>还没有运行时档案。请新建档案，或从待配置的预设开始。</p>}
          <details className="runtime-group">
            <summary>未发现（{undiscovered.length+notFoundPresets.length}）</summary>
            {undiscovered.length+notFoundPresets.length>0 ? <ul className="runtime-grid">{undiscovered.map(cell)}{notFoundPresets.map(item=>candidate(item,true))}</ul>
              : <p>暂无已核查但未发现的项目。</p>}
          </details>
          <details className="runtime-group"><summary>待配置 / 未验证（{presetsWithoutProfile.length-notFoundPresets.length}）</summary>
            <ul className="runtime-grid">{presetsWithoutProfile.filter(item=>discoveryResults[item.type]!==0).map(item=>candidate(item))}</ul>
          </details>
        </section>
        <div className="agent-settings-detail" hidden={!detail}>
        <button type="button" disabled={busy||!!uncertain||!!discovering} onClick={()=>beforeLeave(showGrid)}>返回运行时</button>
        <form noValidate onSubmit={save}>
          <fieldset disabled={busy || !!uncertain?.creation || !!discovering}>
            <div className="agent-common-fields">{commonFields.map(renderField)}</div>
            <div className="agent-field"><label className="agent-enabled"><input {...associate('enabled')} type="checkbox" checked={form.enabled}
                onChange={(event) => change('enabled', event.target.checked)} />启用</label>{describe('enabled')}</div>
            <div className="agent-settings-actions agent-default-actions">
              <button className="button-primary" type="submit" aria-disabled={!!uncertain}>保存档案</button>
              <button type="button" className="agent-start-discovery" onClick={()=>void discoverPaths()}>查找本机 CLI</button>
              {paths.length > 0 && <select aria-label="候选 CLI 路径" value="" onChange={event=>{
                change('executable', event.target.value)
                focusField('executable')
              }}>
                <option value="">选择候选路径</option>
                {paths.map((path) => <option key={path}>{path}</option>)}
              </select>}
            </div>
            <details ref={advanced} className="agent-disclosure">
              <summary>高级配置</summary>
              <div className="agent-disclosure-content">
            <label>预设
              <select value={preset?.type ?? 'custom'} onChange={(event) => {
                if (selected || dirty) setPendingPreset(event.target.value)
                else applyPreset(event.target.value)
              }}>
                <option value="custom">自定义类型</option>
                {presets.map(({ type, name }) => <option key={type} value={type}>{name}</option>)}
              </select>
            </label>
            {!preset && <div className="agent-field"><label htmlFor="agent-field-type">类型标识</label><input {...associate('type')} required value={form.type}
              onChange={(event) => change('type', event.target.value)} />{describe('type')}</div>}
            <div className="agent-common-fields">{advancedFields.map(renderField)}</div>
            <div className="agent-field agent-argv-field"><label htmlFor="agent-field-extraArgv">额外 argv（JSON 字符串数组）</label>
              <textarea {...associate('extraArgv')} rows={2} value={argv}
                onChange={(event) => { setArgv(event.target.value);clearField('extraArgv');setDirty(true) }} />
              {describe('extraArgv')}</div>
            <div className="agent-settings-fields">
              <div><label htmlFor="agent-field-icon">图标</label><select {...associate('icon')} value={form.icon} onChange={(event) => change('icon', event.target.value as Icon)}>
                {Object.entries(icons).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
              </select>{describe('icon')}</div>
              <div><label htmlFor="agent-field-color">品牌色</label><input {...associate('color')} type="color" value={form.color}
                onChange={(event) => change('color', event.target.value)} />{describe('color')}</div>
              <Mark {...form} />
              <div><label htmlFor="agent-field-timeoutMs">单项探测超时（ms）</label><input {...associate('timeoutMs')} type="number" min="100" max="30000" step="1" required value={form.timeoutMs || ''}
                onChange={(event) => change('timeoutMs', Number(event.target.value))} />{describe('timeoutMs')}</div>
            </div>
            {selected && <button type="button" disabled={!!uncertain} onClick={() => beforeLeave(()=>{setDeleteIssue('');setDeleting(true)},
                () => select(selected))}>删除档案</button>}
            </div></details>
          </fieldset>
        </form>
        {discovering && <button type="button" className="agent-stop-discovery" onClick={()=>finishDiscovery(true)}>取消查找</button>}
        <details className="agent-disclosure" ref={diagnostics}><summary>诊断与能力</summary>
          <section className="agent-disclosure-content" aria-label="探测与能力矩阵">
          <p className="agent-settings-hint">探测只使用 <code>--version</code> 和 <code>--help</code>。模型、权限、工作目录和额外参数只保存为配置。</p>
          {selected && !dirty && <p className="agent-effective-log">{selected.type === 'zcode' ? '有效会话数据库' : '有效日志目录'}：<code>{selected.logPath || '—'}</code>（{selected.logSource}）</p>}
          {selected && <div className="agent-settings-actions">
            {[false, true].map((force) => <button type="button" key={String(force)} disabled={busy || dirty || !selected.enabled || !!discovering || !!uncertain}
              onClick={() => void task(async () => update(await api.probe(selected.id, force), force ? '重新探测完成' : '探测完成'))}>
              {force ? '重新探测' : '探测 CLI'}
            </button>)}
          </div>}
          {selected?.probe && !dirty && <div className="agent-probe-summary">
            <strong>{probeLabels[selected.probe.status]}{selected.probe.version && ` · ${selected.probe.version}`}{selected.probe.cached && '（缓存）'}</strong>
            <p>探测时间：{selected.probe.date} · 适配器：{selected.probe.adapter}</p>
            <ul>{selected.probe.steps.map((step) => <li key={step.flag}><code>{step.flag}</code>：{step.detail}
              {step.code !== null && step.code !== 0 ? `（退出码 ${step.code}）` : ''}</li>)}</ul>
            {selected.probe.helpFlags.length > 0 && <details><summary>帮助页声明的参数</summary><code>{selected.probe.helpFlags.join(' ')}</code></details>}
          </div>}
          {selected && <p className="agent-settings-hint">登录：未验证</p>}
          <p className="agent-settings-hint">CLI 帮助、协议登记和受管续接属于不同证据。跳回客户端或独立终端须核对本机和当前会话；可用方式以会话入口为准。</p>
          <div className="agent-matrix-scroll" tabIndex={0} role="region" aria-label="能力表，可横向滚动"><table className="agent-matrix">
            <thead><tr><th>能力</th><th>状态</th><th>来源</th><th>适配器</th><th>日期</th></tr></thead>
            <tbody>{capabilityKeys.map((key) => {
              const item = dirty ? undefined : selected?.capabilities[key]
              const historical = dirty ? undefined : selected?.historicalCapabilities?.[key]
              return <tr key={key}><th scope="row">{capabilityLabels[key]}</th>
                <td data-state={item?.state ?? 'unknown'}>{status[item?.state ?? 'unknown']}</td>
                <td>{item?.source ?? (dirty ? '保存后显示档案证据' : '暂无验证证据')}
                  {item && <button type="button" onClick={event=>{evidenceOrigin.current=event.currentTarget;setEvidence({key,item,historical:false})}}>查看{capabilityLabels[key]}证据</button>}
                  {historical && <button type="button" onClick={event=>{evidenceOrigin.current=event.currentTarget;setEvidence({key,item:historical,historical:true})}}>
                    {capabilityLabels[key]}旧证据，仅供对照
                  </button>}</td>
                <td>{item?.adapter ?? '—'}</td><td>{evidenceDate(item?.date ?? null)}</td></tr>
            })}</tbody>
          </table></div>
        </section></details>
        </div>
      </div>
    </div>
    {rowMenu && <div ref={rowMenuRef} role="menu" aria-label={menuLabel(rowMenu.profile)} className="agent-row-menu"
      onKeyDown={event=>{
        if (event.nativeEvent.isComposing) return
        const keys=['ArrowDown','ArrowUp','Home','End']
        if (event.key==='Escape' || event.key==='Tab') {
          if (event.key==='Escape') {event.preventDefault();event.stopPropagation()}
          rowMenu.anchor.focus({preventScroll:true});dismissMenu(false);return
        }
        if (!keys.includes(event.key)) return
        event.preventDefault()
        const items=[...event.currentTarget.querySelectorAll('button')]
        const from=items.indexOf(event.target as HTMLButtonElement)
        items[event.key==='Home'?0:event.key==='End'?items.length-1:(from+items.length+(event.key==='ArrowDown'?1:-1))%items.length]?.focus()
      }}>
      <button role="menuitem" type="button" tabIndex={-1} onClick={()=>{const {profile,anchor}=rowMenu;dismissMenu(false);openFor(profile,anchor)}}>编辑</button>
      <button role="menuitem" type="button" tabIndex={-1} onClick={()=>{const {profile,anchor}=rowMenu;dismissMenu(false);beforeLeave(()=>{
        toggleProfile(profile,anchor,true)
      })}}>{rowMenu.profile.enabled?'停用':'启用'}</button>
      <button role="menuitem" type="button" tabIndex={-1} onClick={()=>{const {profile,anchor}=rowMenu;dismissMenu(false);beforeLeave(()=>{
        showDetail(profile,anchor);setDeleting(true)
      })}}>删除</button>
    </div>}
    {evidence && selected && <EditorDialog title={capabilityLabels[evidence.key]+(evidence.historical?'旧证据':'证据')} close={()=>{
      setEvidence(undefined);requestAnimationFrame(()=>evidenceOrigin.current?.focus())
    }}>
      {evidence.historical && <p>旧证据仅供对照，不能验证当前配置。</p>}
      <dl><dt>{evidence.historical?'当时状态':'状态'}</dt><dd>{status[evidence.item.state]}</dd>
        <dt>来源</dt><dd>{evidence.item.source}</dd>
        <dt>适配器</dt><dd>{evidence.item.adapter}</dd>
        <dt>日期</dt><dd>{evidenceDate(evidence.item.date)}</dd></dl>
    </EditorDialog>}
    {pendingPreset && <EditorDialog title="重填预设" confirm close={() => setPendingPreset(undefined)}>
      <p>应用预设会重填当前表单。</p>
      <button type="button" onClick={() => { applyPreset(pendingPreset); setPendingPreset(undefined) }}>应用预设</button>
    </EditorDialog>}
    {deleting && selected && <EditorDialog title="删除档案" confirm close={() => {if(!taskActive.current)setDeleting(false)}}>
      <p>删除「{selected.name}」？</p><p>{selected.type} · {selected.id}</p>
      <p>将移除本地档案配置及其能力记录。CLI、日志和外部会话将保留。</p>
      {deleteIssue && <p role="alert">{deleteIssue}</p>}
      <button type="button" className="button-danger" disabled={busy} onClick={() => {
        setDeleteIssue('')
        void task(async () => { const id=selected.id
          try { await api.remove(id) }
          catch(error) {
            const reason=String(error)
            if (reason.includes('档案已删除（')) {setUncertain({id,deleting:true});setDeleting(false);setMessage(reason)}
            else setDeleteIssue(reason)
            return
          }
          showGrid(true); setProfiles(old=>old.filter(p=>p.id!==id))
          try {setProfiles(await api.list());setMessage('档案已删除；原入口已失效。')}
          catch(error) {setReadIssue(String(error));setMessage('档案已删除；列表未刷新。')} })
      }}>确认删除</button>
    </EditorDialog>}
    {leave && <EditorDialog title="有未保存的 Agent 档案修改" confirm cancelLabel="留在此页" close={() => setLeave(undefined)}>
      <button type="button" className="button-primary" disabled={!!uncertain} onClick={() => {setLeave(undefined);void task(async () => {if (await saveProfile()) leave.proceed()})}}>保存并继续</button>
      <button type="button" onClick={() => {setLeave(undefined);leave.discard?.();leave.proceed()}}>放弃并继续</button>
    </EditorDialog>}
  </dialog>
}
