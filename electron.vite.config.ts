import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { statSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Measurement builds (scripts/measure-react-compiler.ts): the profiling
 *  reconciler makes <Profiler> report in production mode and keeps the dev
 *  facade (`window.__app`) installed. */
const profiling = process.env.TEMP_CODE_PROFILE === '1'

/** The renderer compiles through the React Compiler (kept after the measured
 *  trial of 2026-10-19, plan 70GqTBkrP0qv: 34% less root render time on a
 *  60 s synthetic stream). `infer` compiles every function the compiler
 *  recognises as a component or hook; `panicThreshold: 'none'` skips one it
 *  cannot handle instead of failing the build (124 of 834 today, tallied by
 *  scripts/react-compiler-tally.ts). */
const reactCompiler = [
  'babel-plugin-react-compiler',
  { target: '19', compilationMode: 'infer', panicThreshold: 'none' }
]

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
    plugins: [externalizeDepsPlugin({ exclude: ['aliax-core'] }), appshotHelper()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // Two entries: boot.js (package.json `main`) enables Node's compile cache
    // and requires index.js, the real bundle, through it. boot.ts shares no
    // module with index.ts, so Rollup emits no chunks/ between them.
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), boot: resolve('src/main/boot.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        ...(profiling ? { 'react-dom/client': 'react-dom/profiling' } : {}),
        '@renderer': resolve('src/renderer/src'),
        // The Aliax pages (Accounts, Stats) ported verbatim keep their `@/`
        // imports under this root, so a future re-port stays a copy.
        '@aliax': resolve('src/renderer/src/aliax'),
        // The transplanted renderer imports server types as
        // `@server/shared/*` (MonoCode's layout); they live in src/shared.
        '@server/shared': resolve('src/shared'),
        '@shared': resolve('src/shared')
      }
    },
    define: { 'import.meta.env.TEMP_CODE_PROFILE': JSON.stringify(profiling ? '1' : '') },
    // Monaco's editor worker is a lazy chunk; iife workers cannot code-split.
    worker: { format: 'es' },
    plugins: [
      react({ babel: { plugins: [reactCompiler] } }),
      tailwindcss()
    ]
  }
})
