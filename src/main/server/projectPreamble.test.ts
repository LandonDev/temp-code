import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { CheckpointStore } from './checkpoint'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent, PreambleStamp } from '@shared/events'
import {
  HOUSE_PREAMBLE,
  HOUSE_PREAMBLE_V1,
  migrateHousePreamble,
  PREAMBLE_HEADING,
  TASK_HEADING,
  composePreambled,
  decidePreamble,
  effectivePreamble,
  normalizePreamble,
  seedHousePreamble,
  stampOf,
  substitutePreamble,
  wordCount,
  worktreeSlug
} from './projectPreamble'
import { appStartThread } from './apptools'
import { orchSpawnAgent, setOrchestrationRegistry } from './orchestration'
import { CrossHostThreads } from './remote/crossHostThreads'

// ── the pure parts ───────────────────────────────────────────────────

describe('worktreeSlug', () => {
  it('lowercases ASCII words and joins them with dashes', () => {
    expect(worktreeSlug('Project preambles: house rules once per project')).toBe(
      'project-preambles-house-rules-once-per'
    )
  })
  it('cuts at a word boundary under the cap and strips accents', () => {
    const slug = worktreeSlug('Ünïcode titles with a very long sequence of words that never ends here')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toBe('unicode-titles-with-a-very-long-sequence')
    expect(slug.endsWith('-')).toBe(false)
  })
  it('a title with no word at all gives `thread`', () => {
    expect(worktreeSlug('…!!!')).toBe('thread')
    expect(worktreeSlug('')).toBe('thread')
  })
  it('a single word longer than the cap is cut, not dropped', () => {
    expect(worktreeSlug('x'.repeat(60))).toBe('x'.repeat(40))
  })
})

describe('wordCount and stampOf', () => {
  it('counts runs of non-whitespace', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  one  ')).toBe(1)
    expect(wordCount('- a `b` c\n\nd')).toBe(5)
    expect(stampOf('one two')).toEqual({ text: 'one two', words: 2 })
  })
})

