import { create } from 'zustand'

type Theme = 'light' | 'dark'
const themeKey = 'workbench.theme'
const sidebarWidthKey = 'plate.sidebar.width'
export const SIDEBAR_WIDTH_MIN = 224
export const SIDEBAR_WIDTH_MAX = 256
export const SIDEBAR_WIDTH_DEFAULT = 244
function initialTheme(): Theme {
  try { if (localStorage.getItem(themeKey) === 'dark') return 'dark' } catch { /* storage may be unavailable */ }
  return 'light'
}
function initialSidebarWidth(): number {
  try {
    const value = Number(localStorage.getItem(sidebarWidthKey))
    if (Number.isFinite(value) && value >= SIDEBAR_WIDTH_MIN && value <= SIDEBAR_WIDTH_MAX) return value
  } catch { /* storage may be unavailable */ }
  return SIDEBAR_WIDTH_DEFAULT
}
interface WorkbenchState {
  theme: Theme
  sidebarCollapsed: boolean
  sidebarWidth: number
  editorCollapsed: boolean
  agentCollapsed: boolean
  toggleTheme(): void
  toggleSidebar(): void
  setSidebarWidth(value: number): void
  toggleEditor(): void
  expandEditor(): void
  toggleAgent(): void
  expandAgent(): void
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  theme: initialTheme(),
  sidebarCollapsed: (() => {
    try { return localStorage.getItem('plate.sidebar.collapsed') === 'true' } catch { return false }
  })(),
  sidebarWidth: initialSidebarWidth(),
  editorCollapsed: false,
  agentCollapsed: false,
  toggleTheme: () => set(({ theme }) => {
    const next = theme === 'light' ? 'dark' : 'light'
    try { localStorage.setItem(themeKey,next) } catch { /* keep the in-memory choice */ }
    return { theme:next }
  }),
  toggleSidebar: () => set(({ sidebarCollapsed }) => {
    try { localStorage.setItem('plate.sidebar.collapsed', String(!sidebarCollapsed)) } catch { /* retain in memory */ }
    return { sidebarCollapsed: !sidebarCollapsed }
  }),
  setSidebarWidth: (value) => set(() => {
    const width = Math.min(Math.max(Math.round(value), SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX)
    try { localStorage.setItem(sidebarWidthKey, String(width)) } catch { /* retain in memory */ }
    return { sidebarWidth: width }
  }),
  toggleEditor: () => set(({ editorCollapsed }) => ({ editorCollapsed: !editorCollapsed })),
  expandEditor: () => set({ editorCollapsed: false }),
  toggleAgent: () => set(({ agentCollapsed }) => ({ agentCollapsed: !agentCollapsed })),
  expandAgent: () => set({ agentCollapsed: false })
}))
