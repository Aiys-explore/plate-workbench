import { app, BrowserWindow, clipboard, dialog, session } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { withNativeDialogSync } from './native-dialog'
import { registerIpc } from './ipc'
import { NoteStore } from './notes'
import { AgentStore } from './agents'
import { SessionService } from './session-logs/service'
import { DelegationService } from './delegation'
import { DelegationLaunch } from './delegation-launch'
import { CollaborationService } from './collaboration'
import { BoardStore } from './board-store'
import { P10 } from './p10'
import { ExportService } from './export-service'
import { P11 } from './p11'
import { DeleteCoordinator, openDeleteStores } from './delete-coordinator'

import { FirstRun, StorageOpenError } from './first-run'

let mainWindow: BrowserWindow | null = null
let notes: NoteStore | undefined
let agents: AgentStore | undefined
let sessions: SessionService | undefined
let delegation: DelegationService | undefined
let launch: DelegationLaunch | undefined
let deletion:DeleteCoordinator|undefined
let exportsService:ExportService|undefined
let initialized = false
let shuttingDown = false

function createWindow(): void {
  const window = new BrowserWindow({
    title: app.getName(),
    width: 1200,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // Disable built-in spell checking for this window.
      spellcheck: false,
      backgroundThrottling: false,
      nodeIntegration: false
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => { window.maximize(); window.show() })
  window.on('closed', () => { mainWindow = null })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = withNativeDialogSync(window, () => dialog.showMessageBoxSync(window, {
      type: 'warning', message: '笔记可能有未保存的修改。',
      detail: '已写入本地的草稿会在下次启动时提供恢复；尚未写入的修改可能丢失。',
      buttons: ['继续编辑', '关闭'], defaultId: 0, cancelId: 0
    }))
    if (choice === 1) event.preventDefault()
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault()
      if (!input.isAutoRepeat) window.webContents.toggleDevTools()
    }
  })
  window.removeMenu()

  const devUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  const load = devUrl
    ? window.loadURL(devUrl)
    : window.loadFile(join(__dirname, '../renderer/index.html'))
  void load.catch((error: unknown) => {
    console.error('Failed to load the workbench:', error)
    app.exit(1)
  })
}

if (app.isPackaged) {
  // The local trial has its own profile and lock, even on a PC running the old workbench.
  const trialProfile = app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), app.getName())
  mkdirSync(trialProfile, { recursive: true })
  app.setPath('userData', trialProfile)
  if (process.platform === 'win32') app.setAppUserModelId(app.getName())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!initialized || shuttingDown) return
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', () => { if (!notes) shuttingDown = true })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', (event) => {
    if (!notes) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    launch?.close()
    agents?.close()
    try { delegation?.close() } catch (error) { console.error(error) }
    void Promise.all([notes.close(), sessions?.close()]).catch(console.error).finally(() => {
      deletion?.close()
      exportsService?.close()
      notes = undefined
      app.exit(0)
    })
  })
  void app.whenReady().then(() => {
    // Electron starts loading dictionaries when it creates the session.
    // Clear its language list synchronously before any window can use it.
    const workbenchSession = session.defaultSession
    workbenchSession.setSpellCheckerLanguages([])
    workbenchSession.setSpellCheckerEnabled(false)
    // Chromium creates this local profile; no notes are opened until the first window reads P13 state.
    const startup = new FirstRun(() => mainWindow, activate, () => shuttingDown)
    startup.register()
    initialized = true
    createWindow()
    app.on('activate', () => { if (!mainWindow && !shuttingDown) createWindow() })
  }).catch((error: unknown) => {
    console.error('无法打开启动界面：', error)
    app.exit(1)
  })
}

function activate(root: string, scope: string) {
  const enrollment = openDeleteStores(root, scope)
  let n: NoteStore | undefined, a: AgentStore | undefined, s: SessionService | undefined,
    d: DelegationService | undefined, l: DelegationLaunch | undefined,
    c: CollaborationService | undefined, dc: DeleteCoordinator | undefined, x: ExportService | undefined
  const close = async () => {
    const safely = async (fn: () => unknown) => {
      try { await fn() } catch (error) { console.error(error) }
    }
    await Promise.all([safely(() => l?.close()), safely(() => n?.close()), safely(() => s?.close())])
    await safely(() => a?.close())
    await safely(() => d?.close())
    await safely(() => c?.close())
    await safely(() => x?.close())
    if (dc) await safely(() => dc!.close())
    else {
      await safely(() => enrollment.db.close())
      await safely(() => enrollment.gate.close())
    }
  }
  try {
    const held = () => !!dc?.blocked()
    const localNotes = n = new NoteStore(root, (path, external) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed()) contents.send(IPC.changed, path, external)
    }, true, held, state => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed()) contents.send(IPC.noteIndexProgress, state)
    })
    const quietMs = Number(process.env.NOTES_WORKBENCH_NO_PROGRESS_MS)
    const localSessions = s = new SessionService(join(scope, 'sessions.sqlite'),
      Number.isSafeInteger(quietMs) && quietMs >= 1000 ? quietMs : undefined, held)
    const localAgents = a = new AgentStore(join(scope, 'agents.sqlite'), path => localSessions.zcodeEvidence(path))
    const localDelegation = d = new DelegationService(root, localNotes, localAgents, held)
    const localLaunch = l = new DelegationLaunch(localDelegation, localAgents, text => clipboard.writeText(text))
    const localBoard = new BoardStore(join(scope, 'boards'), localNotes)
    const localCollab = c = new CollaborationService(scope, localNotes, localBoard)
    const p10 = new P10(localDelegation.p10Database(), localNotes, localDelegation, localLaunch)
    const p11 = new P11(localDelegation.p10Database(), localNotes, localAgents, localSessions)
    const localDelete = dc = new DeleteCoordinator(enrollment, { index: localNotes.deleteDatabase(),
      delegation: localDelegation.p10Database(), agents: localAgents.deleteDatabase(), sessions: localSessions.deleteDatabase() }, (point,id) => {
      const hook = (process as unknown as Record<symbol,unknown>)[Symbol.for('workbench.m43.acceptance.cut')]
      if (typeof hook === 'function') hook(point,id)
    })
    p11.setDeleteCoordinator(localDelete)
    localDelete.startup()
    const exporter = x = new ExportService(localNotes, root, scope)
    return {
      close,
      agent: () => localAgents.logSources().some(source => source.enabled) ? 'unchecked' as const : 'unconfigured' as const,
      startLogs: async () => { if (!held()) await localSessions.configure(localAgents.logSources()) },
      publish: () => {
        registerIpc(() => mainWindow, exporter, localNotes, localAgents, localSessions,
          localDelegation, localLaunch, p10, p11, localDelete, localCollab, localBoard, () => shuttingDown)
        notes = localNotes
        agents = localAgents
        sessions = localSessions
        delegation = localDelegation
        launch = localLaunch
        deletion = localDelete
        exportsService = exporter
        localNotes.restartStartup(0)
      }
    }
  } catch (error) {
    throw new StorageOpenError(error, close())
  }
}