describe('substitutePreamble', () => {
  const vars = { worktree: 'fix-the-rail', project: 'iOS App', host: 'box' }
  it('substitutes the three variables, spaces inside the braces allowed', () => {
    expect(substitutePreamble('wt {{worktree}} / {{ project }} on {{host}}', vars)).toBe(
      'wt fix-the-rail / iOS App on box'
    )
  })
  it('leaves an unknown name as written', () => {
    expect(substitutePreamble('{{branch}} and {{worktree}}', vars)).toBe('{{branch}} and fix-the-rail')
  })
  it('the house rules name the worktree twice and nothing else', () => {
    const out = substitutePreamble(HOUSE_PREAMBLE, vars)
    expect(out).toContain('git worktree add .claude/worktrees/fix-the-rail -b fix-the-rail master')
    expect(out).not.toMatch(/\{\{/)
  })
})

describe('effectivePreamble and normalizePreamble', () => {
  const ws = { id: 'w', name: 'w', path: '/w', git: true, createdAt: 1, preamble: 'WS RULES', preambleEnabled: true }
  const base = { id: 'p', workspaceId: 'w', name: 'P', mode: 'local' as const, branch: null, cwd: '/w', archived: false, createdAt: 1 }
  it('the project text wins when it has one', () => {
    expect(effectivePreamble({ ...base, preamble: 'OWN', preambleEnabled: true }, ws)).toBe('OWN')
  })
  it('a project with no text of its own takes the workspace default', () => {
    expect(effectivePreamble({ ...base, preamble: null, preambleEnabled: true }, ws)).toBe('WS RULES')
    expect(effectivePreamble({ ...base, preamble: '  \n ', preambleEnabled: true }, ws)).toBe('WS RULES')
  })
  it('a project switched off carries nothing, whatever the workspace says', () => {
    expect(effectivePreamble({ ...base, preamble: 'OWN', preambleEnabled: false }, ws)).toBeNull()
    expect(effectivePreamble({ ...base, preamble: null, preambleEnabled: false }, ws)).toBeNull()
  })
  it('a workspace default switched off does not reach its projects', () => {
    expect(effectivePreamble({ ...base, preamble: null, preambleEnabled: true }, { ...ws, preambleEnabled: false })).toBeNull()
    expect(effectivePreamble({ ...base, preamble: null }, null)).toBeNull()
    expect(effectivePreamble(null, ws)).toBeNull()
  })
  it('normalizePreamble trims, unifies line ends and nulls the empty', () => {
    expect(normalizePreamble(' a\r\nb \n')).toBe('a\nb')
    expect(normalizePreamble('   ')).toBeNull()
    expect(normalizePreamble(undefined)).toBeNull()
  })
})

describe('composePreambled', () => {
  it('puts the rules and the task under their own headings', () => {
    expect(composePreambled(stampOf('- rule'), 'do it')).toBe(
      `${PREAMBLE_HEADING}\n\n- rule\n\n${TASK_HEADING}\n\ndo it`
    )
  })
})

// ── the store, the seed and the decision ─────────────────────────────

const ws = (id: string, path: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, path, git: true, createdAt: 1, ...extra })

describe('store rows', () => {
  it('a database from before the columns reads them defaulted, and the setters round-trip', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(ws('w', '/w'))
    store.insertProject({ id: 'p', workspaceId: 'w', name: 'P', mode: 'local', branch: null, cwd: '/w', archived: false, createdAt: 1 })
    expect(store.getProject('p')).toMatchObject({ preamble: null, preambleEnabled: true })
    expect(store.listWorkspaces()[0]).toMatchObject({ preamble: null, preambleEnabled: true })
    store.setProjectPreamble('p', 'rules', false)
    expect(store.getProject('p')).toMatchObject({ preamble: 'rules', preambleEnabled: false })
    store.setWorkspacePreamble('w', 'ws rules', true)
    expect(store.listWorkspaces()[0]).toMatchObject({ preamble: 'ws rules', preambleEnabled: true })
    store.setProjectPreamble('p', null, true)
    expect(store.getProject('p')).toMatchObject({ preamble: null, preambleEnabled: true })
    db.close()
  })
})

describe('seedHousePreamble', () => {
  it('seeds the workspace whose folder is temp-code, once, and leaves the others alone', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(ws('tc', '/srv/agents/work/temp-code/'))
    store.insertWorkspace(ws('other', '/srv/agents/work/other'))
    store.insertWorkspace(ws('own', '/Users/x/temp-code', { preamble: 'mine' }))
    store.setWorkspacePreamble('own', 'mine', true)
    expect(seedHousePreamble(store)).toEqual(['tc'])
    const byId = Object.fromEntries(store.listWorkspaces().map((w) => [w.id, w.preamble]))
    expect(byId).toEqual({ tc: HOUSE_PREAMBLE, other: null, own: 'mine' })
    // Cleared later: the seed does not come back.
    store.setWorkspacePreamble('tc', null, true)
    expect(seedHousePreamble(store)).toEqual([])
    expect(store.listWorkspaces().find((w) => w.id === 'tc')?.preamble).toBeNull()
    db.close()
  })
})

describe('the house rules', () => {
  it('tell a thread to run its own tests and land through merge_branch, never the full gate', () => {
    expect(HOUSE_PREAMBLE).toContain('Run typecheck and the tests you wrote or touched; do not run the full test suite or the build.')
    expect(HOUSE_PREAMBLE).toContain('Land with the merge_branch tool: it typechecks your branch in a queue, holds the merge on a failure, and the batch\'s gate runs once on the merged tree.')
    expect(HOUSE_PREAMBLE).toContain('resolve conflicts), then call merge_branch')
    expect(HOUSE_PREAMBLE).not.toContain('re-run the gate')
    expect(HOUSE_PREAMBLE).not.toContain('must be green before you merge')
    expect(HOUSE_PREAMBLE_V1).toContain('must be green before you merge')
  })
})

