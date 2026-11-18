import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { IPC, type NoteFilters, type NoteTemplate } from '../shared/ipc'
import { boardIPC, type BoardSaveInput } from '../shared/plate-board'
import { plateTerminalIPC, type PlateTerminalDeliverInput, type PlateTerminalSlotOpenInput, type TerminalPluginId } from '../shared/plate-terminal/contract'
import { createPlateTerminalHost } from './plate-terminal/host'
import type { DelegationApi } from '../shared/delegation'
import type { CollaborationService } from './collaboration'
import type { BoardStore } from './board-store'
import type { ExportService } from './export-service'
import type { Scope, P12Api } from '../shared/p12'
import type { NoteStore } from './notes'
import type { AgentStore } from './agents'
import type { DelegationService } from './delegation'
import type { DelegationLaunch } from './delegation-launch'
import type { P10 } from './p10'
import type { P11 } from './p11'
import type { DeleteCoordinator } from './delete-coordinator'
import type { Request, SessionRef, Subject } from '../shared/p11'
import type { SessionService } from './session-logs/service'
import { discover } from './agent-probe'
import { readBitmap } from './note-bitmap'
import { webAddress } from '../shared/media-address'
import { DelegationDiagnosticHost } from './delegation-diagnostic-host'
import { ResumeHost } from './resume-host'
import { resumeAvailability } from './resume-availability'
import { terminalAdapter } from './resume-terminal'
import { terminalResource } from './resume-terminal-native'
import { productionTerminalAuthority } from './resume-terminal-authority'
import { createDesktopAdapter } from './desktop-adapter'
import { defaultCodexLog } from './delegation-cli'
import { sessionAdapters, type SessionAdapter } from '../shared/sessions'
import { nativeDialogStatus, withNativeDialog } from './native-dialog'

