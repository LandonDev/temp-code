/** M2 sanity: archive/unarchive, restart, delete-with-children, no LLM calls. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import type { SessionMeta } from '../src/shared/events'

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
  permission: 'edits' as const,
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

// Failed reads off the root's own trailing error, never a stale child's.
const root2 = await registry.create({ ...base, title: 'root2' })
const child2 = await registry.create({ ...base, title: 'child2', parentId: root2.id })
const metaOf = (id: string): SessionMeta => registry.list().find((s) => s.id === id)!

registry.append(child2.id, { type: 'error', message: 'boom' })
registry.append(child2.id, { type: 'status', status: 'error' })
check('child error alone never marks the tree failed', metaOf(root2.id).treeCanContinue === false)
check('the child itself still offers Continue', metaOf(child2.id).canContinue === true)

registry.append(root2.id, { type: 'error', message: 'session limit' })
check('root trailing error marks the tree failed', metaOf(root2.id).treeCanContinue === true)
registry.append(root2.id, { type: 'assistant-text', text: 'back at it', delta: false })
check('root activity past the error clears failed', metaOf(root2.id).treeCanContinue === false)

// A user Stop is not a failure: the stamped error never arms recovery.
registry.append(root2.id, { type: 'error', message: 'turn ended: interrupted', stopped: true })
check('stopped error never marks the tree failed', metaOf(root2.id).treeCanContinue === false)
check('stopped error never offers Continue', metaOf(root2.id).canContinue === false)

// Legacy stops predate the stamp: an unstamped turn-ended wind-down still
// never arms recovery (the fold heals persisted threads by message).
registry.append(root2.id, { type: 'error', message: 'turn ended: error_during_execution' })
check('unstamped turn-ended error never marks the tree failed', metaOf(root2.id).treeCanContinue === false)
check('unstamped turn-ended error never offers Continue', metaOf(root2.id).canContinue === false)
await registry.delete(root2.id)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