describe('migrateHousePreamble', () => {
  it('rewrites a saved default still equal to the old text, once; an edited one stays', () => {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(ws('tc', '/srv/agents/work/temp-code/'))
    store.insertWorkspace(ws('off', '/srv/agents/work/temp-code-2'))
    store.insertWorkspace(ws('own', '/Users/x/temp-code'))
    store.insertWorkspace(ws('none', '/srv/agents/work/other'))
    store.setWorkspacePreamble('tc', HOUSE_PREAMBLE_V1, true)
    store.setWorkspacePreamble('off', `${HOUSE_PREAMBLE_V1}\n`, false)
    store.setWorkspacePreamble('own', `${HOUSE_PREAMBLE_V1}\n- And my own rule.`, true)
    expect(migrateHousePreamble(store).sort()).toEqual(['off', 'tc'])
    const byId = Object.fromEntries(store.listWorkspaces().map((w) => [w.id, [w.preamble, w.preambleEnabled]]))
    expect(byId.tc).toEqual([HOUSE_PREAMBLE, true])
    expect(byId.off).toEqual([HOUSE_PREAMBLE, false])
    expect(byId.own).toEqual([`${HOUSE_PREAMBLE_V1}\n- And my own rule.`, true])
    expect(byId.none).toEqual([null, true])
    // The marker: a default put back to the old text later is the person's choice.
    store.setWorkspacePreamble('tc', HOUSE_PREAMBLE_V1, true)
    expect(migrateHousePreamble(store)).toEqual([])
    expect(store.listWorkspaces().find((w) => w.id === 'tc')?.preamble).toBe(HOUSE_PREAMBLE_V1)
    db.close()
  })
})

describe('decidePreamble', () => {
  function world() {
    const db = openDb(':memory:')
    const store = new Store(db)
    store.insertWorkspace(ws('w', '/w'))
    store.setWorkspacePreamble('w', 'WS {{project}} on {{host}}', true)
    store.insertProject({ id: 'p', workspaceId: 'w', name: 'Proj', mode: 'local', branch: null, cwd: '/w', archived: false, createdAt: 1 })
    store.insertProject({ id: 'q', workspaceId: 'w', name: 'Quiet', mode: 'local', branch: null, cwd: '/w', archived: false, createdAt: 1 })
    store.setProjectPreamble('q', 'Q {{worktree}}', true)
    return { db, store }
  }
  const session = (over: Record<string, unknown>) =>
    ({ id: 's', projectId: 'p', parentId: null, title: 'Fix the rail', ...over }) as unknown as Parameters<typeof decidePreamble>[0]['session']
  it('resolves project then workspace, substitutes, and counts', () => {
    const { db, store } = world()
    expect(decidePreamble({ store, session: session({}), text: 'go', host: 'box' })).toEqual({
      text: 'WS Proj on box',
      words: 4
    })
    expect(decidePreamble({ store, session: session({ projectId: 'q' }), text: 'go', host: 'box' })).toEqual({
      text: 'Q fix-the-rail',
      words: 2
    })
    db.close()
  })
  it('a placeholder-free title is the slug; an empty title takes the first line of the text', () => {
    const { db, store } = world()
    expect(decidePreamble({ store, session: session({ projectId: 'q', title: '' }), text: 'Rework the composer\nmore', host: 'box' })?.text).toBe(
      'Q rework-the-composer'
    )
    db.close()
  })
  it('nothing for a thread outside a project, an opt-out, or a project switched off', () => {
    const { db, store } = world()
    expect(decidePreamble({ store, session: session({ projectId: null }), text: 'go' })).toBeNull()
    expect(decidePreamble({ store, session: session({}), text: 'go', optOut: true })).toBeNull()
    store.setProjectPreamble('p', null, false)
    expect(decidePreamble({ store, session: session({}), text: 'go' })).toBeNull()
    db.close()
  })
  it('the host defaults to the machine name', () => {
    const { db, store } = world()
    const out = decidePreamble({ store, session: session({}), text: 'go' })
    expect(out?.text).toMatch(/^WS Proj on \S+$/)
    db.close()
  })
})

