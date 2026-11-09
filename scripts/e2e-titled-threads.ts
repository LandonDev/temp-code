/**
 * Stability 1, the host side, in one process (no harness boots: claude's
 * driver is a stub that records what it is sent). Proves:
 *   1. startWith whose first message is refused leaves no thread, and the
 *      removal is pushed (session-removed).
 *   2. A thread started under a paused parent stores its brief as its first
 *      row at once: a registry rebuilt over the same database file lists it
 *      with that row.
 *   3. session.events on an id the host does not show is refused
 *      (`unknown session`), on both profiles, never answered with no rows.
 *   4. No thread the host lists has a title and no rows.
 * Run: bun run script:e2e-titled-threads
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { BUILT_IN_DRIVERS } from '../src/main/server/drivers'
import type { DriverCtx, DriverHandle } from '../src/main/server/drivers/types'
import { SessionRegistry } from '../src/main/server/sessions'
import { sessionEvents } from '../src/main/server/wire'

const sent: string[] = []
BUILT_IN_DRIVERS.claude = {
  ...BUILT_IN_DRIVERS.claude,
  start: async (ctx: DriverCtx): Promise<DriverHandle> => ({
    send: async (text: string) => {
      sent.push(text)
      ctx.emit({ type: 'status', status: 'running' })
    },
    interrupt: () => {},
    alive: () => true,
    dispose: async () => {}
  })
}

const dir = mkdtempSync(join(tmpdir(), 'tc-titled-'))
const dbPath = join(dir, 'app.db')
const db = openDb(dbPath)
const store = new Store(db)
const registry = new SessionRegistry(store)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const userRows = (s: Store, id: string): string[] =>
  s.eventsAfter(id, 0).flatMap((r) => (r.event.type === 'user-text' ? [r.event.text] : []))

try {
  // 1. A refused first message leaves nothing behind.
  const removed: string[] = []
  registry.onRemoved((ids) => removed.push(...ids))
  const internals = registry as unknown as { applyRunSettings: (...args: unknown[]) => Promise<unknown> }
  const real = internals.applyRunSettings.bind(registry)
  internals.applyRunSettings = async () => {
    internals.applyRunSettings = real
    throw new Error('refused: the model is not available here')
  }
  let refusal = ''
  await registry
    .startWith({ cwd: dir, provider: 'claude', title: 'Refused build' }, 'build it')
    .catch((e: unknown) => (refusal = e instanceof Error ? e.message : String(e)))
  check('a refused first message is the caller’s error', refusal.includes('not available'), refusal)
  check('and leaves no thread', !registry.list({ archived: undefined }).some((s) => s.title === 'Refused build'))
  check('and the removal is pushed', removed.length === 1, `removed ${removed.length}`)

  // 2. Under a paused parent the brief is stored at once.
  const parent = await registry.startWith({ cwd: dir, provider: 'claude', title: 'Parent' }, 'parent brief')
  store.updateSession(parent.id, { status: 'paused' })
  const child = await registry.startWith(
    { cwd: dir, provider: 'claude', title: 'Child under a pause', parentId: parent.id },
    'child brief'
  )
  check('the child is held, not delivered', !sent.some((t) => t.includes('child brief')))
  const otherDb = openDb(dbPath)
  try {
    const other = new Store(otherDb)
    const rebuilt = new SessionRegistry(other)
    check('a registry rebuilt over the file lists the child', rebuilt.get(child.id)?.title === 'Child under a pause')
    check('with its brief as its first row', userRows(other, child.id)[0] === 'child brief', JSON.stringify(userRows(other, child.id)))

    // 4. Nothing listed has a title and no rows.
    const empty = rebuilt.list({ archived: undefined }).filter((s) => other.eventsAfter(s.id, 0).length === 0)
    check('no listed thread has a title and no rows', empty.length === 0, empty.map((s) => s.title).join(', '))
    await rebuilt.close()
  } finally {
    otherDb.close()
  }

  // 3. An unknown id is refused, never "no rows".
  for (const profile of ['local', 'remote'] as const) {
    let answer = ''
    await sessionEvents(registry, { sessionId: 'never-here', afterSeq: 0, tail: 300 }, profile, () => {}).catch(
      (e: unknown) => (answer = e instanceof Error ? e.message : String(e))
    )
    check(`session.events refuses an unknown id (${profile})`, answer === 'unknown session: never-here', answer)
  }
  const known = await sessionEvents(registry, { sessionId: child.id, afterSeq: 0 }, 'local', () => {})
  check('and answers a known one', Array.isArray(known) && known.length > 0)
} finally {
  await registry.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
