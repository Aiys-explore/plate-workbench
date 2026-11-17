import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'electron-vite'

// The ConPTY addon must sit next to the built main bundle for both dev and
// packaged runs; pty.ts resolves it via __dirname/native.
const copyPlateTerminalNative = (): Plugin => ({
  name: 'copy-plate-terminal-native',
  closeBundle() {
    const from = join(__dirname, 'src', 'main', 'plate-terminal', 'native')
    const to = join(__dirname, 'out', 'main', 'native')
    mkdirSync(to, { recursive: true })
    copyFileSync(join(from, 'plate-terminal.node'), join(to, 'plate-terminal.node'))
    copyFileSync(join(from, 'plate-terminal.sha256'), join(to, 'plate-terminal.sha256'))
  }
})

export default defineConfig({
  main: { plugins: [copyPlateTerminalNative()] },
  preload: {},
  renderer: {
    plugins: [react()],
    server: { host: '127.0.0.1' }
  }
})
