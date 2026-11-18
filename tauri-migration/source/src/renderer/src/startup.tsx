import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { StartupState } from '../../shared/startup'
import { HelpDialog } from './help'
import { RuntimeManagerDialog } from './runtime-manager'

export function StartupGate({ workbench }: { workbench: (path: string) => ReactNode }) {
  const api = window.workbench.startup
  const [state, setState] = useState<StartupState>({ phase: 'reading' })
  const [working, setWorking] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const [modal, setModal] = useState<{ kind: 'help' | 'settings'; origin: HTMLElement }>()
  const action = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)
  const title = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const last = useRef<HTMLButtonElement>(null)
  const id = useId()
  const intro = state.phase === 'ready' && state.intro
  const entering = state.phase === 'ready' && !state.intro
  const shouldPoll = state.phase === 'reading' || state.phase === 'opening' || intro

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!shouldPoll || working || requestError) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const update = await api.state()
        if (!cancelled && !action.current) {
          setState(update)
          if (['reading', 'opening'].includes(update.phase) || (update.phase === 'ready' && update.intro))
            timer = setTimeout(() => void read(), update.phase === 'ready' ? 500 : 75)
        }
      } catch {
        if (!cancelled && !action.current) setRequestError(true)
      }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, requestError, shouldPoll, working])
  const candidate = state.phase === 'choose' || state.phase === 'blocked' ? state.candidate : undefined
  const rebuild = state.phase === 'choose' || state.phase === 'blocked' ? state.rebuild : undefined
  const focusKey = state.phase + ':' + (rebuild?.token ?? candidate?.token ?? '') + ':' + Number(requestError)
  useLayoutEffect(() => {
    if (!modal && !entering) title.current?.focus({ preventScroll: true })
  }, [focusKey, entering])
  useLayoutEffect(() => {
    if (entering) document.querySelector<HTMLElement>('.topbar h1')?.focus({ preventScroll: true })
  }, [entering])

  useLayoutEffect(() => {
    if (modal || working || !returnFocus.current) return
    const target = returnFocus.current
    returnFocus.current = null
    if (target.isConnected) target.focus({ preventScroll: true })
    else title.current?.focus({ preventScroll: true })
  }, [modal, working])

  function invoke(fn: () => Promise<StartupState | void>, restore?: HTMLElement) {
    if (action.current) return
    setRequestError(false)
    action.current = true
    setWorking(true)
    let restoreFocus = false
    void fn().then(update => {
      if (!mounted.current || !update) return
      if (restore && (update.phase === 'choose' || update.phase === 'blocked') &&
          update.phase === state.phase && update.candidate?.token === candidate?.token) restoreFocus = true
      setState(update)
    },
      () => { if (mounted.current) setRequestError(true) }).finally(() => {
      action.current = false
      if (mounted.current) {
        if (restoreFocus) returnFocus.current = restore ?? null
        setWorking(false)

      }
    })
  }
  function dismiss() {
    returnFocus.current = modal?.origin ?? title.current
    setModal(undefined)
  }

  function key(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === 'Process') return
    if (event.key === 'Escape') event.preventDefault()
    if (event.key !== 'Tab') return
    const active = document.activeElement
    if (active === title.current || (event.shiftKey ? active === body.current : active === last.current)) {
      event.preventDefault()
      ;(event.shiftKey ? last.current : body.current)?.focus()
    }
  }
  if (entering && state.phase === 'ready') return workbench(state.path)

  const blocked = state.phase === 'blocked'
  const disabled = working || state.phase === 'opening'
  const choosing = state.phase === 'choose' || (blocked && !state.override)
  const titleText = requestError ? '无法读取本机启动状态' :
    state.phase === 'reading' ? '正在读取笔记位置' :
    state.phase === 'opening' ? '正在打开笔记位置' :
    state.phase === 'blocked' ? '无法打开笔记位置' :
    intro ? '笔记位置已就绪' : '选择笔记位置'
  return <>
    <main className="p13-help p13-startup" aria-labelledby={id} data-startup-phase={state.phase}
      inert={!!modal} onKeyDown={key}>
      <header className="p13-head"><h2 id={id} ref={title} tabIndex={-1}>{titleText}</h2></header>
      <div ref={body} className="p13-body" role="region" aria-label="启动正文" tabIndex={0}>
        <div role="status" className="p13-version-status">
          {state.phase === 'reading' && !requestError && <p>正在检查本机登记和已有笔记位置。</p>}
          {state.phase === 'opening' && <p>{state.path}</p>}
          {state.phase === 'choose' && <p>{state.suggested ? '默认建议：' + state.suggested :
            '无法读取 Windows“文档”文件夹，因而没有默认建议。请选择本机笔记目录。'}</p>}
          {blocked && <><p>{state.path ? '未能打开：' + state.path : '无法读取本机位置登记。'}</p>
            {state.override && !rebuild && <p>由启动参数指定。请修正启动参数后重新打开工作台。</p>}</>}
          {candidate && <><p>{candidate.kind === 'existing' ? '打开已有笔记' : '将在这里存放笔记'}</p>
            <p data-startup-candidate={candidate.kind}>{candidate.path}</p></>}
          {'error' in state && state.error && <p className={rebuild && !state.error.startsWith('未能完成') ? undefined : 'p13-error'}>{state.error}</p>}
          {rebuild && <div className="startup-rebuild">
            <strong>重建工作区</strong>
            <p>在原目录旁新建一个工作区，按已有分区复制 Markdown，再重新建立标题、标签和链接索引。原目录及文件保留。</p>
            <p>此操作不会迁移未保存草稿、画板布局、Agent 档案或旧会话。</p>
          </div>}
          {requestError && <p className="p13-error">本机启动请求没有成功返回。请重新读取状态，确认是否已打开原目录。</p>}
          {intro && <><p>本机笔记位置：{state.path}</p>
            <p>可以继续进入工作台；笔记列表会等待本机索引，索引可以取消和重试。</p>
            <p>{state.agent === 'unconfigured' ? '尚未配置已启用的 Agent。' :
              state.agent === 'failed' ? '无法读取 Agent 配置或初始化日志。' : '尚未验证 Agent 可用性。'} 无需 Agent 即可记事。</p></>}
        </div>
        <section aria-label="目录和设置操作">
          {blocked && <button type="button" className="p13-action" disabled={disabled}
            onClick={() => invoke(api.retry)}>重新检查</button>}
          {requestError && <button type="button" className="p13-action" disabled={disabled}
            onClick={() => invoke(api.state)}>重新读取状态</button>}
          {state.phase === 'choose' && state.suggested && <button type="button" className="p13-action" disabled={disabled}
            onClick={() => invoke(api.suggest)}>使用默认建议</button>}
          {choosing && <button type="button" className="p13-action" disabled={disabled}
            onClick={event => invoke(api.browse, event.currentTarget)}>
              {state.phase === 'choose' && !state.suggested ? '选择目录' : '选择其他目录'}</button>}
          {intro && <button type="button" className="p13-action" onClick={event =>
            setModal({ kind: 'settings', origin: event.currentTarget })}>打开 Agent 设置</button>}
          {!intro && <button type="button" className="p13-action" disabled={disabled}
            onClick={() => invoke(api.exit)}>退出工作台</button>}
        </section>
      </div>
      <footer className="p13-tail">
        <p className="p13-note" role="status">{disabled ? '操作正在进行' : intro ? '可离线使用' : rebuild ? '重建只写入新目录' : '确认后才打开所选位置'}</p>
        <div className="p13-startup-actions">
          <button ref={!intro && !candidate ? last : undefined} type="button" className="p13-action" onClick={event =>
            setModal({ kind: 'help', origin: event.currentTarget })}>查看帮助</button>
          {(intro || candidate || rebuild) && <button ref={last} type="button" className="p13-action p13-primary"
            aria-disabled={disabled} onClick={() => {
              if (disabled) return
              if (intro) invoke(api.continue)
              else if (rebuild) invoke(() => api.rebuild(rebuild.token))
              else if (candidate) invoke(() => api.submit(candidate.token))
            }}>{intro ? '继续记事' : rebuild ? '重建到新目录' : '打开笔记'}</button>}
        </div>
      </footer>
    </main>
    {modal?.kind === 'help' && <HelpDialog paletteBound={false} readAppInfo={window.workbench.getAppInfo}
      notePath={state.phase === 'ready' ? state.path : undefined} onClose={dismiss}/>}
    {modal?.kind === 'settings' && <RuntimeManagerDialog onClose={dismiss}/>}
  </>
}
