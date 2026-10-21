import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { SessionMoveResult } from '@shared/contract-session-move'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { claudeSlug, landingCandidates, setMovingTo, type MoveHost } from './sessionMove'
import { SessionMover, handleSessionMove } from './remote/sessionMover'
import type { PeerLink } from './remote/peers'

const MAC = 'env_mac'
const BOX = 'env_box'
const ROOT = 'thread-root'
const CHILD = 'thread-child'
const CODEX_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

type Faults = {
  /** Corrupt the payload of this part index on its way to the receiver. */
  corruptPart?: number
  /** Methods whose answer is lost: the call runs on the far side, then the caller hears a timeout. */
  loseAnswer?: Set<string>
  /** Methods that never arrive. */
  drop?: Set<string>
}

interface Host {
  env: string
  dir: string
  home: string
  work: string
  data: string
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  mover: SessionMover
  moved: { id: string; ids: string[]; to: string }[]
  removed: string[][]
  metas: string[]
}

let T: string
let mac: Host
let box: Host
const faults: Faults = {}

function makeHost(env: string, name: string, work: (home: string) => string, peer: () => Host): Host {
  const dir = join(T, name)
  const home = join(dir, 'home')
  const data = join(dir, 'data')
  mkdirSync(home, { recursive: true })
  mkdirSync(data, { recursive: true })
  const db = openDb(join(data, 'temp-code.db'))
  const store = new Store(db)
  const registry = new SessionRegistry(store)
  const workRoot = work(home)
  mkdirSync(workRoot, { recursive: true })
  const host: MoveHost = {
    db,
    environmentId: env,
    dataDir: data,
    home: () => home,
    workRoot: () => workRoot,
    pathMap: () => ({ roots: {}, prefixes: {} }),
    claudeDir: () => join(home, '.claude'),
    codexDir: () => join(home, '.codex'),
    gitDirty: async () => (env === MAC ? ['src/dirty.ts', 'notes.md'] : []),
    forget: (ids) => store.forgetSessions(ids)
  }
  /** The peer link: every request crosses as JSON, through the contract's zod, into the other host's dispatch. */
  const link = {
    get env() {
      return { id: peer().env, name: peer().env === BOX ? 'box' : 'mac', routes: [] }
    },
    connected: true,
    async request<T>(method: string, params: unknown): Promise<T> {
      if (faults.drop?.has(method)) throw new Error(`${method} timed out`)
      let wire = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
      if (method === 'session.import.part' && wire.index === faults.corruptPart) {
        const part = wire.part as { kind: string; rows?: { payload: string }[] }
        if (part.kind === 'events' && part.rows?.length) part.rows[0].payload = part.rows[0].payload + ' '
        wire = { ...wire, part }
      }
      const req = ClientRequestSchema.parse({ id: 'x', method, params: wire })
      const out = await handleSessionMove(req, peer().mover)
      if (!out.handled) throw new Error(`unhandled ${method}`)
      if (faults.loseAnswer?.has(method)) throw new Error(`${method} timed out`)
      return JSON.parse(JSON.stringify(out.result ?? null)) as T
    }
  } as unknown as PeerLink
  const mover = new SessionMover({
    host,
    registry,
    peers: { get: (id: string) => (id === peer().env ? link : undefined), all: () => [link] },
    flush: () => store.flushEvents(),
    log: () => {}
  })
  const h: Host = { env, dir, home, work: workRoot, data, db, store, registry, mover, moved: [], removed: [], metas: [] }
  registry.onMoved((id, ids, to) => h.moved.push({ id, ids, to }))
  registry.onRemoved((ids) => h.removed.push(ids))
  registry.onMeta((m) => h.metas.push(m.id))
  return h
}

