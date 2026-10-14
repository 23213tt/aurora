import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // Relative base matters: the production build is loaded over file://
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
    rollupOptions: {
      /*
       * Two pages. `index.html` is the player; `overlay.html` is the desktop
       * lyric window, which is a separate BrowserWindow with its own document -
       * it has to be its own entry or the overlay would ship the whole app.
       */
      input: {
        index: resolve(__dirname, 'index.html'),
        overlay: resolve(__dirname, 'overlay.html')
      }
    }
  }
})
