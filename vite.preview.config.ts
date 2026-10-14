import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Design-harness build for the player page.
 *
 * Produces one self-contained HTML file that runs from `file://` with no server
 * and no Electron. The normal build cannot be opened that way: Vite emits
 * `<script type="module" crossorigin>`, and Chrome refuses both the module fetch
 * and the crossorigin stylesheet from a `file://` origin.
 *
 * `format: 'iife'` matters as much as the inlining step - a classic script has no
 * imports to resolve, so it is legal once inlined. That is also why the overlay
 * gets its own single-entry build rather than sharing this one: two entries would
 * be code-split, and IIFE output is not permitted for a code-split build.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    target: 'esnext',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
