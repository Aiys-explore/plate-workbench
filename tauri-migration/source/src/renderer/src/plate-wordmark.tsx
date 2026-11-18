/// <reference types="vite/client" />
import wordmarkUrl from './assets/plate-wordmark-gradient.png?inline'
import './styles/plate-wordmark.css'

export function PlateWordmark() {
  return <span className="plate-wordmark">
    <img src={wordmarkUrl} alt="Plate" draggable={false} decoding="async" />
  </span>
}
