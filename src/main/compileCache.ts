import { join } from 'node:path'

/**
 * Node's on-disk compile cache for the main bundle (plan kzTjVxj7h35M). The
 * packaged entry (boot.ts) turns it on before requiring out/main/index.js, so
 * every launch after the first loads V8's cached code instead of compiling
 * 1.1 MB of JavaScript. Pure helpers here; boot.ts does the enabling.
 */

/** `TEMP_CODE_COMPILE_CACHE` overrides the directory so an isolated copy
 *  (the launch-timing harness) never touches the shared one under $TMPDIR,
 *  which macOS purges after three idle days: one cold compile, then warm. */
export function compileCacheDir(env: NodeJS.ProcessEnv, tmpdir: string): string {
  return env.TEMP_CODE_COMPILE_CACHE || join(tmpdir, 'temp-code', 'compile-cache')
}

export interface EnableResult {
  status: number
  message?: string
  directory?: string
}

/** The `[boot] compile-cache …` line: the status name, then the directory or
 *  the failure message. `status` is node:module's `constants.compileCacheStatus`. */
export function compileCacheLine(result: EnableResult, status: Record<string, number>): string {
  const name = Object.keys(status).find((k) => status[k] === result.status) ?? String(result.status)
  const tail =
    name === 'FAILED' ? result.message : name === 'DISABLED' ? undefined : result.directory
  return `compile-cache ${name}${tail ? ` ${tail}` : ''}`
}