// ── every start path, through the real registry ──────────────────────

const sends = new Map<string, string[]>()
const ctxs = new Map<string, DriverCtx>()
const boot = { fail: false }
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        if (boot.fail) throw new Error('claude is not installed')
        const id = ctx.session.id
        ctxs.set(id, ctx)
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

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let projectId: string
let quietId: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-preamble-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  registry.checkpoints = { ensure: async () => {} } as unknown as CheckpointStore
  store.insertWorkspace(ws('w', root))
  store.setWorkspacePreamble('w', '- Work in `{{worktree}}` for {{project}} on {{host}}.\n- Never touch prod.', true)
  projectId = 'proj1'
  store.insertProject({ id: projectId, workspaceId: 'w', name: 'Rail', mode: 'local', branch: null, cwd: root, archived: false, createdAt: 1 })
  quietId = 'proj2'
  store.insertProject({ id: quietId, workspaceId: 'w', name: 'Quiet', mode: 'local', branch: null, cwd: root, archived: false, createdAt: 1 })
  store.setProjectPreamble(quietId, null, false)
  setOrchestrationRegistry(registry)
  sends.clear()
  ctxs.clear()
  boot.fail = false
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const firstUser = (id: string): (AgentEvent & { type: 'user-text' }) | undefined =>
  registry.eventsAfter(id, 0).map((r) => r.event).find((e): e is AgentEvent & { type: 'user-text' } => e.type === 'user-text')

const harnessText = (id: string): string => sends.get(id)?.[0] ?? ''

/** The block the harness read, and the stamp the row shows, agree. */
function expectCarried(id: string, task: string, stamp: PreambleStamp): void {
  const row = firstUser(id)
  expect(row?.text).toBe(task)
  expect(row?.preamble).toEqual(stamp)
  const seen = harnessText(id)
  expect(seen).toContain(`${PREAMBLE_HEADING}\n\n${stamp.text}\n\n${TASK_HEADING}\n\n${task}`)
  // The rules sit after the thread instructions and the project context,
  // right before the task, so the brief reads as one message.
  expect(seen.indexOf(PREAMBLE_HEADING)).toBeGreaterThan(seen.indexOf('</thread-instructions>'))
  expect(seen.endsWith(task)).toBe(true)
}

