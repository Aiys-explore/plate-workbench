import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'

export function UpdateControls() {
  const [message, setMessage] = useState('')
  const [available, setAvailable] = useState<Update>()
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const candidate = useRef<Update | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (!pending.current) void candidate.current?.close().catch(() => {})
    }
  }, [])

  async function run(operation: () => Promise<void>, errorMessage: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await operation()
    } catch {
      if (active.current) setMessage(errorMessage)
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
      else void candidate.current?.close().catch(() => {})
    }
  }

  function checkUpdates() {
    void run(async () => {
      setMessage('正在连接 GitHub 检查更新…')
      setAvailable(undefined)
      await candidate.current?.close()
      candidate.current = null
      const update = await check({ timeout: 15_000 })
      candidate.current = update
      if (!active.current) return
      setAvailable(update ?? undefined)
      setMessage(update ? `发现新版本 ${update.version}。请先保存正在编辑的笔记。` : '当前已是最新版本。')
    }, '无法从 GitHub 检查更新，请稍后重试。')
  }

  function installUpdate(update: Update) {
    void run(async () => {
      if (!await invoke<boolean>('update_can_install')) {
        setMessage('Agent 任务仍在运行，请在任务结束后安装更新。')
        return
      }
      setMessage('正在下载并验证更新包…')
      await update.download(undefined, { timeout: 180_000 })
      if (!active.current) return
      if (!await invoke<boolean>('update_can_install')) {
        setMessage('Agent 任务仍在运行，请在任务结束后安装更新。')
        return
      }
      if (!active.current) return
      setMessage('正在启动安装程序…')
      await update.install()
    }, '更新下载或安装失败，请稍后重试。')
  }

  return <>
    <button type="button" className="p13-action" disabled={busy} onClick={checkUpdates}>检查更新</button>
    {available && <button type="button" className="p13-action" disabled={busy}
      onClick={() => installUpdate(available)}>安装 {available.version} 并重启</button>}
    {message && <p role="status" className="p13-note">{message}</p>}
  </>
}
