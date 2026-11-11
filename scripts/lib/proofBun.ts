import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'

/** npm's ancestor .bin directories must not select a different Bun for a proof. */
export function preferredProofBun(
  current: string,
  home: string,
  ops = {
    executable: (path: string): boolean => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    realpath: realpathSync as (path: string) => string
  }
): string | null {
  const wanted = join(home, '.bun/bin/bun')
  if (!ops.executable(wanted)) return null
  try {
    return ops.realpath(wanted) === ops.realpath(current) ? null : wanted
  } catch {
    return wanted === current ? null : wanted
  }
}

/** The parent starts no app; the runtime child owns the rig and receives its exit signals. It stays in the
 *  caller's process group, so the gate's group kill (SIGTERM, then SIGKILL) reaches it whatever the wrapper does. */
export function runProofBun(
  bun: string,
  script: string,
  args: string[],
  opts: { spawn?: typeof spawn; events?: Pick<EventEmitter, 'once' | 'removeListener'> } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const child: ChildProcess = (opts.spawn ?? spawn)(bun, [script, ...args], {
      env: process.env,
      stdio: 'inherit'
    })
    const events = opts.events ?? process
    let stopping = false
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return
      stopping = true
      child.kill(signal)
    }
    const term = (): void => stop('SIGTERM')
    const interrupt = (): void => stop('SIGINT')
    const done = (code: number): void => {
      events.removeListener('SIGTERM', term)
      events.removeListener('SIGINT', interrupt)
      events.removeListener('exit', term)
      resolve(code)
    }
    events.once('SIGTERM', term)
    events.once('SIGINT', interrupt)
    events.once('exit', term)
    child.once('error', (error) => {
      console.error(`proof Bun failed: ${error.message}`)
      done(1)
    })
    child.once('close', (code) => done(code ?? 1))
  })
}

/** Where a Bun may live besides the one running; the person's own install comes first. */
export function proofBunCandidates(current: string, home: string): string[] {
  return [join(home, '.bun/bin/bun'), current, '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
}

/**
 * The first candidate that runs and has `node:sqlite`, or null. `bun run` puts every ancestor's
 * node_modules/.bin on PATH, so the `bun` a package script names can be any old copy (a 1.3.5 in
 * ~/node_modules/.bin on the person's Mac has no `node:sqlite`); the proofs import it.
 */
export function sqliteProofBun(
  candidates: string[],
  ops: { executable: (path: string) => boolean; hasSqlite: (path: string) => boolean }
): string | null {
  const seen = new Set<string>()
  for (const bun of candidates) {
    if (seen.has(bun)) continue
    seen.add(bun)
    if (ops.executable(bun) && ops.hasSqlite(bun)) return bun
  }
  return null
}
