/**
 * Real TUI renderer for one plate slot, backed by the vendored xterm 5.5.0
 * UMD bundle. Input, output and resize are scoped to this pane's channel
 * only; the channel is live output from the moment of subscription, bounded
 * history replay remains the host's concern.
 */
import { useEffect, useRef, useState } from 'react'
import './terminal-pane.css'

export interface TerminalChannel {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  onData(listener: (chunk: Uint8Array | string) => void): () => void
  onExit?(listener: (exitCode: number) => void): () => void
}

export interface TerminalPaneApi {
  focus(): void
  fit(): void
}

export interface TerminalPaneProps {
  channel: TerminalChannel
  /** Header label; two panes may share a label without sharing state. */
  label?: string
  className?: string
  autoFocus?: boolean
  onReady?: (api: TerminalPaneApi) => void
}

interface XtermDisposable {
  dispose(): void
}

interface FitAddonInstance {
  activate(terminal: XtermTerminal): void
  dispose(): void
  fit(): void
}

interface XtermTerminal {
  cols: number
  rows: number
  open(container: HTMLElement): void
  write(data: string | Uint8Array): void
  focus(): void
  resize(cols: number, rows: number): void
  dispose(): void
  loadAddon(addon: FitAddonInstance): void
  onData(listener: (data: string) => void): XtermDisposable
  onResize(listener: (size: { cols: number; rows: number }) => void): XtermDisposable
}

interface TerminalCtor {
  new (options?: Record<string, unknown>): XtermTerminal
}

interface FitAddonCtor {
  new (): FitAddonInstance
}

declare global {
  interface Window {
    Terminal?: TerminalCtor
    FitAddon?: { FitAddon: FitAddonCtor }
  }
}

interface LoadedVendor {
  Terminal: TerminalCtor
  FitAddon: FitAddonCtor
}

interface SizeSnapshot {
  width: number
  height: number
}

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`终端组件加载失败：${src}`))
    document.head.append(script)
  })

const loadStylesheet = (href: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`终端样式加载失败：${href}`))
    document.head.append(link)
  })

let vendorPromise: Promise<LoadedVendor> | null = null

const loadVendor = (): Promise<LoadedVendor> => {
  vendorPromise ??= (async () => {
    await Promise.all([
      // Emit self-hosted files so the packaged renderer can keep excluding data: scripts.
      loadStylesheet(new URL('./vendor/xterm.min.css?no-inline', import.meta.url).href),
      loadScript(new URL('./vendor/xterm.min.js?no-inline', import.meta.url).href),
      loadScript(new URL('./vendor/addon-fit.min.js?no-inline', import.meta.url).href),
    ])
    if (typeof window.Terminal !== 'function') throw new Error('终端组件加载失败：xterm 未注册')
    const FitAddonCtor = window.FitAddon?.FitAddon
    if (typeof FitAddonCtor !== 'function') throw new Error('终端组件加载失败：fit 插件未注册')
    return { Terminal: window.Terminal, FitAddon: FitAddonCtor }
  })()
  return vendorPromise
}

export function TerminalPane({ channel, label, className, autoFocus, onReady }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const [failed, setFailed] = useState<string | null>(null)
  const [exitedCode, setExitedCode] = useState<number | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let observer: ResizeObserver | null = null
    let term: XtermTerminal | null = null
    let fitAddon: FitAddonInstance | null = null
    const disposables: XtermDisposable[] = []
    let lastFitSize: SizeSnapshot | null = null

    loadVendor()
      .then((vendor) => {
        if (disposed) return
        term = new vendor.Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: "'Cascadia Mono', Consolas, 'Microsoft YaHei Mono', monospace",
          scrollback: 10000,
        })
        fitAddon = new vendor.FitAddon()
        term.loadAddon(fitAddon)
        term.open(container)
        fitAddon.fit()
        disposables.push(
          term.onData((data) => {
            channel.write(data)
          }),
        )
        disposables.push(
          term.onResize(({ cols, rows }) => {
            channel.resize(cols, rows)
          }),
        )
        disposables.push({ dispose: channel.onData((chunk) => term?.write(chunk)) })
        if (channel.onExit) {
          disposables.push({
            dispose: channel.onExit((exitCode) => {
              setExitedCode(exitCode)
              term?.write(`\r\n\x1b[2m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`)
            }),
          })
        }
        observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          if (!entry || !fitAddon) return
          const width = Math.floor(entry.contentRect.width)
          const height = Math.floor(entry.contentRect.height)
          if (width <= 0 || height <= 0) {
            lastFitSize = null
            return
          }
          if (lastFitSize && lastFitSize.width === width && lastFitSize.height === height) return
          lastFitSize = { width, height }
          fitAddon.fit()
        })
        observer.observe(container)
        channel.resize(term.cols, term.rows)
        if (autoFocus) term.focus()
        onReadyRef.current?.({
          focus: () => term?.focus(),
          fit: () => fitAddon?.fit(),
        })
      })
      .catch((error: unknown) => {
        if (!disposed) setFailed(error instanceof Error ? error.message : String(error))
      })

    return () => {
      disposed = true
      observer?.disconnect()
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {
          // xterm disposals must not block unmount cleanup
        }
      }
      try {
        term?.dispose()
      } catch {
        // ditto for the terminal itself
      }
      setExitedCode(null)
      setFailed(null)
    }
  }, [channel, autoFocus])

  return (
    <div className={className ? `plate-terminal-pane ${className}` : 'plate-terminal-pane'} data-plate-terminal-pane>
      {label ? <div className="plate-terminal-pane__label">{label}</div> : null}
      <div className="plate-terminal-pane__surface" ref={containerRef} />
      {failed ? <div className="plate-terminal-pane__error">终端渲染失败：{failed}</div> : null}
      {exitedCode !== null ? (
        <div className="plate-terminal-pane__exit">进程已退出（退出码 {exitedCode}）</div>
      ) : null}
    </div>
  )
}
