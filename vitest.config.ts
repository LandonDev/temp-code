import { configDefaults, defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'

// Root vitest: the transplanted renderer tests (src/renderer/src/**) and
// the server's unit tests (src/main/**). Two projects:
//   node — every *.test.ts(x); the renderer tests bring their own DOM/bridge
//          mocks and several replace `window` or `localStorage` wholesale,
//          which a jsdom window would refuse.
//   dom  — *.dom.test.tsx only: jsdom, the polyfills in test/domSetup.ts,
//          and the heavy editor/terminal packages aliased to stubs so a
//          component can mount without pulling xterm or CodeMirror.
const renderer = resolve(__dirname, 'src/renderer/src')
const stub = (name: string): string => resolve(renderer, 'test/stubs', name)
const storageSetup = resolve(renderer, 'test/storageSetup.ts')

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@server/shared': resolve(__dirname, 'src/shared'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': renderer,
      '@aliax': resolve(renderer, 'aliax')
    }
  },
  test: {
    passWithNoTests: true,
    // The release train runs all 4,300 tests in parallel lanes beside the
    // build and the Swift packages on the Mac; tests that take a second alone
    // run four to six under that load, and the 5 s default failed the train
    // three times in one night on three different files. 20 s is a hang, not
    // a slow test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // One bounded forks pool. The box shares one pids budget (cgroup v2
    // counts threads) across every thread's test runs, and the default pool
    // (a fork per core, 31 on the box) could not spawn its workers under the
    // cap and died before its first line of output (2026-10-27). Four forks
    // on Linux; the Mac keeps half its cores, beside the train's other lanes.
    pool: 'forks',
    maxWorkers: process.platform === 'linux' ? 4 : Math.max(2, Math.floor(availableParallelism() / 2)),
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.dom.test.tsx'],
          setupFiles: [storageSetup]
        }
      },
      {
        extends: true,
        resolve: {
          alias: [
            { find: '@xterm/xterm/css/xterm.css', replacement: stub('empty.css') },
            { find: '@xterm/xterm', replacement: stub('xterm.ts') },
            { find: /^@codemirror\/.*/, replacement: stub('codemirror.ts') },
            { find: /^streamdown(\/.*)?$/, replacement: stub('streamdown.tsx') },
            { find: /^monaco-editor(\/.*)?$/, replacement: stub('monaco.ts') }
          ]
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.tsx'],
          setupFiles: [storageSetup, resolve(renderer, 'test/domSetup.ts')]
        }
      }
    ]
  }
})