const meta = (over: Partial<SessionMeta> & { id: string; cwd: string }): SessionMeta => ({
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: null,
  planPath: null,
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'medium',
  agentType: 'implementer',
  title: over.id,
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  permission: 'edits',
  nativeId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

const put = (path: string, body: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

const macProject = (): string => join(mac.home, 'IdeaProjects', 'shop')
const boxProject = (): string => join(box.work, 'shop')
const BIG = randomBytes(5 * 1024 * 1024 + 11)
const LONG = 'x'.repeat(2_500_000)

/** The Mac's thread: a claude root with a codex subagent, events in both tiers, a fold, a page, both transcripts, a checkpoint. */
function seedMac(opts: { transcript?: boolean } = {}): void {
  mkdirSync(join(macProject(), '.temp-code', 'plans'), { recursive: true })
  mac.store.insertWorkspace({ id: 'ws-mac', name: 'shop', path: macProject(), git: true, createdAt: 1 })
  mac.store.insertProject({ id: 'proj-mac', workspaceId: 'ws-mac', name: 'shop', mode: 'local', branch: null, cwd: macProject(), createdAt: 1 })
  mac.store.insertSession(
    meta({ id: ROOT, cwd: macProject(), projectId: 'proj-mac', workspaceId: 'ws-mac', nativeId: 'claude-native-1', planPath: join(macProject(), '.temp-code', 'plans', 'p.md'), threadType: 'planning' })
  )
  mac.store.insertSession(meta({ id: CHILD, parentId: ROOT, cwd: macProject(), projectId: 'proj-mac', provider: 'codex', model: 'gpt-6.1-sol', nativeId: CODEX_ID, createdAt: 2 }))
  const events: AgentEvent[] = [
    { type: 'user-text', text: 'what is the plan?' },
    { type: 'assistant-text', text: LONG, delta: false },
    ...Array.from({ length: 50 }, (_, i): AgentEvent => ({ type: 'assistant-text', text: `step ${i}`, delta: false })),
    { type: 'turn-complete', costUsd: 0.01 }
  ]
  for (const e of events) mac.store.appendEvent(ROOT, e)
  for (const e of [{ type: 'user-text', text: 'sub task' }, { type: 'assistant-text', text: 'done', delta: false }] as AgentEvent[]) mac.store.appendEvent(CHILD, e)
  mac.store.flushEvents()
  mac.store.moveToCold(CHILD) // the child's log sits in the cold file
  mac.store.putFold({ sessionId: ROOT, foldedSeq: 53, foldVersion: 1, tasks: { done: 1, total: 3, current: 'ship' }, goal: null, canContinue: false })
  put(join(mac.data, 'html-renders', ROOT, 'page-1.html'), '<h1>report</h1>')
  if (opts.transcript !== false) {
    const dir = join(mac.home, '.claude', 'projects', claudeSlug(macProject()))
    put(join(dir, 'claude-native-1.jsonl'), `{"cwd":"${macProject()}"}\n`)
    put(join(dir, 'claude-native-1', 'subagents', 'a.jsonl'), '{"sub":1}\n')
    put(join(mac.home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T01-02-03-${CODEX_ID}.jsonl`), BIG)
  }
  put(join(mac.data, 'checkpoints', ROOT, 'manifest.json'), '{}')
}

function seedBox(opts: { workspace?: boolean; dir?: boolean } = {}): void {
  if (opts.dir !== false) mkdirSync(boxProject(), { recursive: true })
  if (opts.workspace !== false) {
    box.store.insertWorkspace({ id: 'ws-box', name: 'shop', path: boxProject(), git: true, createdAt: 1 })
    box.store.insertProject({ id: 'proj-box', workspaceId: 'ws-box', name: 'shop', mode: 'local', branch: null, cwd: boxProject(), createdAt: 1 })
  }
}

const raw = (h: Host, id: string): Record<string, unknown> | undefined => h.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined
const eventCount = (h: Host, id: string): number => {
  const c = h.store.eventCounts(id)
  return c.hot + c.cold
}

beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'tc-session-move-')))
  mac = makeHost(MAC, 'mac', (home) => home, () => box)
  box = makeHost(BOX, 'box', () => join(T, 'box', 'work'), () => mac)
  faults.corruptPart = undefined
  faults.loseAnswer = undefined
  faults.drop = undefined
})

afterEach(async () => {
  mac.mover.close()
  box.mover.close()
  await mac.registry.disposeAll()
  await box.registry.disposeAll()
  mac.db.close()
  box.db.close()
  rmSync(T, { recursive: true, force: true })
})

describe('landingCandidates', () => {
  const MAP = {
    roots: { '/Users/landon/IdeaProjects/temp-code': '/srv/agents/work/temp-code' },
    prefixes: { '/Users/landon/.temp-code/worktrees': '/srv/agents/home/.temp-code/worktrees', '/Users/landon': '/srv/agents/home' }
  }
  const toBox = { map: MAP, senderHome: '/Users/landon', senderWork: '/Users/landon', home: '/srv/agents/home', work: '/srv/agents/work' }
  const toMac = { map: MAP, senderHome: '/srv/agents/home', senderWork: '/srv/agents/work', home: '/Users/landon', work: '/Users/landon' }
  it('maps Mac paths onto the box: a root, IdeaProjects and Desktop/Websites under the work root, then the home', () => {
    expect(landingCandidates('/Users/landon/IdeaProjects/temp-code/src', toBox)[0]).toBe('/srv/agents/work/temp-code/src')
    expect(landingCandidates('/Users/landon/Desktop/Websites/site', toBox)[0]).toBe('/srv/agents/work/site')
    expect(landingCandidates('/Users/landon/.temp-code/worktrees/x', toBox)[0]).toBe('/srv/agents/home/.temp-code/worktrees/x')
    expect(landingCandidates('/Users/landon/notes', toBox)[0]).toBe('/srv/agents/home/notes')
  })
  it('maps box paths back: the map inverted, the work root to either Mac dir', () => {
    expect(landingCandidates('/srv/agents/work/temp-code', toMac)[0]).toBe('/Users/landon/IdeaProjects/temp-code')
    expect(landingCandidates('/srv/agents/work/site', toMac)).toEqual(['/Users/landon/IdeaProjects/site', '/Users/landon/Desktop/Websites/site'])
    expect(landingCandidates('/srv/agents/home/x', toMac)[0]).toBe('/Users/landon/x')
  })
  it('leaves a path no rule covers, and a relative one, as it is', () => {
    expect(landingCandidates('/opt/thing', toBox)).toEqual(['/opt/thing'])
    expect(landingCandidates('.temp-code/plans/p.md', toBox)).toEqual(['.temp-code/plans/p.md'])
  })
})

describe('moving a thread', () => {
  it('Mac → box: every part lands remapped, the Mac keeps a tombstone, and back again', async () => {
    seedMac()
    seedBox()
    const before = mac.store.eventCounts(ROOT).hot
    const out: SessionMoveResult = await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(out).toMatchObject({ sessionId: ROOT, sessionIds: [ROOT, CHILD], from: MAC, to: BOX, transcript: 'moved', checkpointsStayed: true, dirty: ['src/dirty.ts', 'notes.md'] })
    expect(out.events).toBe(before + 2)

    // The box: rows visible, remapped, resolved to its own workspace and project.
    const landed = box.store.getSession(ROOT)!
    expect(landed.cwd).toBe(boxProject())
    expect(landed.workspaceId).toBe('ws-box')
    expect(landed.projectId).toBe('proj-box')
    expect(landed.planPath).toBe(join(boxProject(), '.temp-code', 'plans', 'p.md'))
    expect(landed.nativeId).toBe('claude-native-1')
    expect(box.store.getSession(CHILD)?.parentId).toBe(ROOT)
    expect(eventCount(box, ROOT)).toBe(before)
    expect(eventCount(box, CHILD)).toBe(2)
    expect(box.store.eventsAfter(ROOT, 0).find((r) => r.seq === 2)?.event).toMatchObject({ text: LONG })
    expect(box.store.getFold(ROOT)?.tasks).toEqual({ done: 1, total: 3, current: 'ship' })
    expect(box.registry.foldOf(ROOT)?.tasks?.total).toBe(3)
    expect(readFileSync(join(box.data, 'html-renders', ROOT, 'page-1.html'), 'utf8')).toBe('<h1>report</h1>')
    const boxClaude = join(box.home, '.claude', 'projects', claudeSlug(boxProject()))
    expect(existsSync(join(boxClaude, 'claude-native-1.jsonl'))).toBe(true)
    expect(existsSync(join(boxClaude, 'claude-native-1', 'subagents', 'a.jsonl'))).toBe(true)
    expect(sha(readFileSync(join(box.home, '.codex', 'sessions', '2026', '10', '20', `rollout-2026-10-20T01-02-03-${CODEX_ID}.jsonl`)))).toBe(sha(BIG))
    expect(existsSync(join(box.data, 'checkpoints', ROOT))).toBe(false)
    expect(box.metas).toContain(ROOT)
    expect(raw(box, ROOT)).toMatchObject({ moving_from: null, moved_to: null, move_id: null })

    // The Mac: a tombstone, nothing else; clients heard where it went before it was removed.
    expect(mac.store.getSession(ROOT)).toBeNull()
    expect(mac.registry.list({ archived: true }).some((s) => s.id === ROOT)).toBe(false)
    expect(raw(mac, ROOT)).toMatchObject({ moved_to: BOX, archived: 1, moving_to: null })
    expect(raw(mac, CHILD)).toMatchObject({ moved_to: BOX })
    expect(eventCount(mac, ROOT) + eventCount(mac, CHILD)).toBe(0)
    expect(mac.store.getFold(ROOT)).toBeNull()
    expect(existsSync(join(mac.data, 'html-renders', ROOT))).toBe(false)
    expect(existsSync(join(mac.data, 'checkpoints', ROOT))).toBe(true)
    expect(mac.moved).toEqual([{ id: ROOT, ids: [ROOT, CHILD], to: BOX }])
    expect(mac.removed).toEqual([[ROOT, CHILD]])

    // Box → Mac: the pull lands it where it started.
    const back = await mac.mover.move({ sessionId: ROOT, from: BOX, to: MAC })
    expect(back).toMatchObject({ from: BOX, to: MAC, transcript: 'moved', dirty: [], checkpointsStayed: false })
    const home = mac.store.getSession(ROOT)!
    expect(home.cwd).toBe(macProject())
    expect(home.workspaceId).toBe('ws-mac')
    expect(home.projectId).toBe('proj-mac')
    expect(home.planPath).toBe(join(macProject(), '.temp-code', 'plans', 'p.md'))
    expect(eventCount(mac, ROOT)).toBe(before)
    expect(eventCount(mac, CHILD)).toBe(2)
    expect(mac.registry.foldOf(ROOT)?.tasks?.done).toBe(1)
    expect(readFileSync(join(mac.data, 'html-renders', ROOT, 'page-1.html'), 'utf8')).toBe('<h1>report</h1>')
    expect(raw(box, ROOT)).toMatchObject({ moved_to: MAC, archived: 1 })
    expect(eventCount(box, ROOT)).toBe(0)
    expect(box.moved).toEqual([{ id: ROOT, ids: [ROOT, CHILD], to: MAC }])
    // A new row appends after the moved log, not over it.
    const row = mac.store.appendEvent(ROOT, { type: 'user-text', text: 'after the move' })
    expect(row.seq).toBe(before + 1)
  })

  it('a thread whose transcript is missing lands with no native id, so its next send replays the dialogue', async () => {
    seedMac({ transcript: false })
    seedBox()
    const out = await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(out.transcript).toBe('missing')
    expect(box.store.getSession(ROOT)?.nativeId).toBeNull()
    expect(box.store.getSession(CHILD)?.nativeId).toBeNull()
  })

  it('refuses a thread that is not at rest, and a frozen thread takes no input', async () => {
    seedMac()
    seedBox()
    mac.store.updateSession(CHILD, { status: 'running' })
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/subagent .* is working/)
    mac.store.updateSession(CHILD, { status: 'idle' })
    mac.store.updateSession(ROOT, { status: 'paused' })
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/paused/)
    mac.store.updateSession(ROOT, { status: 'idle' })
    await expect(mac.mover.move({ sessionId: CHILD, to: BOX })).rejects.toThrow(/moves with its thread/)
    setMovingTo(mac.db, [ROOT], BOX, 'm1')
    await expect(mac.registry.send(ROOT, 'hello')).rejects.toThrow(/moving to another host/)
    expect(() => mac.registry.queueAdd(ROOT, 'later')).toThrow(/moving to another host/)
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/already moving/)
  })

  it('refuses when no workspace on the destination holds the cwd, or the cwd is missing; the source stays whole', async () => {
    seedMac()
    seedBox({ workspace: false })
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/no workspace on this host holds .*shop/)
    expect(raw(mac, ROOT)).toMatchObject({ moving_to: null, moved_to: null })
    expect(raw(box, ROOT)).toBeUndefined()
    rmSync(boxProject(), { recursive: true })
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/does not exist on this host/)
    expect(mac.store.getSession(ROOT)?.cwd).toBe(macProject())
    // A thread the destination already holds live.
    seedBox()
    box.store.insertSession(meta({ id: ROOT, cwd: boxProject() }))
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/already on this host/)
    expect(box.store.getSession(ROOT)?.title).toBe(ROOT)
    expect(raw(mac, ROOT)).toMatchObject({ moving_to: null, moved_to: null })
  })

  it('a corrupted part is refused on arrival; nothing lands and the source thaws', async () => {
    seedMac()
    seedBox()
    faults.corruptPart = 0
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/does not match its digest/)
    expect(raw(box, ROOT)).toBeUndefined()
    expect(raw(mac, ROOT)).toMatchObject({ moving_to: null, moved_to: null })
    expect(eventCount(mac, ROOT)).toBeGreaterThan(50)
  })
})

describe('settling a half-done move on link-up', () => {
  it('a lost release: the box holds the landing hidden until the settle claims it', async () => {
    seedMac()
    seedBox()
    faults.drop = new Set(['session.import.release'])
    const out = await mac.mover.move({ sessionId: ROOT, to: BOX })
    expect(out.pendingRelease).toBe(true)
    expect(box.store.getSession(ROOT)).toBeNull()
    expect(raw(box, ROOT)).toMatchObject({ moving_from: MAC })
    faults.drop = undefined
    await mac.mover.settleWith(BOX)
    expect(box.store.getSession(ROOT)?.cwd).toBe(boxProject())
    expect(raw(box, CHILD)).toMatchObject({ moving_from: null })
  })

  it('a lost commit answer and a lost abort: the source is live, so the settle drops the landing', async () => {
    seedMac()
    seedBox()
    faults.loseAnswer = new Set(['session.import.commit'])
    faults.drop = new Set(['session.import.abort'])
    await expect(mac.mover.move({ sessionId: ROOT, to: BOX })).rejects.toThrow(/timed out/)
    expect(mac.store.getSession(ROOT)?.cwd).toBe(macProject())
    expect(raw(mac, ROOT)).toMatchObject({ moving_to: null })
    expect(raw(box, ROOT)).toMatchObject({ moving_from: MAC })
    faults.loseAnswer = undefined
    faults.drop = undefined
    await mac.mover.settleWith(BOX)
    expect(raw(box, ROOT)).toBeUndefined()
    expect(eventCount(box, ROOT)).toBe(0)
    expect(existsSync(join(box.data, 'html-renders', ROOT))).toBe(false)
  })

  it('a pull whose export commit answer is lost: the box kept a tombstone, so the settle claims the Mac\'s landing', async () => {
    seedMac()
    seedBox()
    await mac.mover.move({ sessionId: ROOT, to: BOX })
    faults.loseAnswer = new Set(['session.export.commit'])
    faults.drop = new Set(['session.move.status'])
    await expect(mac.mover.move({ sessionId: ROOT, from: BOX, to: MAC })).rejects.toThrow(/settles when/)
    expect(raw(box, ROOT)).toMatchObject({ moved_to: MAC })
    expect(raw(mac, ROOT)).toMatchObject({ moving_from: BOX })
    expect(mac.store.getSession(ROOT)).toBeNull()
    faults.loseAnswer = undefined
    faults.drop = undefined
    await mac.mover.settleWith(BOX)
    expect(mac.store.getSession(ROOT)?.cwd).toBe(macProject())
    expect(mac.metas).toContain(ROOT)
  })

  it('a pull the box froze but never finished: the settle lifts the freeze there and drops the Mac\'s partial landing', async () => {
    seedMac()
    seedBox()
    await mac.mover.move({ sessionId: ROOT, to: BOX })
    faults.drop = new Set(['session.export.part', 'session.export.abort'])
    await expect(mac.mover.move({ sessionId: ROOT, from: BOX, to: MAC })).rejects.toThrow(/timed out/)
    expect(raw(box, ROOT)).toMatchObject({ moving_to: MAC })
    // The landing replaced the Mac's tombstone and went with the failure: the box holds the only copy.
    expect(raw(mac, ROOT)).toBeUndefined()
    faults.drop = undefined
    await mac.mover.settleWith(BOX)
    expect(raw(box, ROOT)).toMatchObject({ moving_to: null })
    expect(box.store.getSession(ROOT)?.cwd).toBe(boxProject())
  })

  it('a freeze left by a process that quit lifts at boot', () => {
    seedMac()
    setMovingTo(mac.db, [ROOT, CHILD], BOX, 'm1')
    expect(mac.mover.thawStale()).toBe(2)
    expect(raw(mac, ROOT)).toMatchObject({ moving_to: null, move_id: null })
  })
})