describe('the preamble rides the first message on every start path', () => {
  it('the composer: session.create then session.send, with the slug from the title', async () => {
    const s = await registry.create({ projectId, provider: 'claude', title: 'Fix the rail paint' })
    await registry.send(s.id, 'go')
    expectCarried(s.id, 'go', {
      text: `- Work in \`fix-the-rail-paint\` for Rail on ${hostname()}.\n- Never touch prod.`,
      words: 12
    })
    // The second message carries nothing: the rules rode the first.
    await registry.send(s.id, 'more')
    expect(sends.get(s.id)?.[1]).toBe('more')
    const users = registry.eventsAfter(s.id, 0).map((r) => r.event).filter((e) => e.type === 'user-text')
    expect(users[1]).not.toHaveProperty('preamble')
  })
  it('an untitled thread takes its slug from the first line of the message', async () => {
    const s = await registry.create({ projectId, provider: 'claude' })
    await registry.send(s.id, 'Rework the composer bar\n\nDetails follow.')
    expect(firstUser(s.id)?.preamble?.text).toContain('`rework-the-composer-bar`')
    expect(registry.get(s.id)?.title).toBe('Rework the composer bar')
  })
  it('plan → implementation: the plan seed and the rules both ride, rules nearest the task', async () => {
    const s = await registry.create({ projectId, provider: 'claude', threadType: 'implementation', planPath: join(root, 'plan.md'), title: 'Build it' })
    await registry.send(s.id, 'Implement the plan')
    const row = firstUser(s.id)
    expect(row?.preamble?.text).toContain('`build-it`')
    const seen = harnessText(s.id)
    expect(seen).toContain('<thread-instructions>')
    expect(seen.indexOf(PREAMBLE_HEADING)).toBeGreaterThan(seen.indexOf('</thread-instructions>'))
    expect(seen.endsWith(`${TASK_HEADING}\n\nImplement the plan`)).toBe(true)
  })
  it('app_start_thread: a thread the caller starts in its project carries it', async () => {
    const caller = await registry.create({ projectId, provider: 'claude', title: 'Caller' })
    const result = await appStartThread(registry, registry.get(caller.id)!, {
      threadType: 'chat',
      provider: 'claude',
      firstMessage: 'Kick off the next piece',
      title: 'Next piece'
    })
    expect(typeof result).toBe('object')
    const id = (result as { threadId: string }).threadId
    expectCarried(id, 'Kick off the next piece', {
      text: `- Work in \`next-piece\` for Rail on ${hostname()}.\n- Never touch prod.`,
      words: 12
    })
  })
  it('spawn_agent: a child of a thread that carried it gets it too, with its own slug', async () => {
    const parent = await registry.create({ projectId, provider: 'claude', title: 'Parent', permission: 'auto' })
    await registry.send(parent.id, 'orchestrate')
    const out = await orchSpawnAgent(registry.get(parent.id)!, { task: 'Child task here\nmore', useWorktree: false, model: 'claude-sonnet-5-5' })
    expect(out).not.toMatch(/^refused/)
    const { agentId } = JSON.parse(out) as { agentId: string }
    const row = firstUser(agentId)
    expect(row?.text).toBe('Child task here\nmore')
    expect(row?.preamble?.text).toContain('`child-task-here`')
    expect(harnessText(agentId)).toContain(`${PREAMBLE_HEADING}\n\n- Work in \`child-task-here\``)
  })
  it('spawn_agent with preamble: false starts the child without it', async () => {
    const parent = await registry.create({ projectId, provider: 'claude', title: 'Parent', permission: 'auto' })
    await registry.send(parent.id, 'orchestrate')
    const out = await orchSpawnAgent(registry.get(parent.id)!, { task: 'Bare child', useWorktree: false, model: 'claude-sonnet-5-5', preamble: false })
    const { agentId } = JSON.parse(out) as { agentId: string }
    expect(firstUser(agentId)).not.toHaveProperty('preamble')
    expect(harnessText(agentId).endsWith('Bare child')).toBe(true)
    expect(harnessText(agentId)).not.toContain(PREAMBLE_HEADING)
  })
  it('a child of a parent that opened without the rules opens without them too', async () => {
    const parent = await registry.create({ projectId, provider: 'claude', title: 'Old parent' })
    await registry.send(parent.id, 'started before the rules', { preamble: false })
    expect(firstUser(parent.id)).not.toHaveProperty('preamble')
    const out = await orchSpawnAgent(registry.get(parent.id)!, { task: 'Child', useWorktree: false, model: 'claude-sonnet-5-5' })
    const { agentId } = JSON.parse(out) as { agentId: string }
    expect(firstUser(agentId)).not.toHaveProperty('preamble')
  })
  it('the phone: a titled thread created and then sent carries it like the composer', async () => {
    const s = await registry.create({ projectId, provider: 'claude', title: 'From the phone' })
    await registry.send(s.id, 'phone task')
    expect(firstUser(s.id)?.preamble?.text).toContain('`from-the-phone`')
    expect(harnessText(s.id)).toContain(PREAMBLE_HEADING)
  })
  it('cross-host thread.start and thread.spawn on this host carry it; the spawn honours the opt-out', async () => {
    const BOX = `env_${'b'.repeat(22)}`
    const settings = new Map<string, string>()
    const svc = new CrossHostThreads({
      environmentId: `env_${'m'.repeat(22)}`,
      store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
      registry,
      environments: () => [{ id: BOX, name: 'box' }],
      link: () => null,
      pathMap: () => ({ roots: {}, prefixes: {} }),
      workRoot: () => root,
      log: () => {}
    })
    const caller = { environmentId: BOX, sessionId: 'box-thread', title: 'Box thread', permission: 'auto' as const }
    const ctx = { from: BOX, deadlineAt: Date.now() + 60_000 }
    const started = (await svc.handle(
      'thread.start',
      { caller, args: { threadType: 'chat', provider: 'claude', firstMessage: 'from the box', title: 'Mac side', cwd: root } },
      ctx
    )) as { sessionId: string; projectId: string | null }
    expect(started.projectId).toBe(projectId)
    expect(firstUser(started.sessionId)?.preamble?.text).toContain('`mac-side`')
    expect(harnessText(started.sessionId)).toContain(PREAMBLE_HEADING)
    const spawnArgs = { provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoning: 'medium' as const, context1m: false, agentType: 'explorer' as const, task: 'look around', title: 'Look', useWorktree: false, cwd: root }
    // The box parent is unknown here, so the child follows the project.
    const child = (await svc.handle('thread.spawn', { caller, args: spawnArgs }, ctx)) as { sessionId: string }
    expect(firstUser(child.sessionId)?.preamble?.text).toContain('`look`')
    const bare = (await svc.handle('thread.spawn', { caller, args: { ...spawnArgs, preamble: false } }, ctx)) as { sessionId: string }
    expect(firstUser(bare.sessionId)).not.toHaveProperty('preamble')
  })
  it('a project switched off, and a thread outside any project, open plain', async () => {
    const q = await registry.create({ projectId: quietId, provider: 'claude', title: 'Quiet one' })
    await registry.send(q.id, 'quiet')
    expect(firstUser(q.id)).not.toHaveProperty('preamble')
    expect(harnessText(q.id).endsWith('quiet')).toBe(true)
    const loose = await registry.create({ cwd: root, provider: 'claude', title: 'Loose' })
    await registry.send(loose.id, 'loose')
    expect(firstUser(loose.id)).not.toHaveProperty('preamble')
  })
  it('editing the preamble reaches new threads only; a started thread keeps its text', async () => {
    const a = await registry.create({ projectId, provider: 'claude', title: 'Before' })
    await registry.send(a.id, 'first')
    const before = firstUser(a.id)?.preamble
    registry.setProjectPreamble(projectId, 'NEW RULES for {{project}}', true)
    expect(store.getProject(projectId)?.preamble).toBe('NEW RULES for {{project}}')
    await registry.send(a.id, 'second')
    expect(firstUser(a.id)?.preamble).toEqual(before)
    expect(store.firstUserPreamble(a.id)).toEqual(before)
    const b = await registry.create({ projectId, provider: 'claude', title: 'After' })
    await registry.send(b.id, 'fresh')
    expect(firstUser(b.id)?.preamble).toEqual({ text: 'NEW RULES for Rail', words: 4 })
    // Switching the project off keeps the text for later.
    registry.setProjectPreamble(projectId, 'NEW RULES for {{project}}', false)
    expect(store.getProject(projectId)).toMatchObject({ preamble: 'NEW RULES for {{project}}', preambleEnabled: false })
  })
  it('a first message held back by a failed boot reaches the harness with the same block its row shows', async () => {
    boot.fail = true
    const s = await registry.create({ projectId, provider: 'claude', title: 'Held' })
    await registry.send(s.id, 'held task')
    const stamp = firstUser(s.id)?.preamble
    expect(stamp?.text).toContain('`held`')
    expect(sends.get(s.id)).toBeUndefined()
    boot.fail = false
    await registry.send(s.id, 'nudge')
    // The nudge's turn settles; the held message drains behind it.
    ctxs.get(s.id)!.emit({ type: 'status', status: 'idle' })
    await new Promise((r) => setTimeout(r, 50))
    const seen = sends.get(s.id) ?? []
    expect(seen.some((t) => t.includes(`${PREAMBLE_HEADING}\n\n${stamp!.text}\n\n${TASK_HEADING}\n\nheld task`))).toBe(true)
    const users = registry.eventsAfter(s.id, 0).map((r) => r.event).filter((e) => e.type === 'user-text')
    expect(users).toHaveLength(2)
  })
})
