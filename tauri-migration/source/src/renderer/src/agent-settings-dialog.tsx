import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type {
  AgentPluginsApi, AgentPluginSnapshot, AgentPluginView,
} from '../../shared/agent-plugins'
import { AgentPluginIcon } from './agent-plugin-icon'
import { useDiscoveredAgents } from './task-autocomplete'

const settingsEvent = 'plate-open-agent-settings'
const defaultVisibleRows = 5

export function openAgentSettings() {
  window.dispatchEvent(new Event(settingsEvent))
}

export function useAgentSettingsEntry(open: () => void) {
  useEffect(() => {
    window.addEventListener(settingsEvent, open)
    return () => window.removeEventListener(settingsEvent, open)
  }, [open])
}

function pluginApi() {
  return window.workbench.agentPlugins
}

function AgentDialog({ title, onClose, children, headerExtra }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  headerExtra?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} className={'plate-agent-dialog' + (headerExtra ? ' plate-agent-center-dialog' : '')} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <header>
      <h2 id={heading}>{title}</h2>
      {headerExtra}
      <button type="button" className="p13-action" title="关闭" aria-label="关闭" onClick={onClose}>×</button>
    </header>
    {children}
  </dialog>
}

function statusLabel(plugin: AgentPluginView) {
  if (!plugin.installed) return plugin.executable ? '本机已检测到 CLI' : '未检测到 CLI'
  if (plugin.status === 'connected') return '已接入'
  if (plugin.status === 'setup') return '待配置'
  return '未接入'
}

function versionText(plugin: AgentPluginView) {
  return [plugin.cliVersion && 'CLI ' + plugin.cliVersion, plugin.appVersion && 'App ' + plugin.appVersion].filter(Boolean).join(' · ')
}

function displayName(plugin: AgentPluginView) {
  return plugin.name || plugin.id
}

function defaultName(snapshot: AgentPluginSnapshot | undefined) {
  const plugin = snapshot?.installed.find(item => item.id === snapshot.defaultAgent)
  return plugin ? displayName(plugin) : '未配置'
}

