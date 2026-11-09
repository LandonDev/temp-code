import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { buildTcComputer } from './scripts/lib/tcComputerBuild'

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

/** Builds the computer-use service; watch mode leaves the cold build in the background. */
function tcComputer(): Plugin {
  const root = resolve('.')
  return {
    name: 'tc-computer',
    buildStart() {
      buildTcComputer({
        root,
        background: this.meta.watchMode,
        require: process.env.TEMP_CODE_REQUIRE_NATIVE === '1'
      })
    }
  }
}

/** The commit a build was made from, and whether its tracked files matched
 *  it: the renderer soak (scripts/measure-renderer-soak.ts --gate) runs out/
 *  only when this is HEAD with a clean tree, and builds first otherwise. */
function buildHead(): { sha: string | null; clean: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
    return { sha, clean: dirty === '' }
  } catch {
    return { sha: null, clean: false }
  }
}

/** Writes out/bundle-map.json after the renderer build: every chunk with its
 *  size, what it imports statically and dynamically, and the rendered size of
 *  every module in it. scripts/bundle-map.ts reads it (the report), and
 *  scripts/check-bundle-size.ts gates on it. Not under out/renderer, so the
 *  packaged app never ships it. */
function bundleMap(): Plugin {
  return {
    name: 'temp-code-bundle-map',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: Record<string, unknown> = {}
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk') {
          chunks[file] = { type: 'asset', bytes: Buffer.byteLength(out.source as string | Uint8Array) }
          continue
        }
        const modules: Record<string, number> = {}
        for (const [id, m] of Object.entries(out.modules)) modules[id.replace(resolve('.') + '/', '')] = m.renderedLength
        chunks[file] = {
          type: 'chunk',
          entry: out.isEntry,
          bytes: Buffer.byteLength(out.code),
          imports: out.imports,
          dynamicImports: out.dynamicImports,
          modules
        }
      }
      mkdirSync(resolve('out'), { recursive: true })
      writeFileSync(resolve('out/bundle-map.json'), JSON.stringify({ chunks, head: buildHead() }, null, 1))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['aliax-core', '@muse-code/sdk'] }), appshotHelper(), tcComputer()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // Six entries: boot.js (package.json `main`) enables Node's compile
    // cache and requires index.js, the real bundle, through it; boot.ts
    // shares no module with index.ts. gateway.js is the gateway's utility
    // process (gatewaySpawn.ts forks it); the modules it shares with
    // index.js (the gateway core, aliax-core) land in chunks/, which both
    // require, so neither copy of them can drift from the other.
    // statsWorker.js is the stats worker thread (statsService.ts starts it):
    // the stats index and bundle run there, never on main's loop.
    // execBroker.js is the exec broker's utility process (execBrokerSpawn.ts
    // forks it): every helper child forks from it, never from main.
    // addonHost.js is the add-on host's utility process (addonHostSpawn.ts
    // forks it): every downstream MCP client runs there, never in main or
    // the gateway, so an add-on's fault cuts no provider stream.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          boot: resolve('src/main/boot.ts'),
          gateway: resolve('src/main/gatewayProcess.ts'),
          statsWorker: resolve('src/main/aliax/stats/statsWorker.ts'),
          execBroker: resolve('src/main/execBrokerProcess.ts'),
          addonHost: resolve('src/main/addonHostProcess.ts')
        }
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
        '@shared': resolve('src/shared'),
        // The markdown parse worker (lib/markdown.worker.ts) runs micromark
        // too; the package's browser build decodes entities through a DOM
        // element, which a worker has no document for. The plain build
        // works everywhere and costs its entity table.
        'decode-named-character-reference': resolve(
          'node_modules/decode-named-character-reference/index.js'
        )
      }
    },
    define: { 'import.meta.env.TEMP_CODE_PROFILE': JSON.stringify(profiling ? '1' : '') },
    // The dev server's port, 5173 unless TEMP_CODE_RENDERER_PORT says otherwise (another
    // app's dev server on [::1]:5173 would answer `localhost:5173` in the window's place).
    ...(process.env.TEMP_CODE_RENDERER_PORT ? { server: { port: Number(process.env.TEMP_CODE_RENDERER_PORT), strictPort: true } } : {}),
    // Monaco's editor worker is a lazy chunk; iife workers cannot code-split.
    worker: { format: 'es' },
    plugins: [
      react({ babel: { plugins: [reactCompiler] } }),
      tailwindcss(),
      bundleMap()
    ]
  }
})
