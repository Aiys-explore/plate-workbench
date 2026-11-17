import { useEffect, useRef, useState } from 'react'
import type { NoteIndexState } from '../../shared/note-index'

export function useNoteIndex() {
  const api = window.workbench.notes.index
  const [state,setState] = useState<NoteIndexState>()
  const [error,setError] = useState(false)
  const [acting,setActing] = useState(false)
  const order = useRef({ active: false, request: 0, version: 0, state: undefined as NoteIndexState | undefined })
  const accept = (update:NoteIndexState, request?: number) => {
    const current = order.current, old = current.state
    if (!current.active || (request !== undefined && request !== current.request) ||
        (old && (update.run < old.run || update.sequence < old.sequence))) return
    if (!old || update.sequence > old.sequence) {
      current.state = update
      current.version++
      setState(update)
      setError(false)
    } else if (request !== undefined && update.run === old.run && update.phase === old.phase) setError(false)
  }
  const read = async (status: () => Promise<NoteIndexState>) => {
    const current = order.current, request = ++current.request, version = current.version
    try { accept(await status(), request) } catch {
      if (current.active && request === current.request && version === current.version) setError(true)
    }
  }
  const refresh = () => { void read(api.status) }
  useEffect(()=>{
    order.current.active = true
    const disconnect=api.onProgress(update => accept(update))
    refresh()
    return () => { order.current.active = false; order.current.request++; disconnect() }
  },[api])
  const act = (action:'cancel'|'retry')=>{
    if (!state || acting) return
    setActing(true)
    void read(async () => (await api[action](state.run)).state).finally(() => {
      if (order.current.active) setActing(false)
    })
  }
  return { state, error, acting, act, refresh }
}

const phaseText:Record<NoteIndexState['phase'],string> = {
  waiting:'正在准备笔记索引',
  collecting:'正在收集笔记',
  reading:'正在读取笔记',
  committing:'正在提交完整索引，此阶段不可取消',
  ready:'笔记索引已就绪',
  cancelled:'笔记索引已取消',
  failed:'笔记索引未能提交',
  blocked:'工作区删除结果待核对，暂不能建立笔记索引'
}

export function NoteIndexNotice({ state, error, acting, act, refresh, agentCounts }: ReturnType<typeof useNoteIndex> & {
  agentCounts?: React.ReactNode
}) {
  const phase=state?.phase ?? 'waiting'
  const cancel=state && ['waiting','collecting','reading'].includes(phase)
  const retry=['cancelled','failed','blocked'].includes(phase)
  const count=state?.phase==='collecting' ? `已发现 ${state.found} 篇候选笔记（仍在收集）` :
    state?.phase==='reading' ? `已读取 ${state.read} / ${state.found} 篇` :
    state?.phase==='committing' ? `已读取 ${state.read} 篇` : undefined
  return <main className="pane notes-editor" aria-label="笔记">
    <div className="pane-heading"><h2>笔记</h2></div>
    <section className="note-notice" aria-label="笔记索引" data-note-index-phase={phase} data-note-index-run={state?.run}>
      <strong role="status">{phaseText[phase]}</strong>
      {count && <p data-note-index-count>{count}</p>}
      <p>这里暂不显示笔记标题、正文搜索和关系图。完成索引后可打开笔记并恢复本地草稿。</p>
      {state?.phase==='failed' && <p>{state.message}</p>}
      {cancel && <button type="button" disabled={acting} onClick={()=>act('cancel')}>取消索引</button>}
      {retry && <button type="button" disabled={acting} onClick={()=>act('retry')}>重新开始索引</button>}
      {error && <p role="alert">无法取得索引状态。 <button type="button" onClick={refresh}>刷新状态</button></p>}
    </section>
    {agentCounts}
  </main>
}