function moved(ids: string[], from: number, to: number) {
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return ids
  const next = [...ids]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function AgentSettingsDialog({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<AgentPluginSnapshot>()
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [notice, setNotice] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [manageMode, setManageMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState('')
  const [pendingUninstall, setPendingUninstall] = useState<Set<string>>(new Set())
  const [showAvailable, setShowAvailable] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [manifest, setManifest] = useState('')
  const [detail, setDetail] = useState({
    model: '', deepseekKey: '', baseUrl: '', clearDeepseekKey: false,
  })
  const dragIndex = useRef(-1)

  useEffect(() => {
    const api = pluginApi()
    let live = true
    const unsubscribe = api.onChange(() => {
      if (!live) return
      void api.list().then(next => { if (live) setSnapshot(next) }, () => {})
    })
    setBusy(true)
    setIssue('')
    void api.list(true).then(next => {
      if (!live) return
      setSnapshot(next)
      setLoaded(true)
    }, error => {
      if (live) {
        setIssue(String(error))
        setLoaded(true)
      }
    }).finally(() => { if (live) setBusy(false) })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const run = async (action: (api: AgentPluginsApi) => Promise<AgentPluginSnapshot>, message = '') => {
    const api = pluginApi()
    setBusy(true)
    setIssue('')
    if (message) setNotice('')
    try {
      const next = await action(api)
      setSnapshot(next)
      if (message) setNotice(message)
    } catch (error) {
      setIssue(String(error))
    } finally {
      setBusy(false)
    }
  }

  const installed = snapshot?.installed ?? []
  const available = snapshot?.available ?? []
  const visibleInstalled = showAll || manageMode ? installed : installed.slice(0, defaultVisibleRows)
  const hiddenCount = installed.length - defaultVisibleRows
  const selectedRows = installed.filter(item => selected.has(item.id))
  const pendingRows = installed.filter(item => pendingUninstall.has(item.id))
  const toggleSelect = (id: string, checked: boolean) => {
    setSelected(current => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const openDetail = (plugin: AgentPluginView) => {
    if (expandedId === plugin.id) setExpandedId('')
    else {
      setDetail({ model: plugin.selectedModel, deepseekKey: '', baseUrl: plugin.baseUrl ?? '', clearDeepseekKey: false })
      setExpandedId(plugin.id)
    }
  }

  const movePlugin = (index: number, target: number) => {
    const ids = installed.map(item => item.id)
    const next = moved(ids, index, target)
    if (next !== ids) void run(api => api.reorder(next))
  }

  const browseExecutable = async (plugin: AgentPluginView) => {
    const api = pluginApi()
    setBusy(true)
    setIssue('')
    try {
      const path = await api.browseExecutable()
      if (path) {
        const next = await api.update({ id: plugin.id, customExecutable: path })
        setSnapshot(next)
        setNotice(`已指定 ${displayName(plugin)} 的可执行文件。`)
      }
    } catch (error) {
      setIssue(String(error))
    } finally {
      setBusy(false)
    }
  }

  const importPlugin = async () => {
    const api = pluginApi()
    let parsed: {
      id: string
      name: string
      executable: string
      args?: unknown
      modelFlag?: unknown
      models?: unknown
    }
    try {
      parsed = JSON.parse(manifest)
      if (typeof parsed.id !== 'string' || !parsed.id ||
          typeof parsed.name !== 'string' || !parsed.name ||
          typeof parsed.executable !== 'string') {
        throw new Error('导入格式需要 id、name、executable，且均为字符串。')
      }
      if (parsed.args !== undefined && (!Array.isArray(parsed.args) || parsed.args.some(item => typeof item !== 'string'))) {
        throw new Error('args 必须是字符串数组。')
      }
      if (parsed.modelFlag !== undefined && typeof parsed.modelFlag !== 'string') {
        throw new Error('modelFlag 必须是字符串。')
      }
      if (parsed.models !== undefined && (!Array.isArray(parsed.models) || parsed.models.some(item => typeof item !== 'string'))) {
        throw new Error('models 必须是字符串数组。')
      }
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error))
      return
    }
    setBusy(true)
    setIssue('')
    try {
      const next = await api.importManifest(manifest)
      setSnapshot(next)
      setManifest('')
      setShowImport(false)
      setNotice(`已导入 ${String(parsed.name)}，默认停用。`)
    } catch (error) {
      setIssue(String(error))
    } finally {
      setBusy(false)
    }
  }

  return <AgentDialog title={<><span className="plate-agent-breadcrumb-secondary">使用</span><span> / Agent</span></>}
    onClose={onClose}
    headerExtra={<button type="button" className="p13-action plate-agent-refresh" disabled={busy}
      onClick={() => void run(api => api.list(true), '已重新探测插件。')}>刷新探测</button>}>
    <div className="plate-agent-center">
      <p className="plate-agent-intro">
        开启接入并完成配置后，Agent 就会出现在笔记的 TODO 建议和任务指派里。拖动插件可调整默认执行顺序。
      </p>
      {issue && <p role="alert">{issue}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="plate-agent-status">
        <span>默认执行：<strong>{snapshot ? defaultName(snapshot) : '正在读取…'}</strong></span>
        <button type="button" className="plate-agent-manage" aria-pressed={manageMode} disabled={busy || !installed.length}
          onClick={() => {
            setManageMode(value => !value)
            setSelected(new Set())
            setPendingUninstall(new Set())
          }}>管理</button>
      </div>

      {!loaded ? <p role="status">正在读取 Agent 插件…</p> :
        !snapshot ? <p>未获得插件数据。</p> :
        <section className="plate-agent-card" aria-label="已安装 Agent 插件">
          {installed.length ? <>
            <ul className="plate-agent-list">
              {visibleInstalled.map((plugin, index) => <li key={plugin.id}
                className={expandedId === plugin.id ? 'plate-agent-row is-expanded' : 'plate-agent-row'}
                data-plugin-id={plugin.id}
                data-dragging={dragIndex.current === index ? 'true' : undefined}
                onDragStart={event => {
                  if (busy) { event.preventDefault(); return }
                  dragIndex.current = index
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', plugin.id)
                }}
                onDragOver={event => {
                  if (busy || dragIndex.current < 0) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={event => {
                  if (busy || dragIndex.current < 0) return
                  event.preventDefault()
                  movePlugin(dragIndex.current, index)
                  dragIndex.current = -1
                }}
                onDragEnd={() => { dragIndex.current = -1 }}>
                {manageMode && <label className="plate-agent-check">
                  <input type="checkbox" checked={selected.has(plugin.id)}
                    onChange={event => toggleSelect(plugin.id, event.target.checked)}/>
                  <span>选择</span>
                </label>}
                {manageMode ? <span className="plate-agent-order" draggable={!busy} aria-hidden="true">⋮⋮</span>
                  : <span className="plate-agent-grip" draggable={!busy} title="拖动调整优先级" aria-hidden="true">⋮⋮</span>}
                <AgentPluginIcon id={plugin.icon || plugin.id} className="plate-plugin-icon"/>
                <div className="plate-agent-name">
                  <strong>{displayName(plugin)}</strong>
                  <small>{versionText(plugin) || '未探测到版本'}</small>
                  <span data-status={plugin.status} title={plugin.hint}>
                    <i/>{statusLabel(plugin)}<em>{plugin.hint}</em>
                  </span>
                </div>
                {!manageMode && <button type="button" className="plate-agent-detail-toggle"
                  aria-expanded={expandedId === plugin.id} aria-controls={`plate-agent-detail-${plugin.id}`}
                  onClick={() => openDetail(plugin)}>{expandedId === plugin.id ? '收起' : '详情'} ›</button>}
                {!manageMode && <select className="plate-agent-model" value={plugin.selectedModel ?? ''}
                  aria-label={displayName(plugin) + ' 执行模型'}
                  disabled={busy || !plugin.supportsModel || !plugin.models.length}
                  title={plugin.modelSource === 'local' ? '本机模型记录' : plugin.models.length ? '预设模型，使用权限由 CLI 决定' : plugin.hint}
                  onChange={event => {
                    const model = event.target.value
                    if (expandedId === plugin.id) setDetail(current => ({ ...current, model }))
                    void run(api => api.update({ id: plugin.id, selectedModel: model }), '模型已更新。')
                  }}>
                  <option value="">沿用 CLI 配置</option>
                  {plugin.models.map(model => <option value={model} key={model}>{model}</option>)}
                </select>}
                {!manageMode && <button type="button" className="plate-agent-switch" role="switch"
                  aria-checked={plugin.enabled} aria-label={`${displayName(plugin)} 接入`}
                  disabled={busy} onClick={() => void run(api => api.update({ id: plugin.id, enabled: !plugin.enabled }))}>
                  <span/></button>}
                {manageMode && <div className="plate-agent-order-actions">
                  <button type="button" disabled={busy || index === 0} aria-label={`上移 ${displayName(plugin)}`}
                    onClick={() => movePlugin(index, index - 1)}>↑</button>
                  <button type="button" disabled={busy || index === installed.length - 1} aria-label={`下移 ${displayName(plugin)}`}
                    onClick={() => movePlugin(index, index + 1)}>↓</button>
                </div>}
                {expandedId === plugin.id && <div className="plate-agent-detail" id={`plate-agent-detail-${plugin.id}`}>
                  <label>可执行文件
                    <span>{plugin.executable || '未检测到'}</span>
                  </label>
                  <div className="plate-agent-detail-actions">
                    <button type="button" className="p13-action" disabled={busy} onClick={() => void browseExecutable(plugin)}>浏览本机程序…</button>
                    <button type="button" className="p13-action" disabled={busy || !plugin.customExecutable}
                      onClick={() => void run(api => api.update({ id: plugin.id, customExecutable: '' }), '已还原自动探测。')}>还原自动探测</button>
                  </div>
                  {plugin.supportsModel && <>
                    <label>自定义模型标识
                      <input value={detail.model} spellCheck={false} autoComplete="off" maxLength={128}
                        placeholder="留空沿用 CLI 配置"
                        onChange={event => setDetail(current => ({ ...current, model: event.target.value }))}/>
                    </label>
                    <div className="plate-agent-detail-actions">
                      <button type="button" className="p13-action" disabled={busy || detail.model.trim() === plugin.selectedModel}
                        onClick={() => void run(api => api.update({ id: plugin.id, selectedModel: detail.model.trim() }), '模型已更新。')}>保存模型</button>
                    </div>
                  </>}
                  {plugin.deepseekKey !== undefined && <>
                    <label>DeepSeek API Key
                      <input type="password" value={detail.deepseekKey} autoComplete="new-password" spellCheck={false} maxLength={1024}
                        placeholder={plugin.deepseekKey === 'saved' ? '已保存，输入新值即替换' :
                          plugin.deepseekKey === 'environment' ? '当前使用启动环境中的密钥' : '输入 DeepSeek API Key'}
                        onChange={event => setDetail(current => ({ ...current, deepseekKey: event.target.value, clearDeepseekKey: false }))}/>
                    </label>
                    {plugin.deepseekKey === 'saved' && <label className="plate-agent-clear-key">
                      <input type="checkbox" checked={detail.clearDeepseekKey}
                        onChange={event => setDetail(current => ({ ...current, clearDeepseekKey: event.target.checked, deepseekKey: event.target.checked ? '' : current.deepseekKey }))}/>
                      <span>保存时移除已存密钥</span>
                    </label>}
                    <label>Base URL
                      <input value={detail.baseUrl} spellCheck={false} autoComplete="off"
                        placeholder="留空使用默认地址" onChange={event =>
                          setDetail(current => ({ ...current, baseUrl: event.target.value }))}/>
                    </label>
                    <div className="plate-agent-detail-actions">
                      <button type="button" className="p13-action" disabled={busy} onClick={() => void run(async api => {
                        const next = await api.update({
                          id: plugin.id, deepseekKey: detail.deepseekKey.trim() || undefined,
                          clearDeepseekKey: detail.clearDeepseekKey, baseUrl: detail.baseUrl.trim(),
                        })
                        setDetail(current => ({ ...current, deepseekKey: '', clearDeepseekKey: false }))
                        return next
                      }, 'DeepSeek 连接设置已保存。')}>保存连接设置</button>
                    </div>
                  </>}
                  <p>{plugin.hint}</p>
                  <div className="plate-agent-detail-save">
                    <button type="button" className="plate-agent-danger" disabled={busy}
                      onClick={() => setPendingUninstall(new Set([plugin.id]))}>卸载插件</button>
                  </div>
                </div>}
              </li>)}
            </ul>
            {(manageMode || hiddenCount > 0) && <div className="plate-agent-card-footer">
              {!manageMode && hiddenCount > 0 && <button type="button" className="plate-agent-more"
                onClick={() => setShowAll(value => !value)}>
                {showAll ? '收起其余插件' : `显示其余 ${hiddenCount} 个`} {showAll ? '▴' : '▾'}
              </button>}
              {manageMode && <>
                <span>{selectedRows.length ? `已选 ${selectedRows.length} 个插件` : '勾选插件以批量卸载'}</span>
                <button type="button" className="p13-action" disabled={busy}
                  onClick={() => void run(api => api.resetOrder(), '已重置排序。')}>重置排序</button>
                <button type="button" className="plate-agent-danger" disabled={busy || !selectedRows.length}
                  onClick={() => setPendingUninstall(new Set(selectedRows.map(item => item.id)))}>卸载所选</button>
              </>}
            </div>}
          </> : <p className="plate-agent-empty">尚未安装 Agent 插件。可从下方目录安装。</p>}
        </section>}

      {pendingRows.length > 0 && <div className="plate-agent-confirm" role="alertdialog" aria-label="确认卸载">
        <p>将卸载 {pendingRows.map(displayName).join('、')}。插件会回到「安装其他 Agent」，已有本机程序不会删除。</p>
        <div>
          <button type="button" className="p13-action" onClick={() => setPendingUninstall(new Set())}>取消</button>
          <button type="button" className="plate-agent-danger" disabled={busy}
            onClick={() => {
              const ids = [...pendingUninstall]
              setPendingUninstall(new Set())
              setSelected(new Set())
              void run(api => api.uninstall(ids), '插件已卸载。')
            }}>确认卸载</button>
        </div>
      </div>}

      <section className="plate-agent-catalog">
        <button type="button" className="plate-agent-section-toggle" aria-expanded={showAvailable}
          onClick={() => setShowAvailable(value => !value)}>安装其他 Agent ({available.length}) {showAvailable ? '▴' : '▾'}</button>
        {showAvailable && <ul>
          {available.length ? available.map(plugin => <li key={plugin.id} data-catalog-id={plugin.id}>
            <AgentPluginIcon id={plugin.icon || plugin.id} className="plate-plugin-icon"/>
            <div className="plate-agent-name">
              <strong>{displayName(plugin)}</strong>
              <span data-status={plugin.executable ? 'available' : 'off'} title={plugin.hint}>
                <i/>{statusLabel(plugin)}<em>{plugin.hint}</em>
              </span>
            </div>
            <button type="button" className="plate-agent-install" disabled={busy}
              onClick={() => void run(api => api.install(plugin.id), `已安装 ${displayName(plugin)}。`)}>安装插件</button>
          </li>) : <li className="plate-agent-empty">目录中没有可安装的 Agent。</li>}
        </ul>}
      </section>

      <button type="button" className="plate-agent-more-banner" onClick={() => setShowImport(value => !value)}>
        <span aria-hidden="true">◈</span>
        <strong>导入自定义 Agent 插件</strong>
        <small>支持 JSON Manifest · 命令通过 stdin 接收任务 · 导入后停用</small>
      </button>

      {showImport && <form className="plate-agent-import" onSubmit={event => {
        event.preventDefault()
        if (!busy) void importPlugin()
      }}>
        <label>JSON Manifest
          <textarea value={manifest} spellCheck={false}
            placeholder='{"id":"my-agent","name":"My Agent","executable":"C:\\tools\\my-agent.exe","args":["run"],"modelFlag":"--model","models":["standard"]}'
            onChange={event => setManifest(event.target.value)}/>
        </label>
        <p>必需字段：id、name、executable；可选：args、modelFlag、models。导入后插件默认停用，确认可执行文件安全后再开启。</p>
        <div><button type="button" className="p13-action" onClick={() => setShowImport(false)}>取消</button>
          <button type="submit" className="plate-agent-primary" disabled={busy || !manifest.trim()}>导入并停用</button></div>
      </form>}

    </div>
  </AgentDialog>
}

export function TaskAgentDialog({ onClose, select }: { onClose: () => void; select: (agent: string) => void }) {
  const agents = useDiscoveredAgents()
  return <AgentDialog title="交给哪个 Agent？" onClose={onClose}>
    {!agents ? <p role="status">正在读取已接入的 Agent…</p> :
      agents.length ? <ul className="plate-agent-choices">{agents.map(agent =>
        <li key={agent.id}><button className="p13-action" type="button" onClick={() => select(agent.id)}>
          {agent.name}{agent.model ? <small> · {agent.model}</small> : ''}
        </button></li>
      )}</ul> : <p>当前没有可用 Agent。请先在 Agent 设置中开启接入并完成配置。</p>}
    <footer><button className="p13-action" type="button" onClick={() => { onClose(); openAgentSettings() }}>Agent 设置</button></footer>
  </AgentDialog>
}
