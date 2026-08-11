/** M2 sanity: archive/unarchive, restart, delete-with-children, no LLM calls. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-lc-')), 'lc.db')))
const registry = new SessionRegistry(store)

let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const base = {
  provider: 'claude' as const,
  model: 'claude-sonnet-5',
  reasoning: 'low' as const,
  agentType: 'implementer' as const,
  cwd: '/tmp',
  parentId: null
}

const removed: string[][] = []
registry.onRemoved((ids) => removed.push(ids))

const parent = await registry.create({ ...base, title: 'parent' })
const child = await registry.create({ ...base, title: 'child', parentId: parent.id })

check('agent-spawned logged on parent', registry.eventsAfter(parent.id, 0).some((r) => r.event.type === 'agent-spawned'))

await registry.setArchived(parent.id, true)
check('archive persists', store.getSession(parent.id)?.archived === true)
await registry.setArchived(parent.id, false)
check('unarchive persists', store.getSession(parent.id)?.archived === false)

store.updateSession(parent.id, { status: 'error' })
await registry.restart(parent.id)
check('restart resets error → idle', store.getSession(parent.id)?.status === 'idle')

await registry.delete(parent.id)
check('delete removes parent + child rows', !store.getSession(parent.id) && !store.getSession(child.id))
check('delete clears event logs', registry.eventsAfter(parent.id, 0).length === 0)
check('removal notified with both ids', removed.length === 1 && removed[0].length === 2)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
