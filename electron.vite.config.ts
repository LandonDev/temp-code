import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { statSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Compiles the Appshots native helper into resources/ (which rides every
 *  update path). Skipped when the binary is newer than the source; a missing
 *  or failing swiftc only warns — the feature disables itself at runtime. */
function appshotHelper(): Plugin {
  return {
    name: 'appshot-helper',
    buildStart() {
      const src = resolve('resources/native/appshot-helper.swift')
      const bin = resolve('resources/native/appshot-helper')
      const mtime = (p: string) => {
        try {
          return statSync(p).mtimeMs
        } catch {
          return 0
        }
      }
      if (mtime(bin) >= mtime(src)) return
      try {
        execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' })
      } catch {
        console.warn('[appshot-helper] swiftc failed or missing — Appshots will be disabled')
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), appshotHelper()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // The transplanted renderer imports server types as
        // `@server/shared/*` (MonoCode's layout); they live in src/shared.
        '@server/shared': resolve('src/shared'),
        '@shared': resolve('src/shared')
      }
    },
    // Monaco's editor worker is a lazy chunk; iife workers cannot code-split.
    worker: { format: 'es' },
    plugins: [react(), tailwindcss()]
  }
})
