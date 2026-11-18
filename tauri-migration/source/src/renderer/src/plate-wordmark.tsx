/// <reference types="vite/client" />
import wordmarkUrl from './assets/plate-wordmark-pixel.png?inline'
import './styles/plate-wordmark.css'

export function PlateWordmark() {
  return <span className="plate-wordmark">
    <img src={wordmarkUrl} alt="[plate]" draggable={false} decoding="async" />
  </span>
}
