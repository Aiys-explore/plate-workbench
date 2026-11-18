import { useEffect, useId, useRef, useState } from 'react'
import type { NoteFilters, NoteSummary, SearchResult } from '../../shared/ipc'

export function QuickNodePopover({ visible, filters, label, locate, close, searchAll }: {
  visible: NoteSummary[]
  filters: NoteFilters
  label: (note: NoteSummary) => string
  locate: (id: string) => void
  close: () => void
  searchAll: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const heading = useId()
  const [text, setText] = useState('')
  const [search, setSearch] = useState<{ query: string; rows?: SearchResult[]; error?: string }>()
  const query = text.trim()
  const rows = query ? search?.query === query ? search.rows : undefined : visible.map(note => ({ note }))
  const problem = query && search?.query === query ? search.error : ''
  const choices = (rows ?? []).slice(0, 80)
  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    input.current?.focus()
    return () => node?.close()
  }, [])
  useEffect(() => {
    if (!query) return
    let active = true
    const timer = window.setTimeout(() => {
      void window.workbench.notes.search({ ...filters, query }).then(
        found => { if (active) setSearch({ query, rows: found }) },
        () => { if (active) setSearch({ query, error: '搜索失败，请修改关键词后重试。' }) },
      )
    }, 110)
    return () => { active = false; clearTimeout(timer) }
  }, [query, filters])

  return <dialog ref={dialog} aria-labelledby={heading} className="plate-node-search"
    onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.target === event.currentTarget) close() }}>
    <section>
      <header><h2 id={heading}>搜索或跳转</h2>
        <button type="button" aria-label="关闭搜索" onClick={close}>×</button>
      </header>
      <form role="search" onSubmit={event => {
        event.preventDefault()
        if (choices[0]) locate(choices[0].note.id)
      }}>
        <input ref={input} type="search" aria-label="搜索笔记标题或正文" placeholder="搜索标题或正文"
          spellCheck={false} value={text} onChange={event => setText(event.target.value)} />
      </form>
      {problem ? <p role="alert">{problem}</p> : !rows ? <p role="status">搜索中…</p> :
        !rows.length ? <p role="status">没有匹配的笔记</p> :
          <ul>{choices.map(({ note }) => <li key={note.id}>
            <button type="button" onClick={() => locate(note.id)} title={label(note)}>
              <span>{note.title}</span><small>{label(note).split(' · ').slice(-2).join(' · ')}</small>
            </button>
          </li>)}</ul>}
      {rows && rows.length > choices.length && <p role="status">显示前 {choices.length} 项，请缩小搜索范围。</p>}
      {(filters.projectId || filters.tags?.length) && <button type="button" onClick={searchAll}>搜索全部导图</button>}
    </section>
  </dialog>
}
