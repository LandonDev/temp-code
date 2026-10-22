import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { replaceTokens, SessionRegistry } from './sessions'
import type { CheckpointStore } from './checkpoint'
import type { DriverCtx } from './drivers/types'
import type { ForeignThreadRead } from './crossHostAgents'
import type { Attachment, SessionMeta } from '../../shared/events'

/**
 * `@thread:` references in a message (docs/box.md "One project across
 * hosts: threads see each other"): a thread on another host is read from
 * there into the same digest file a local reference gets, or named as
 * unreachable. The fake driver records what reached the harness.
 */
const sends = new Map<string, string[]>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        const id = ctx.session.id
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          dispose: async () => {}
        }
      }
    }
  }
}))

const BOX = 'env_abcdefghijklmnopqrstuv'
const FAR = 'farThread01'

let root: string
let db: ReturnType<typeof openDb>
let registry: SessionRegistry
let reads: { caller: string; environmentId: string; sessionId: string }[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-mentions-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
  registry.checkpoints = { ensure: async () => {} } as unknown as CheckpointStore
  sends.clear()
  reads = []
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

/** A fake crossHostAgents.readThread answering `answer` for the box, null (this host) otherwise. */
function farHost(answer: (sessionId: string) => ForeignThreadRead): void {
  registry.readForeignThread = async (caller: SessionMeta, environmentId: string, sessionId: string) => {
    reads.push({ caller: caller.id, environmentId, sessionId })
    return environmentId === BOX ? answer(sessionId) : null
  }
}

const ref = (sessionId: string, environmentId?: string): Attachment => ({
  kind: 'thread',
  path: `thread:${sessionId}`,
  name: 'Auth rewrite',
  sessionId,
  ...(environmentId ? { environmentId } : {})
})

async function projectThread(): Promise<SessionMeta> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  return registry.create({ cwd: root, provider: 'claude', projectId: project.id, title: 'Here' })
}

it('a thread on another host lands in the same refs file a local reference gets', async () => {
  farHost((sessionId) => ({ ok: true, hostName: 'box', sessionId, title: 'Auth rewrite', projectName: 'temp-code', digest: '# Auth rewrite\n\nthe far digest' }))
  const here = await projectThread()
  await registry.send(here.id, `look at @thread:${BOX}:${FAR} please`, { attachments: [ref(FAR, BOX)] })
  expect(reads).toEqual([{ caller: here.id, environmentId: BOX, sessionId: FAR }])
  const sent = sends.get(here.id)!.at(-1)!
  expect(sent).toContain(`look at @.temp-code/refs/${FAR}.md (thread "Auth rewrite" from project "temp-code" on box) please`)
  expect(sent).not.toContain('@thread:')
  expect(await readFile(join(root, '.temp-code', 'refs', `${FAR}.md`), 'utf8')).toBe('# Auth rewrite\n\nthe far digest')
})

it('a projectless thread reads the far digest inline, with its host', async () => {
  farHost((sessionId) => ({ ok: true, hostName: 'box', sessionId, title: 'Auth rewrite', projectName: null, digest: 'the far digest' }))
  const here = await registry.create({ cwd: root, provider: 'claude', title: 'Loose' })
  await registry.send(here.id, `see @thread:${BOX}:${FAR}`, { attachments: [ref(FAR, BOX)] })
  const sent = sends.get(here.id)!.at(-1)!
  expect(sent).toContain('see thread "Auth rewrite" (referenced below)')
  expect(sent).toContain('<thread-reference title="Auth rewrite" host="box">\nthe far digest\n</thread-reference>')
})

it('a host out of reach leaves one line saying so', async () => {
  farHost(() => ({ ok: false, hostName: 'box', why: 'host offline: box is not connected' }))
  const here = await projectThread()
  await registry.send(here.id, `see @thread:${BOX}:${FAR}`, { attachments: [ref(FAR, BOX)] })
  const sent = sends.get(here.id)!.at(-1)!
  expect(sent).toContain('see thread "Auth rewrite" on box is unreachable (host offline: box is not connected)')
  expect(sent).not.toContain('<thread-reference')
})

it('a reference naming this host reads the thread here', async () => {
  const OWN = 'env_ownownownownownownownow'
  farHost(() => {
    throw new Error('never asked')
  })
  const local = await registry.create({ cwd: root, provider: 'claude', title: 'Local one' })
  const here = await projectThread()
  await registry.send(here.id, `see @thread:${OWN}:${local.id}`, { attachments: [ref(local.id, OWN)] })
  expect(reads).toEqual([{ caller: here.id, environmentId: OWN, sessionId: local.id }])
  const sent = sends.get(here.id)!.at(-1)!
  expect(sent).toContain(`see @.temp-code/refs/${local.id}.md (thread "Local one")`)
})

it('replaceTokens swaps the qualified token before the bare one, and appends when neither is there', () => {
  const tokens = [`@thread:${FAR}`, `@thread:${BOX}:${FAR}`]
  expect(replaceTokens(`a @thread:${BOX}:${FAR} b @thread:${FAR}`, tokens, 'X')).toBe('a X b X')
  expect(replaceTokens('nothing', tokens, 'X')).toBe('nothing\n\nX')
})
