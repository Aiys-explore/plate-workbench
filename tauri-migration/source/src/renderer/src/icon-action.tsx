import type { ComponentPropsWithRef } from 'react'
import type { LucideIcon } from './components/icons'
import './styles/icon-actions.css'

type Props = ComponentPropsWithRef<'button'> & {
  icon: LucideIcon
  label: string
  shortcut?: string
  active?: boolean
  danger?: boolean
  badge?: number
  size?: 14 | 16 | 18
}

export function IconAction({ icon: Icon, label, shortcut, active, danger, badge,
  size = 16, children, className = '', type = 'button', ...props }: Props) {
  const tip = shortcut ? `${label}（${shortcut}）` : label
  return <button {...props} type={type}
    className={['plate-tool-icon', 'plate-icon-btn', active && 'is-active', danger && 'is-danger', className].filter(Boolean).join(' ')}
    aria-label={label} title={tip}>
    <Icon size={size} strokeWidth={1.65} aria-hidden="true" focusable="false"/>
    {children}
    {badge !== undefined && badge > 0 && <span className="plate-icon-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
  </button>
}
