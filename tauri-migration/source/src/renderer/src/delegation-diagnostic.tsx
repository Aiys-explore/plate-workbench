import { useLayoutEffect, useRef, useState } from 'react'
import type { DiagnosticPreview, DiagnosticTarget } from '../../shared/delegation-diagnostic'

export function DiagnosticPanel({ target, close }: { target: DiagnosticTarget; close: () => void }) {
  const [preview, setPreview] = useState<DiagnosticPreview | null>()
  const [feedback, setFeedback] = useState('')
  const [expired, setExpired] = useState(false)
  const [writing, setWriting] = useState(false)
  const flight = useRef(false)
  const alive = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const frozen = useRef(target)
  const api = window.workbench.delegationDiagnostic
  useLayoutEffect(() => {
    let current = true
    let ticket: string | undefined
    alive.current = true
    heading.current?.focus()
    void api.open(frozen.current).then(next => {
      ticket = next?.ticket
      if (current) setPreview(next)
      else if (ticket) void api.close(ticket).catch(() => {})
    }).catch(() => { if (current) setPreview(null) })
    return () => {
      alive.current = current = false
      if (ticket) void api.close(ticket).catch(() => {})
    }
  }, [api])

  async function copy() {
    if (!preview || flight.current || expired) return
    flight.current = true
    setWriting(true)
    setFeedback('')
    try {
      const result = await api.copy(preview.ticket)
      if (alive.current && result === 'stale') setExpired(true)
      if (alive.current) setFeedback(result === 'copied' ? '已复制诊断，未发送' :
        result === 'stale' ? '诊断已失效，请关闭后重新查看。' : '无法复制诊断，请重试')
    } catch {
      if (alive.current) setFeedback('无法复制诊断，请重试')
    } finally {
      flight.current = false
      if (alive.current) setWriting(false)
    }
  }
  return <section className="delegation-diagnostic" aria-label="运行诊断">
    <h3 tabIndex={-1} ref={heading}>运行诊断</h3>
    {preview ? <pre tabIndex={0}>{preview.text}</pre> :
      <p>{preview === null ? '无法核对该运行的诊断。' : '正在读取诊断'}</p>}
    <button type="button" onClick={close}>关闭诊断</button>
    <button type="button" disabled={!preview || expired} aria-disabled={writing} onClick={() => void copy()}>
      {writing ? '正在复制' : '复制诊断'}
    </button>
    <p role="status">{feedback}</p>
  </section>
}
