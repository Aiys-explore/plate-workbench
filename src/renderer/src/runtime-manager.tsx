import { useEffect, useRef, useState } from 'react'
import { terminalPluginNames, type CatalogListing, type ProviderCandidate, type TerminalPlugin, type TerminalPluginId } from '../../shared/plate-terminal/contract'

const officialCatalog = 'fundops-notes/plate-terminal-plugins'
export const runtimeCopy: Record<ProviderCandidate['status'], string> = {
  startable: '已发现 · 登录未验证',
  desktop: '已发现桌面版',
  'not-installed': '未检测到 Agent 应用',
  'installed-not-wired': '已安装 · 暂不可启动',
  'detect-failed': '检测未完成',
}
export function useLocalRuntimes() {
  const [items, setItems] = useState<readonly ProviderCandidate[]>([])
  const [installed, setInstalled] = useState<readonly TerminalPlugin[]>([])
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState(false)
  const [tick, refresh] = useState(0)
  useEffect(() => {
    let live = true
    const load = () => {
      setScanning(true); setError(false)
      void window.workbench.plateTerminal.discover().then(result => {
        if (live) { setItems(result.candidates); setInstalled(result.installed ?? []); setError(result.truncated) }
      }, () => { if (live) setError(true) }).finally(() => { if (live) setScanning(false) })
    }
    load()
    window.addEventListener('plate-plugins-changed', load)
    return () => { live = false; window.removeEventListener('plate-plugins-changed', load) }
  }, [tick])
  return { items, installed, scanning, error, refresh: () => refresh(n => n + 1) }
}
type Runtimes = ReturnType<typeof useLocalRuntimes>
export function RuntimeManager({ runtimes, open }: { runtimes: Runtimes; open?: (item: ProviderCandidate) => void }) {
  const { items, installed, scanning, error } = runtimes
  const [details, setDetails] = useState<string>()
  const [repository, setRepository] = useState(officialCatalog)
  const [catalog, setCatalog] = useState<CatalogListing>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const operate = (fn: () => Promise<unknown>, message: string, changed = false) => {
    setBusy(true); setNotice('')
    void fn().then(() => {
      setNotice(message)
      if (changed) window.dispatchEvent(new Event('plate-plugins-changed'))
    }).catch(error => setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)))
      .finally(() => setBusy(false))
  }
  const row = (item: ProviderCandidate) => {
    if (item.flavor === 'other') return null
    const id: TerminalPluginId = item.flavor
    const plugin = installed.find(p => p.id === item.flavor)
    return <li key={item.flavor} className="home-runtime-row" data-runtime={item.flavor}>
      <div className="home-runtime-icon" data-flavor={item.flavor} aria-hidden="true">{item.displayName.slice(0, 1)}</div>
      <div className="home-runtime-label"><strong>{item.displayName}</strong>
        <span data-state={item.status}>{item.bundledLauncher ? '已发现 · 桌面版自带 dsh' : runtimeCopy[item.status]}
          {plugin ? ' · 连接器已安装' : ''}</span></div>
      <button type="button" aria-expanded={details === item.flavor} aria-label={item.displayName + ' 详情'}
        onClick={() => setDetails(current => current === item.flavor ? undefined : item.flavor)}>详情</button>
      {plugin ? <>
        {item.status === 'startable' && open && <button type="button" onClick={() => open(item)}>打开终端</button>}
        {item.status === 'desktop' && <button type="button" disabled={busy} onClick={() => operate(
          () => window.workbench.plateTerminal.desktop(), '已请求打开 ZCode')}>打开桌面版</button>}
        <button type="button" disabled={busy || scanning} onClick={() => operate(
          () => window.workbench.plateTerminal.remove(id), '已移除 ' + item.displayName + ' 插件', true)}>移除</button>
      </> : <button type="button" disabled={busy || scanning} onClick={() => operate(
        () => window.workbench.plateTerminal.install(id), '已安装 ' + item.displayName + ' 连接器', true)}>安装连接器</button>}
      {details === item.flavor && <div className="home-runtime-detail">
        <p>{item.reason}</p>
        {plugin && <small>适配包 {plugin.version} · {plugin.source === 'local' ? '随 Plate 提供' : plugin.source}</small>}
      </div>}
    </li>
  }
  const available = items.filter(item => item.flavor !== 'other')
  function rank(item: ProviderCandidate) {
    if (installed.some(plugin => plugin.id === item.flavor)) return 0
    return item.status === 'startable' || item.status === 'desktop' ? 1 : 2
  }
  return <section className="home-runtime-manager" aria-labelledby="home-runtime-title">
    <div className="plate-runtime-content">
    <header><div><small>工作台</small><h2 id="home-runtime-title" tabIndex={-1}>Agent 插件中心</h2></div>
      <button type="button" disabled={scanning} onClick={runtimes.refresh}>重新检测</button></header>
    <p>管理 Plate 与本机 Agent 之间的连接器。连接器与 Agent 应用分别安装；登录和权限仍在原客户端管理。</p>
    {scanning && <p role="status">正在检测本机 Agent…</p>}
    {error && <p role="status">无法读取部分插件或 Agent 状态，可以重新检测。</p>}
    <section className="plate-plugin-section" aria-labelledby="plate-installed">
      <h3 id="plate-installed">已安装连接器 <small>{available.filter(item => rank(item) === 0).length}</small></h3>
      {available.some(item => rank(item) === 0) ? <ul aria-label="已安装连接器">{available.filter(item => rank(item) === 0).map(row)}</ul>
        : <p>还没有连接器。可在下方为已发现的 Agent 安装。</p>}
    </section>
    <section className="plate-plugin-section" aria-labelledby="plate-discovered">
      <h3 id="plate-discovered">已发现 <small>{available.filter(item => rank(item) === 1).length}</small></h3>
      {available.some(item => rank(item) === 1) ? <ul aria-label="已发现的 Agent">{available.filter(item => rank(item) === 1).map(row)}</ul>
        : <p>{scanning ? '正在查找本机应用…' : available.some(item => item.status === 'startable' || item.status === 'desktop')
          ? '已发现的 Agent 均已安装连接器。' : '未发现可打开的 Agent。安装本机应用后可重新检测。'}</p>}
    </section>
    <details className="home-plugin-catalog">
      <summary>其他 Agent ({available.filter(item => rank(item) === 2).length})</summary>
      <ul aria-label="其他 Agent">{available.filter(item => rank(item) === 2).map(row)}</ul>
    </details>
    <details className="home-plugin-catalog">
      <summary>GitHub 插件目录</summary>
      <form onSubmit={event => {
        event.preventDefault(); setCatalog(undefined)
        operate(async () => setCatalog(await window.workbench.plateTerminal.catalog(repository)), '已读取 GitHub 插件目录')
      }}>
        <label>仓库 <input aria-label="GitHub 仓库" value={repository} onChange={event => {
          setRepository(event.target.value); setCatalog(undefined)
        }} placeholder="owner/repo"/></label>
        <button type="submit" disabled={busy || !repository.trim()}>读取目录</button>
      </form>
      {catalog && <ul aria-label="GitHub 插件">{catalog.plugins.map(plugin => {
        const current = installed.find(p => p.id === plugin.id)
        const same = current?.source === plugin.source && current.version === plugin.version
        return <li key={plugin.id} className="home-runtime-row">
          <div className="home-runtime-label"><strong>{terminalPluginNames[plugin.id]}</strong><small> 版本 {plugin.version}</small></div>
          <button type="button" disabled={busy || scanning || same} onClick={() => operate(
            () => window.workbench.plateTerminal.install(plugin.id, catalog.repository),
            '已从 GitHub 安装 ' + terminalPluginNames[plugin.id], true)}>{same ? '已安装' : current ? '切换到此版本' : '安装连接器'}</button>
        </li>
      })}</ul>}
    </details>
    {notice && <p role="status">{notice}</p>}
    </div>
  </section>
}
export function RuntimeManagerDialog({ onClose }: { onClose: () => void }) {
  const runtimes = useLocalRuntimes()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} className="home-runtime-dialog" aria-label="Agent 插件中心" onCancel={event => { event.preventDefault(); onClose() }}>
    <button type="button" onClick={onClose}>关闭</button>
    <RuntimeManager runtimes={runtimes}/>
  </dialog>
}
