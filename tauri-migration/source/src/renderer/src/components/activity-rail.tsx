import { useEffect } from 'react'
import type { ActiveView } from '../../../shared/harness'
import { IconAction } from '../icon-action'
import { useWorkbench } from '../store'
import { IconBrain, IconLibrary, IconSettings, IconSkills, IconWorkbench, type LucideIcon } from './icons'

export const viewLabels: Record<ActiveView, string> = {
  workbench: '工作台', brain: '大脑视图', library: '资料与记录', skills: '技能', settings: '模型与权限',
}
const items: ReadonlyArray<{ id: ActiveView; icon: LucideIcon; key: string }> = [
  { id: 'workbench', icon: IconWorkbench, key: '1' },
  { id: 'brain', icon: IconBrain, key: '2' },
  { id: 'library', icon: IconLibrary, key: '3' },
  { id: 'skills', icon: IconSkills, key: '4' },
  { id: 'settings', icon: IconSettings, key: ',' },
]

export function ActivityRail() {
  const active = useWorkbench(state => state.activeView)
  const navigate = useWorkbench(state => state.setActiveView)
  const pending = useWorkbench(state => state.pendingDiffCount)
  useEffect(() => {
    const navigateShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.isComposing
        || document.querySelector('dialog[open]')) return
      const item = items.find(item => item.key === event.key)
      if (!item) return
      event.preventDefault()
      navigate(item.id)
    }
    window.addEventListener('keydown', navigateShortcut)
    return () => window.removeEventListener('keydown', navigateShortcut)
  }, [navigate])
  return <nav className="s10-activity-rail" aria-label="主导航">
    {items.map(({ id, icon, key }) => <IconAction key={id} icon={icon} label={viewLabels[id]} size={18}
      className={id === 'settings' ? 's10-rail-settings' : undefined}
      shortcut={'Ctrl+' + key} active={active === id} data-tip-side="right" aria-current={active === id ? 'page' : undefined}
      badge={id === 'workbench' ? pending : undefined} onClick={() => navigate(id)}/>)}
  </nav>
}
