import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Design-harness build for the desktop lyric overlay.
 *
 * A separate build because the overlay is a separate document in a separate
 * window, and because a single-entry build is the only way to get IIFE output -
 * two entries would be code-split, and Rollup refuses IIFE for a code-split
 * build.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-preview-overlay',
    emptyOutDir: true,
    target: 'esnext',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'overlay.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
