/**
 * Boot benchmark (.temp-code/plan-sYsbtyUmbE4Y.md C8): the four costs that
 * used to stack up before the thread list appeared, timed in one headless
 * node process — no Electron, no window, no renderer.
 *
 *   db open → registry (folds map) → first list() → fold sweep → mirror backfill
 *
 * Run it against a COPY of a database, never a live one; the script
 * refuses a path inside the installed app's userData. Mirror writes are
 * redirected into a temp dir, so no real project's `.temp-code/` is
 * touched.
 *
 * Run: bun run script:bench-boot -- /tmp/bench/temp-code.db
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { sweepFolds } from '../src/main/server/folds'
import { backfillMirrors } from '../src/main/server/mirror'
import { SessionRegistry } from '../src/main/server/sessions'
import type { ProjectMeta } from '../src/shared/events'

const dbArg = process.argv[2]
if (!dbArg) {
  console.error('usage: bench-boot <path to a copy of temp-code.db>')
  process.exit(2)
}
const dbPath = resolve(dbArg)

// The installed app is the user's live workspace. A second writer on its
// database freezes the running threads, so the benchmark will not open it.
const LIVE = join(homedir(), 'Library', 'Application Support', 'temp-code')
if (dbPath === join(LIVE, 'temp-code.db') || dbPath.startsWith(`${LIVE}/`)) {
  console.error(`refusing to open the installed app's database: ${dbPath}`)
  console.error(`copy it first:  cp "${join(LIVE, 'temp-code.db')}"* /tmp/bench/`)
  process.exit(2)
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`
const marks: [string, number][] = []
async function time<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  const at = performance.now()
  const out = await run()
  const ms = performance.now() - at
  marks.push([label, ms])
  console.log(`${label.padEnd(22)} ${secs(ms).padStart(8)}`)
  return out
}

console.log(`db        ${dbPath} (${mb(statSync(dbPath).size)})`)

const store = await time('db-open', () => new Store(openDb(dbPath)))
const registry = await time('registry', () => new SessionRegistry(store))
// Boot appends a synthetic idle to every session left running by a crash.
await time('reset-stale', () => registry.resetStaleStatuses())
const sessions = await time('first-session-list', () => registry.list())
await time('second-session-list', () => registry.list())

let folded = 0
await time('fold-backfill', async () => {
  folded = await sweepFolds(store, registry)
})

/**
 * `backfillMirrors` writes `<project cwd>/.temp-code/threads/`. The
 * benchmark hands it a registry whose projects live in a temp dir instead,
 * so the work is identical and no real project is written to.
 */
const mirrorRoot = mkdtempSync(join(tmpdir(), 'tc-bench-mirrors-'))
const redirected = new Map<string, string>()
const mirrorRegistry = new Proxy(registry, {
  get(target, prop) {
    if (prop === 'getProject') {
      return (id: string): ProjectMeta | null => {
        const project = target.getProject(id)
        if (!project) return project
        let cwd = redirected.get(id)
        if (!cwd) {
          cwd = join(mirrorRoot, id)
          mkdirSync(cwd, { recursive: true })
          redirected.set(id, cwd)
        }
        return { ...project, cwd }
      }
    }
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  }
}) as SessionRegistry

await time('mirror-backfill', () => backfillMirrors(mirrorRegistry))

const mirrorFiles = readdirSync(mirrorRoot).reduce((n, dir) => {
  try {
    return n + readdirSync(join(mirrorRoot, dir, '.temp-code', 'threads')).length
  } catch {
    return n
  }
}, 0)
rmSync(mirrorRoot, { recursive: true, force: true })

const events = [...store.maxSeqs().values()].reduce((a, b) => a + b, 0)
const total = marks.reduce((a, [, ms]) => a + ms, 0)
console.log('')
console.log(`sessions            ${sessions.length}`)
console.log(`events              ${events.toLocaleString('en-US')}`)
console.log(`projects redirected ${redirected.size}`)
console.log(`folds swept         ${folded}`)
console.log(`mirrors written     ${mirrorFiles}`)
console.log(`total               ${secs(total)}`)
