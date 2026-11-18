export type Destination = { kind: 'slot'; id: number } | { kind: 'runtime'; flavor: string } | { kind: 'desktop'; flavor: 'zcode' }
export type Extract = { noteId: string; title: string; text: string; revision: string }
export type Handoff = Extract & { id: string; target: Destination }
type Drag = { material: Extract } | { target: Destination }
const mime = 'application/x-plate-note-drag'
let active: { nonce: string; data: Drag } | undefined
export function startPlateDrag(dt: DataTransfer, data: Drag) {
  const nonce = crypto.randomUUID()
  active = { nonce, data }
  dt.effectAllowed = 'copy'
  dt.setData(mime, nonce)
}
export const clearPlateDrag = () => { active = undefined }
export const isPlateDrag = (dt: DataTransfer, kind: 'material' | 'target') =>
  !!active && kind in active.data && dt.types.includes(mime)
export function consumePlateDrag(dt: DataTransfer) {
  if (!active || dt.getData(mime) !== active.nonce) return undefined
  const data = active.data
  active = undefined
  return data
}
export function handoff(material: Extract, target: Destination) {
  window.dispatchEvent(new CustomEvent<Handoff>('plate-note-handoff', {
    detail: { ...material, id: crypto.randomUUID(), target }
  }))
}
