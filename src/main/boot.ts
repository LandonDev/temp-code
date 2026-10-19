/**
 * The packaged entry (package.json `main`). It turns on Node's compile cache
 * and then loads the real main bundle through it, so a warm launch reads
 * V8's cached code for out/main/index.js instead of compiling it. The cache
 * reaches disk only when index.ts flushes it (10 s after boot and at quit):
 * Electron's quit is not Node's exit path.
 *
 * Imports nothing index.ts imports: a shared module would make Rollup emit
 * out/main/chunks/* and both entries would require it, so index.js would no
 * longer load alone through the cache that was just enabled.
 */
import { app } from 'electron'
import { constants, enableCompileCache } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCacheDir, compileCacheLine } from './compileCache'

// Packaged only: dev serves changing code, and the cache is a speedup, never a gate.
if (app.isPackaged) {
  try {
    const result = enableCompileCache(compileCacheDir(process.env, tmpdir()))
    console.log(
      `[boot] ${compileCacheLine(result, constants.compileCacheStatus as unknown as Record<string, number>)}`
    )
  } catch {
    // never let the cache stop the app from starting
  }
}
// A computed path keeps Rollup from folding index.js into this file, so the
// main bundle is compiled through the cache that was just enabled.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(join(__dirname, 'index.js'))
