import { STARTUP } from '../shared/startup'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type NativeDialogState, type WorkbenchApi } from '../shared/ipc'
import type { NoteIndexState } from '../shared/note-index'
import { collaborationIPC } from '../shared/collaboration'
import { boardIPC } from '../shared/plate-board'
import { plateTerminalIPC, type PlateTerminalDataEvent, type PlateTerminalExitEvent } from '../shared/plate-terminal/contract'

const api: WorkbenchApi = {
  startup: {
    state: () => ipcRenderer.invoke(STARTUP, 'state'),
    suggest: () => ipcRenderer.invoke(STARTUP, 'suggest'),
    browse: () => ipcRenderer.invoke(STARTUP, 'browse'),
    submit: token => ipcRenderer.invoke(STARTUP, 'submit', token),
    rebuild: token => ipcRenderer.invoke(STARTUP, 'rebuild', token),
    retry: () => ipcRenderer.invoke(STARTUP, 'retry'),
    continue: () => ipcRenderer.invoke(STARTUP, 'continue'),
    exit: () => ipcRenderer.invoke(STARTUP, 'exit')
  },
  p12: {
    scope:scope=>ipcRenderer.invoke(IPC.p12,'scope',scope),
    choose:()=>ipcRenderer.invoke(IPC.p12,'choose'),
    preview:request=>ipcRenderer.invoke(IPC.p12,'preview',request),
    confirm:id=>ipcRenderer.invoke(IPC.p12,'confirm',id),
    receipt:id=>ipcRenderer.invoke(IPC.p12,'receipt',id),
    stop:id=>ipcRenderer.invoke(IPC.p12,'stop',id),
    release:id=>ipcRenderer.invoke(IPC.p12,'release',id)
  },
  p11: {
    project:id=>ipcRenderer.invoke(IPC.p11,'project',id),
    browse:()=>ipcRenderer.invoke(IPC.p11,'browse'),
    ownership:session=>ipcRenderer.invoke(IPC.p11,'ownership',session),
    places:()=>ipcRenderer.invoke(IPC.p11,'places'),
    tasks:noteId=>ipcRenderer.invoke(IPC.p11,'tasks',noteId),
    preview:request=>ipcRenderer.invoke(IPC.p11,'preview',request),
    impact:subject=>ipcRenderer.invoke(IPC.p11,'impact',subject),
    confirm:(token,id)=>ipcRenderer.invoke(IPC.p11,'confirm',token,id),
    cancel:token=>ipcRenderer.invoke(IPC.p11,'cancel',token),
    receipt:id=>ipcRenderer.invoke(IPC.p11,'receipt',id),
    pending:()=>ipcRenderer.invoke(IPC.p11,'pending')
  },
  p10: {
    list: noteId => ipcRenderer.invoke(IPC.p10List, noteId),
    act: (...args) => ipcRenderer.invoke(IPC.p10Act, ...args)
  },
  resume: {
    review: origin => ipcRenderer.invoke(IPC.resumeReview,origin),
    act: (ticket,action) => ipcRenderer.invoke(IPC.resumeAct,ticket,action),
    close: ticket => ipcRenderer.invoke(IPC.resumeClose,ticket)
  },
  delegationDiagnostic: {
    open: (target) => ipcRenderer.invoke(IPC.diagnosticOpen, target),
    copy: (ticket) => ipcRenderer.invoke(IPC.diagnosticCopy, ticket),
    close: (ticket) => ipcRenderer.invoke(IPC.diagnosticClose, ticket)
  },
  delegation: {
    context: (noteId) => ipcRenderer.invoke(IPC.delegationContext, noteId),
    addAnchor: (source) => ipcRenderer.invoke(IPC.delegationAddAnchor, source),
    submit: (request) => ipcRenderer.invoke(IPC.delegationSubmit, request),
    start: (request, revision, mode, expected) => ipcRenderer.invoke(IPC.delegationStart, request, revision, mode, expected),
    review: (source) => ipcRenderer.invoke(IPC.delegationReview, source),
    reconcile: (source, runId) => ipcRenderer.invoke(IPC.delegationReconcile, source, runId),
    discardReservation: (source, runId) => ipcRenderer.invoke(IPC.delegationDiscardReservation, source, runId),
    status: (runId) => ipcRenderer.invoke(IPC.delegationStatus, runId),
    cancel: (runId) => ipcRenderer.invoke(IPC.delegationCancel, runId),
    copyHandoff: (runId) => ipcRenderer.invoke(IPC.delegationCopyHandoff, runId),
    findHandoff: (runId) => ipcRenderer.invoke(IPC.delegationFindHandoff, runId),
    linkHandoff: (runId, token) => ipcRenderer.invoke(IPC.delegationLinkHandoff, runId, token)
  },
  collaboration: {
    overview: () => ipcRenderer.invoke(collaborationIPC.overview),
    createTask: (title) => ipcRenderer.invoke(collaborationIPC.createTask, title),
    addSlot: (missionId, input) => ipcRenderer.invoke(collaborationIPC.addSlot, missionId, input),
    renameRole: (missionId, slotId, displayName, expectedDisplayVersion) =>
      ipcRenderer.invoke(collaborationIPC.renameRole, missionId, slotId, displayName, expectedDisplayVersion),
    prepareReview: (input) => ipcRenderer.invoke(collaborationIPC.prepareReview, input),
    prepareHandoff: (input) => ipcRenderer.invoke(collaborationIPC.prepareHandoff, input),
    confirmRequest: (requestId, channel) => ipcRenderer.invoke(collaborationIPC.confirmRequest, requestId, channel),
    cancelRequest: (requestId) => ipcRenderer.invoke(collaborationIPC.cancelRequest, requestId),
    copyRequestText: (requestId) => ipcRenderer.invoke(collaborationIPC.copyRequestText, requestId)
  },
  board: {
    open: noteId => ipcRenderer.invoke(boardIPC.open, noteId),
    save: input => ipcRenderer.invoke(boardIPC.save, input),
    saveSync: input => ipcRenderer.sendSync(boardIPC.saveSync, input)
  },
  plateTerminal: {
    discover: () => ipcRenderer.invoke(plateTerminalIPC.discover),
    catalog: repository => ipcRenderer.invoke(plateTerminalIPC.catalog, repository),
    install: (id, repository) => ipcRenderer.invoke(plateTerminalIPC.install, id, repository),
    remove: id => ipcRenderer.invoke(plateTerminalIPC.remove, id),
    desktop: () => ipcRenderer.invoke(plateTerminalIPC.desktop),
    copyDesktopTask: text => ipcRenderer.invoke(plateTerminalIPC.copyDesktopTask, text),
    open: input => ipcRenderer.invoke(plateTerminalIPC.open, input),
    write: (slotId, data) => ipcRenderer.invoke(plateTerminalIPC.write, slotId, data),
    resize: (slotId, cols, rows) => ipcRenderer.invoke(plateTerminalIPC.resize, slotId, cols, rows),
    sigint: slotId => ipcRenderer.invoke(plateTerminalIPC.sigint, slotId),
    terminate: slotId => ipcRenderer.invoke(plateTerminalIPC.terminate, slotId),
    close: slotId => ipcRenderer.invoke(plateTerminalIPC.close, slotId),
    deliver: input => ipcRenderer.invoke(plateTerminalIPC.deliver, input),
    attempts: () => ipcRenderer.invoke(plateTerminalIPC.attempts),
    onData: listener => {
      const relay = (_event: Electron.IpcRendererEvent, payload: PlateTerminalDataEvent) => listener(payload)
      ipcRenderer.on(plateTerminalIPC.data, relay)
      return () => { ipcRenderer.removeListener(plateTerminalIPC.data, relay) }
    },
    onExit: listener => {
      const relay = (_event: Electron.IpcRendererEvent, payload: PlateTerminalExitEvent) => listener(payload)
      ipcRenderer.on(plateTerminalIPC.exit, relay)
      return () => { ipcRenderer.removeListener(plateTerminalIPC.exit, relay) }
    }
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionList),
    dashboard: () => ipcRenderer.invoke(IPC.sessionDashboard),
    usage: (days, dimension, filter) => ipcRenderer.invoke(IPC.sessionUsage,days,dimension,filter),
    manualLimit: (limit) => ipcRenderer.invoke(IPC.sessionManualLimit,limit),
    messages: (adapter, id, before, limit) => ipcRenderer.invoke(IPC.sessionMessages,adapter,id,before,limit),
    messagePage: (adapter, id, cursor) => ipcRenderer.invoke(IPC.sessionMessagePage,adapter,id,cursor)
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentList),
    save: (id, input, creationId) => ipcRenderer.invoke(IPC.agentSave, id, input, creationId),
    remove: (id) => ipcRenderer.invoke(IPC.agentRemove, id),
    discover: (type, requestId) => ipcRenderer.invoke(IPC.agentDiscover, type, requestId),
    cancelDiscover: requestId => ipcRenderer.invoke(IPC.agentCancelDiscover, requestId),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IPC.agentSetEnabled, id, enabled),
    probe: (id, force) => ipcRenderer.invoke(IPC.agentProbe, id, force)
  },
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  nativeDialog: {
    status: () => ipcRenderer.invoke(IPC.nativeDialogStatus),
    onChange: listener => {
      const relay = (_event: Electron.IpcRendererEvent, state: NativeDialogState) => listener(state)
      ipcRenderer.on(IPC.nativeDialogChanged, relay)
      return () => { ipcRenderer.removeListener(IPC.nativeDialogChanged, relay) }
    }
  },
  notes: {
    index: {
      status:()=>ipcRenderer.invoke(IPC.noteIndex,'status'),
      cancel:run=>ipcRenderer.invoke(IPC.noteIndex,'cancel',run),
      retry:run=>ipcRenderer.invoke(IPC.noteIndex,'retry',run),
      onProgress:listener=>{
        const relay=(_event:Electron.IpcRendererEvent,state:NoteIndexState)=>listener(state)
        ipcRenderer.on(IPC.noteIndexProgress,relay)
        return ()=>{ipcRenderer.removeListener(IPC.noteIndexProgress,relay)}
      }
    },
    create: (title, projectId, template) => ipcRenderer.invoke(IPC.create, title, projectId, template),
    projects: () => ipcRenderer.invoke(IPC.projects),
    createProject: (name) => ipcRenderer.invoke(IPC.createProject, name),
    read: (id) => ipcRenderer.invoke(IPC.read, id),
    update: (id, content, revision, draftVersion) => ipcRenderer.invoke(IPC.update, id, content, revision, draftVersion),
    delete: (id, revision) => ipcRenderer.invoke(IPC.delete, id, revision),
    list: (filters) => ipcRenderer.invoke(IPC.list, filters),
    search: (filters) => ipcRenderer.invoke(IPC.search, filters),
    tags: () => ipcRenderer.invoke(IPC.tags),
    draftList: () => ipcRenderer.invoke(IPC.draftList),
    draftWrite: (id, content, revision, version) => ipcRenderer.invoke(IPC.draftWrite, id, content, revision, version),
    draftDiscard: (id, version) => ipcRenderer.invoke(IPC.draftDiscard, id, version),
    draftRestore: (id) => ipcRenderer.invoke(IPC.draftRestore, id),
    draftSaveCopy: (id, version, expected) => ipcRenderer.invoke(IPC.draftSaveCopy, id, version, expected),
    bitmap: (id, address) => ipcRenderer.invoke(IPC.bitmap, id, address),
    openLink: (address) => ipcRenderer.invoke(IPC.openLink, address),
    links: () => ipcRenderer.invoke(IPC.links),
    onChanged: (listener) => {
      const relay = (_event: Electron.IpcRendererEvent, path: string, external: boolean) => listener(path, external)
      ipcRenderer.on(IPC.changed, relay)
      return () => { ipcRenderer.removeListener(IPC.changed, relay) }
    }
  }
}
contextBridge.exposeInMainWorld('workbench', api)
