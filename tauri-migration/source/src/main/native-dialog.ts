import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'

const pending = new WeakMap<BrowserWindow, number>()
let sequence = 0
export const nativeDialogStatus = (window: BrowserWindow) => ({ pending: !!pending.get(window), sequence })
function change(window: BrowserWindow, delta: number) {
  pending.set(window, (pending.get(window) ?? 0) + delta)
  sequence++
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(IPC.nativeDialogChanged, nativeDialogStatus(window))
  }
}
export async function withNativeDialog<T>(window: BrowserWindow, show: () => Promise<T>) {
  change(window, 1)
  try { return await show() } finally { change(window, -1) }
}
export function withNativeDialogSync<T>(window: BrowserWindow, show: () => T) {
  change(window, 1)
  try { return show() } finally { change(window, -1) }
}
