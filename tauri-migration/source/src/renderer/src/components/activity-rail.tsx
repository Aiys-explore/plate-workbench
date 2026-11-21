import type { ActiveView } from '../../../shared/harness'
import { useWorkbench } from '../store'

const items: ReadonlyArray<{ id: ActiveView; label: string }> = [
  { id: 'workbench', label: '工作台' },
  { id: 'brain', label: '大脑' },
  { id: 'library', label: '资料与记录' },
  { id: 'skills', label: '技能' },
  { id: 'settings', label: '模型与权限' },
]

export function ActivityRail() {
  const active = useWorkbench(state => state.activeView)
  const pending = useWorkbench(state => state.pendingDiffCount)
  const navigate = useWorkbench(state => state.setActiveView)
  return <nav className="s10-activity-rail" aria-label="主导航">
    {items.map(({ id, label }) => <button key={id} type="button" aria-current={active === id ? 'page' : undefined}
      aria-label={id === 'brain' ? '大脑视图' : undefined}
      onClick={() => navigate(id)}>{label}{id === 'workbench' && pending > 0 && <small> · {pending} 待审阅</small>}</button>)}
  </nav>
}