export function registerIpc(getWindow: () => BrowserWindow | null, exporter:ExportService, notes: NoteStore, agents: AgentStore, sessions: SessionService,
  delegation: DelegationService, launch: DelegationLaunch, p10: P10, p11: P11, deletion:DeleteCoordinator,
  collaboration: CollaborationService, boards: BoardStore, quitting:()=>boolean): void {
  const sender = (event:IpcMainInvokeEvent) => {
    const contents = getWindow()?.webContents
    return !quitting() && contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
      ? contents : null
  }
  ipcMain.handle(IPC.nativeDialogStatus, event => {
    const window = getWindow()
    if (!window || !sender(event)) throw new Error('Unrecognized IPC sender')
    return nativeDialogStatus(window)
  })
  const needsIndex = new Set<string>([IPC.p12, IPC.p10List, IPC.p10Act,
    IPC.delegationContext, IPC.delegationAddAnchor, IPC.delegationSubmit, IPC.delegationStart, IPC.delegationReview,
    IPC.delegationReconcile, IPC.delegationDiscardReservation, IPC.delegationLinkHandoff,
    IPC.create, IPC.createProject, IPC.read, IPC.update, IPC.delete, IPC.list, IPC.search, IPC.tags, IPC.links, IPC.bitmap,
    IPC.draftList, IPC.draftWrite, IPC.draftDiscard, IPC.draftRestore, IPC.draftSaveCopy])
  function handle<Args extends unknown[]>(channel: string, fn: (...args: Args) => unknown) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: Args) => {
      if (!sender(event)) {
        throw new Error('Unrecognized IPC sender')
      }
      if(channel!==IPC.noteIndex)deletion.assertOpen()
      if(needsIndex.has(channel))notes.assertIndexReady()
      return fn(...args)
    })
  }
  const inside = (root:string, path:string) => {
    if (!root) return false
    const r = relative(root,path)
    return !isAbsolute(r) && r!=='..' && !r.startsWith('..\\') && !r.startsWith('../')
  }
  const same = (a:string,b:string) => process.platform==='win32'
    ? normalize(a).toLowerCase()===normalize(b).toLowerCase() : normalize(a)===normalize(b)
  const terminal=terminalAdapter(terminalResource({
    packaged:app.isPackaged, executable:process.execPath, resources:process.resourcesPath, asar:app.getAppPath()
  }),productionTerminalAuthority)
  const resume = new ResumeHost(origin=>{
    if(deletion.blocked())return null
    if (origin.kind==='log') {
      const r=sessions.resumeRecord(origin.adapter,origin.id)
      if (!r) return null
      const matches=agents.delegationProfiles().filter(p=>p.enabled && p.type===origin.adapter)
        .map(p=>agents.delegationProfile(p.id)).filter(p=>p && (inside(p.logPath,r.source) ||
          origin.adapter==='codex' && same(p.logPath,defaultCodexLog()) &&
          inside(join(dirname(p.logPath),'archived_sessions'),r.source) ||
          origin.adapter==='zcode' && basename(p.logPath).toLowerCase()==='db.sqlite' &&
          basename(dirname(p.logPath)).toLowerCase()==='db' && inside(join(dirname(dirname(p.logPath)),'log'),r.source)))
      if (!matches.length) return null
      const profile=matches.length===1 ? matches[0] : undefined
      return {agent:origin.adapter,id:origin.id,cwd:r.cwd,revision:r.revision,profile:profile?.id,
        configured:profile?.executable,fingerprint:JSON.stringify([r.source,r.fingerprint,matches.map(p=>[p?.id,p?.revision,p?.logPath]).sort()]),
        source:profile && {logRoot:profile.logPath,path:r.source,identity:r.fingerprint,revision:r.revision,profileRevision:profile.revision},
        localEvidenceEligible:!!profile && !r.subagent}
    }
    const r=p10.resumeRecord(origin,agents)
    if (!r) return null
    const read = sessionAdapters.includes(r.agent as SessionAdapter) ? sessions.resumeRecord(r.agent as SessionAdapter,r.id) : null
    const conversation = read && (inside(r.profile.logPath,read.source) ||
      r.agent==='codex' && same(r.profile.logPath,defaultCodexLog()) && inside(join(dirname(r.profile.logPath),'archived_sessions'),read.source)) &&
      r.cwd && read.cwd && same(r.cwd,read.cwd)
      ? {kind:'log' as const,adapter:r.agent as SessionAdapter,id:r.id,revision:read.revision} : undefined
    return {agent:r.agent,id:r.id,cwd:r.cwd,revision:r.revision,profile:r.profile.id,
      configured:r.profile.executable,fingerprint:r.revision,conversation,localEvidenceEligible:!r.legacyHandoff,
      source:conversation && read && !read.subagent ? {logRoot:r.profile.logPath,path:read.source,identity:read.fingerprint,
        revision:read.revision,profileRevision:r.profile.revision} : undefined}
  },clipboard,resumeAvailability,createDesktopAdapter(()=>null,app.isPackaged),terminal)
  const handleResume = (channel:string, fn:(event:IpcMainInvokeEvent, owner:number, ...args:unknown[])=>unknown) => {
    ipcMain.handle(channel,(event,...args:unknown[])=>{
      const contents=sender(event)
      if (!contents) throw new Error('Unrecognized IPC sender')
      if(channel!==IPC.p11 || !['receipt','confirm','pending'].includes(String(args[0])))deletion.assertOpen()
      return fn(event,contents.id,...args)
    })
  }
  const diagnostics = new DelegationDiagnosticHost(clipboard)
  const observedWindows = new WeakSet<BrowserWindow>()
  handleResume(IPC.diagnosticOpen,(event,owner,request,...extra)=>{
    const window = getWindow()
    if (!window || !window.isFocused() || extra.length) return null
    if (!observedWindows.has(window)) {
      observedWindows.add(window)
      window.on('blur', () => diagnostics.invalidate(owner))
      window.on('closed', () => diagnostics.invalidate(owner))
      event.sender.on('render-process-gone', () => diagnostics.invalidate(owner))
      event.sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) diagnostics.invalidate(owner)
      })
    }
    return diagnostics.open(owner, () => {
      if (!sender(event) || getWindow() !== window || !request || typeof request !== 'object') return null
      if ('kind' in request && request.kind === 'p09' && 'source' in request && 'runId' in request &&
          typeof request.runId === 'string' && Object.keys(request).length === 3) {
        const checked = delegation.inspectAnchor(request.source)
        if ('code' in checked) return null
        return p10.diagnostic({ noteId: checked.noteId, blockId: checked.blockId, runId: request.runId })
      }
      if ('kind' in request && request.kind === 'p10' && 'key' in request && Object.keys(request).length === 2) {
        const key = request.key
        if (key && typeof key === 'object' && Object.keys(key).length === 3 &&
            'noteId' in key && typeof key.noteId === 'string' && 'blockId' in key && typeof key.blockId === 'string' &&
            'runId' in key && typeof key.runId === 'string') return p10.diagnostic({ noteId:key.noteId, blockId:key.blockId, runId:key.runId })
      }
      return null
    })
  })
  handleResume(IPC.diagnosticCopy,(_event,owner,ticket,...extra)=>
    extra.length ? 'stale' : diagnostics.copy(owner,ticket,()=>!!sender(_event) && getWindow()?.isFocused() === true))
  handleResume(IPC.diagnosticClose,(_event,owner,ticket)=>diagnostics.close(owner,ticket))
  let choosingExport=false
  handle(IPC.p12,async(method:unknown, value?:unknown)=>{
    switch(method) {
      case 'scope':return exporter.scope(value as Scope)
      case 'preview':if(!choosingExport)return exporter.preview(value as Parameters<P12Api['preview']>[0]);break
      case 'confirm':if(!choosingExport&&typeof value==='string')return exporter.confirm(value);break
      case 'receipt':if(value===undefined||typeof value==='string')return exporter.receipt(value);break
      case 'stop':if(typeof value==='string')return exporter.stop(value);break
      case 'release':if(typeof value==='string')return exporter.release(value);break
      case 'choose': {
        const window=getWindow()
        if(choosingExport||!window)break
        choosingExport=true
        try {
          const answer=await withNativeDialog(window, () => dialog.showOpenDialog(window,{title:'选择 Markdown 导出目录',properties:['openDirectory']}))
          if(answer.canceled||!answer.filePaths[0])return null
          if(window.isDestroyed()||quitting())throw new Error('导出窗口已关闭')
          return exporter.choose(answer.filePaths[0])
        } finally {choosingExport=false}
      }
    }
    throw new Error('导出操作无效或仍在选择目录')
  })
  handleResume(IPC.p11,async (event,owner,method,a,b)=>{
    if (['project','ownership','places','tasks','impact','preview'].includes(String(method))) notes.assertIndexReady()
    const key=owner+':'+event.senderFrame?.processId+':'+event.senderFrame?.routingId
    switch(method){
      case 'project':return p11.project(a as string)
      case 'browse': {
        const window=getWindow()
        if(!window)return null
        const r=await withNativeDialog(window, () => dialog.showOpenDialog(window,{properties:['openDirectory']}))
        return r.canceled?null:r.filePaths[0]??null
      }
      case 'ownership':return p11.ownership(a as SessionRef)
      case 'places':return p11.places()
      case 'tasks':return p11.tasks(a as string|undefined)
      case 'impact':return p11.impact(a as Subject)
      case 'preview':return p11.preview(key,a as Request)
      case 'confirm':return p11.confirm(key,a as string,b as string)
      case 'cancel':return p11.cancel(key,a as string)
      case 'receipt':return p11.receipt(a as string)
      case 'pending':return deletion.blocked()??null
      default:throw new Error('未知操作')
    }
  })
  handleResume(IPC.resumeReview,(_event,owner,origin)=>resume.review(owner,origin))
  handleResume(IPC.resumeAct,(event,owner,ticket,action)=>resume.act(owner,ticket,action,()=>!deletion.blocked() && !!sender(event) && getWindow()?.isFocused()===true))
  handleResume(IPC.resumeClose,(_event,owner,ticket)=>resume.close(owner,ticket))
  handle(IPC.noteIndex, (method:unknown, run?:unknown) => {
    if (method === 'status' && run === undefined) return notes.indexStatus()
    if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 0) throw new Error('索引请求编号无效')
    if (method === 'cancel') return notes.cancelStartup(run)
    if (method === 'retry') return notes.restartStartup(run)
    throw new Error('索引操作无效')
  })
  handle(IPC.agentList, () => agents.list())
  const delegationContext: DelegationApi['context'] = async (id) => ({
    home: app.getPath('home'), noteDirectory: notes.directory(id), platform: process.platform
  })
  handle(IPC.p10List, noteId=>p10.list(noteId,agents))
  handle(IPC.p10Act, p10.act.bind(p10))
  handle(IPC.delegationContext, delegationContext)
  handle(IPC.delegationAddAnchor, delegation.addAnchor.bind(delegation))
  handle(IPC.delegationSubmit, delegation.submit.bind(delegation))
  handle(IPC.delegationStart, launch.start.bind(launch))
  handle(IPC.delegationReview, launch.review.bind(launch))
  handle(IPC.delegationReconcile, launch.reconcile.bind(launch))
  handle(IPC.delegationDiscardReservation, launch.discardReservation.bind(launch))
  handle(IPC.delegationStatus, launch.status.bind(launch))
  handle(IPC.delegationCancel, launch.cancel.bind(launch))
  handle(IPC.delegationCopyHandoff, launch.copyHandoff.bind(launch))
  handle(IPC.delegationFindHandoff, launch.findHandoff.bind(launch))
  handle(IPC.delegationLinkHandoff, launch.linkHandoff.bind(launch))
  handle(IPC.collabOverview, () => collaboration.core.overview())
  handle(IPC.collabCreateTask, collaboration.core.createTask)
  handle(IPC.collabAddSlot, collaboration.core.addSlot)
  handle(IPC.collabRenameRole, collaboration.core.renameRole)
  handle(IPC.collabPrepareReview, collaboration.core.prepareReview)
  handle(IPC.collabPrepareHandoff, collaboration.core.prepareHandoff)
  handle(IPC.collabConfirmRequest, collaboration.core.confirmRequest)
  handle(IPC.collabCancelRequest, collaboration.core.cancelRequest)
  handle(IPC.collabCopyRequestText, collaboration.core.requestPayload)
  handle(IPC.boardOpen, boards.open.bind(boards))
  handle(IPC.boardSave, boards.save.bind(boards))
  // 页面卸载期间的同步保存：无法走异步 handle 包装，同样校验发送方与删除锁。
  ipcMain.on(boardIPC.saveSync, (event, input: BoardSaveInput) => {
    try {
      if (!sender(event)) throw new Error('Unrecognized IPC sender')
      deletion.assertOpen()
      event.returnValue = boards.save(input)
    } catch (error) {
      event.returnValue = { error: error instanceof Error ? error.message : 'invalid-input' }
    }
  })
  let configQueue = Promise.resolve()
  const syncSources = () => {
    const next = configQueue.then(() => sessions.configure(agents.logSources()))
    configQueue = next.catch(() => undefined)
    return next
  }
  handle(IPC.agentSave, async (...args: Parameters<AgentStore['save']>) => {
    const profile = await agents.save(...args)
    await syncSources().catch(error=>{
      throw new Error('档案已写入（'+profile.id+'），但日志来源未同步；请读取档案核对。'+String(error))
    })
    return profile
  })
  handle(IPC.agentRemove, async (id: string) => {
    agents.remove(id)
    await syncSources().catch(error=>{
      throw new Error('档案已删除（'+id+'），但日志来源未同步；请读取档案核对。'+String(error))
    })
  })
  handle(IPC.sessionList, () => sessions.list())
  handle(IPC.sessionDashboard, () => sessions.dashboard())
  handle(IPC.sessionUsage, sessions.usage.bind(sessions))
  handle(IPC.sessionManualLimit, sessions.manualLimit.bind(sessions))
  handle(IPC.sessionMessages, sessions.messages.bind(sessions))
  handle(IPC.sessionMessagePage, sessions.messagePage.bind(sessions))
  handle(IPC.agentSetEnabled, async (id: string, enabled: boolean) => {
    const profile = await agents.setEnabled(id, enabled)
    await syncSources().catch(error => { throw new Error('档案已写入（'+id+'），但日志来源未同步；请读取档案核对。'+String(error)) })
    return profile
  })
  const discoveries = new Map<string, AbortController>()
  handle(IPC.agentDiscover, async (type: string, requestId?: string) => {
    if (typeof type !== 'string') throw new Error('档案类型无效')
    if (requestId === undefined) return discover(type)
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || discoveries.has(requestId) || discoveries.size >= 4) {
      throw new Error('查找请求无效或正在运行')
    }
    const cancel = new AbortController()
    discoveries.set(requestId, cancel)
    try { return await discover(type, cancel.signal) }
    finally { discoveries.delete(requestId) }
  })
  handle(IPC.agentCancelDiscover, (requestId: string) => { discoveries.get(requestId)?.abort() })
  handle(IPC.agentProbe, agents.probe.bind(agents))
  handle(IPC.create, (title: string, projectId: string, template?: NoteTemplate) => notes.create(title, projectId, template))
  handle(IPC.projects, () => notes.projects())
  handle(IPC.createProject, (name: string) => notes.createProject(name))
  handle(IPC.read, (id: string) => notes.read(id))
  handle(IPC.update, notes.update.bind(notes))
  handle(IPC.delete, () => { throw new Error('请通过移除影响预览确认') })
  handle(IPC.list, (filters?: NoteFilters) => notes.list(filters))
  handle(IPC.search, (filters: NoteFilters) => notes.search(filters))
  handle(IPC.tags, () => notes.tags())
  handle(IPC.draftList, () => notes.draftList())
  handle(IPC.draftWrite, notes.draftWrite.bind(notes))
  handle(IPC.draftDiscard, notes.draftDiscard.bind(notes))
  handle(IPC.draftRestore, (id: string) => notes.draftRestore(id))
  handle(IPC.draftSaveCopy, notes.draftSaveCopy.bind(notes))
  handle(IPC.bitmap, (noteId: string, address: string) => readBitmap(notes.bitmapDirectory(noteId), address))
  handle(IPC.openLink, (address: string) => shell.openExternal(webAddress(address)))
  handle(IPC.links, () => notes.links(p11.removedRefs()))
  const plateTerminal = createPlateTerminalHost({ getWindow, userDataDir: () => app.getPath('userData') })
  handle(plateTerminalIPC.discover, () => plateTerminal.discover())
  handle(plateTerminalIPC.catalog, (repository: string) => plateTerminal.catalog(repository))
  handle(plateTerminalIPC.install, (id: TerminalPluginId, repository?: string) => plateTerminal.install(id, repository))
  handle(plateTerminalIPC.remove, (id: TerminalPluginId) => plateTerminal.remove(id))
  handle(plateTerminalIPC.desktop, () => plateTerminal.desktop())
  handle(plateTerminalIPC.copyDesktopTask, (text: string) => plateTerminal.copyDesktopTask(text))
  handle(plateTerminalIPC.open, (input: PlateTerminalSlotOpenInput) => plateTerminal.open(input))
  handle(plateTerminalIPC.write, (slotId: number, data: string) => plateTerminal.write(slotId, data))
  handle(plateTerminalIPC.resize, (slotId: number, cols: number, rows: number) => plateTerminal.resize(slotId, cols, rows))
  handle(plateTerminalIPC.sigint, (slotId: number) => plateTerminal.sigint(slotId))
  handle(plateTerminalIPC.terminate, (slotId: number) => plateTerminal.terminate(slotId))
  handle(plateTerminalIPC.close, (slotId: number) => plateTerminal.close(slotId))
  handle(plateTerminalIPC.deliver, (input: PlateTerminalDeliverInput) => plateTerminal.deliver(input))
  handle(plateTerminalIPC.attempts, () => plateTerminal.attempts())
}
