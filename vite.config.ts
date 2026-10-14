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
      },
      output: {
        /*
         * Name the vendor chunk instead of letting Rollup pick.
         *
         * Left to itself it named the 237 kB React runtime after whichever module
         * it happened to reach first (`icons-*.js`), which made the build report
         * unreadable - the file that looks like a few kilobytes of inline SVG was
         * actually React, react-dom and the scheduler. Splitting it explicitly also
         * means a change to application code no longer invalidates the cached copy
         * of the framework, which is the whole point of content hashing.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          return 'vendor'
        }
      }
    }
  }
})
