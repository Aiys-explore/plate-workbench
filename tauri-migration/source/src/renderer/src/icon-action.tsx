import type { ComponentPropsWithRef } from 'react'
import './styles/icon-actions.css'

const icons={
  plus:'M12 5v14M5 12h14', tag:'M3 4h8l10 10-7 7L3 10z M7.5 7.5h.01',
  copy:'M8 8h12v12H8z M16 4H4v12',
  paste:'M9 4H5v16h14V4h-4 M9 3h6v4H9z',
  filter:'M3 5h18l-7 8v5l-4 2v-7z', save:'M4 4h13l3 3v13H4z M8 4v5h8V4 M8 20v-6h8v6',
  trash:'M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 10v6 M14 10v6',
  minus:'M5 12h14', fit:'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  focus:'M12 2v4m0 12v4M2 12h4m12 0h4 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
}
type Props=ComponentPropsWithRef<'button'> & {icon:keyof typeof icons; label:string}
export function ActionGlyph({icon}:{icon:keyof typeof icons}) {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={icons[icon]}/></svg>
}
export function IconAction({icon,label,children,className='',...props}:Props) {
  return <button type="button" {...props} className={`plate-tool-icon ${className}`} aria-label={label} title={label}>
    <ActionGlyph icon={icon}/>{children}<span className="plate-tool-hint" aria-hidden="true">{label}</span>
  </button>
}
