import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    assetsInlineLimit: file => /\.woff2?$/i.test(file) ? false : undefined,
    target: 'chrome140'
  }
})
