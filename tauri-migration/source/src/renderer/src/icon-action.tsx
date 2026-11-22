import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from './components/icons'
import './styles/icon-actions.css'

type Props = Omit<ComponentPropsWithRef<'button'>, 'title'> & {
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
    aria-label={label} data-tip={tip}>
    <Icon size={size} strokeWidth={1.65} aria-hidden="true" focusable="false"/>
    {children}
    {badge !== undefined && badge > 0 && <span className="plate-icon-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
  </button>
}

export function ActionTooltips() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const bubble = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const target = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null
    const show = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') setAnchor(target(event.target))
    }
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && target(event.target) !== target(event.relatedTarget)) {
        setAnchor(target(event.relatedTarget))
      }
    }
    const focus = (event: FocusEvent) => {
      setAnchor(event.target instanceof HTMLElement && event.target.matches(':focus-visible') ? target(event.target) : null)
    }
    const dismiss = () => setAnchor(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    document.addEventListener('pointerover', show)
    document.addEventListener('pointerout', leave)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', dismiss)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerover', show)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', dismiss)
      document.removeEventListener('scroll', dismiss, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismiss)
    }
  }, [])

  useLayoutEffect(() => {
    const tip = bubble.current
    if (!anchor || !tip) return
    const { left, right, top, bottom, width, height } = anchor.getBoundingClientRect()
    const side = anchor.dataset.tipSide === 'right'
    const margin = 8
    const desiredX = side ? right + 12 : left + (width - tip.offsetWidth) / 2
    const above = top - tip.offsetHeight - margin
    const desiredY = side ? top + (height - tip.offsetHeight) / 2 : above >= margin ? above : bottom + margin
    tip.style.left = Math.max(margin, Math.min(desiredX, window.innerWidth - tip.offsetWidth - margin)) + 'px'
    tip.style.top = Math.max(margin, Math.min(desiredY, window.innerHeight - tip.offsetHeight - margin)) + 'px'
  }, [anchor])

  if (!anchor?.isConnected || !anchor.dataset.tip) return null
  return createPortal(<span className="plate-action-tooltip" ref={bubble} aria-hidden="true">
    {anchor.dataset.tip}
  </span>, anchor.closest('dialog[open]') ?? document.body)
}
