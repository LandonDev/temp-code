import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { requiredCapability } from '@shared/capabilities'
import { parseMapping } from '../pathMap'
import { MemorySync, handleMemory } from './memorySync'
import { encodeProjectDir } from './memorySet'
import { TOMBSTONE_MS } from './memoryMerge'

let root: string
let mac: string
let box: string
let work: string
const put = (home: string, rel: string, body: string | Buffer, mtime?: number): void => {
  mkdirSync(dirname(join(home, rel)), { recursive: true })
  writeFileSync(join(home, rel), body)
  if (mtime !== undefined) utimesSync(join(home, rel), new Date(mtime), new Date(mtime))
}
const read = (home: string, rel: string): string => readFileSync(join(home, rel), 'utf8')
const has = (home: string, rel: string): boolean => existsSync(join(home, rel))
const mtimeOf = (home: string, rel: string): number => Math.floor(statSync(join(home, rel)).mtimeMs)
const walk = (dir: string, base = dir): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)])) : []

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-memsync-')))
  mac = join(root, 'mac-home')
  box = join(root, 'box-home')
  work = join(root, 'work')
  for (const d of [mac, box, work]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const store = () => {
  const rows: Record<string, string> = {}
  return {
    rows,
    getSetting: (key: string) => rows[key] ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) delete rows[key]
      else rows[key] = value
    }
  }
}

/** The Mac's project dir name for IdeaProjects/shop, and the box's for the same checkout under its work root. */
const MAC_SHOP = () => encodeProjectDir(join(mac, 'IdeaProjects/shop'))
const BOX_SHOP = () => encodeProjectDir(join(work, 'shop'))
const macMem = (file: string): string => `.claude/projects/${MAC_SHOP()}/memory/${file}`
const boxMem = (file: string): string => `.claude/projects/${BOX_SHOP()}/memory/${file}`

/**
 * The Mac's MemorySync (the driver: it holds the link) and the box's (the
 * receiver), joined by a link that round-trips every request through JSON
 * and the contract's schema before the box's dispatch answers it. The
 * shipped-style map is the Mac's IdeaProjects/shop → the box's work/shop;
 * the box reads it forward, the Mac backward.
 */
function pair(opts: { now?: () => number } = {}) {
  const mapping = parseMapping(JSON.stringify({ roots: { [join(mac, 'IdeaProjects/shop')]: join(work, 'shop') }, prefixes: {} }))
  const boxLog: string[] = []
  const macLog: string[] = []
  const sent: { method: string; params: unknown }[] = []
  const boxStore = store()
  const now = opts.now ?? (() => Date.now())
  const receiver = new MemorySync({
    environmentId: 'env_box',
    store: boxStore,
    peers: { get: () => undefined, all: () => [] },
    dataDir: join(root, 'box-data'),
    pathMap: () => mapping,
    home: () => box,
    workRoot: () => work,
    hostName: () => 'box',
    log: (l) => boxLog.push(l),
    now
  })
  let seq = 0
  const link = {
    id: 'env_box',
    env: { name: 'box' },
    connected: true,
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      sent.push({ method, params })
      const req = ClientRequestSchema.parse(JSON.parse(JSON.stringify({ id: `r${++seq}`, method, params })))
      expect(requiredCapability(req)).toBe('admin')
      const out = await handleMemory(req, receiver)
      if (!out.handled) throw new Error(`unhandled ${method}`)
      return JSON.parse(JSON.stringify(out.result ?? null)) as T
    }
  }
  const macStore = store()
  const nudged: unknown[] = []
  const sender = new MemorySync({
    environmentId: 'env_mac',
    store: macStore,
    peers: { get: (id: string) => (id === 'env_box' ? (link as never) : undefined), all: () => [link as never] },
    dataDir: join(root, 'mac-data'),
    pathMap: () => mapping,
    home: () => mac,
    workRoot: () => join(mac, 'IdeaProjects'),
    hostName: () => 'mac',
    nudgePeers: (f) => nudged.push(f),
    log: (l) => macLog.push(l),
    now
  })
  return { sender, receiver, link, sent, boxLog, macLog, boxStore, macStore, nudged, methods: () => sent.map((s) => s.method) }
}

function seedBoth(): void {
  put(mac, macMem('MEMORY.md'), `# Memory index\n\n- [Mac build](mac-build.md) — xcode lives at ${mac}/IdeaProjects/shop/build\n`, T0)
  put(mac, macMem('mac-build.md'), `---\nname: mac-build\n---\nBuild from ${mac}/IdeaProjects/shop with xcodebuild.\n`, T0)
  put(mac, '.claude/plans/sunny-otter.md', '# a plan', T0)
  put(mac, '.claude/CLAUDE.md', 'user rules from the mac', T0)
  put(mac, `.claude/projects/${MAC_SHOP()}/abc.jsonl`, '{"transcript":true}', T0)
  put(mac, macMem('leak.pem'), 'SECRET', T0)
  put(box, boxMem('MEMORY.md'), `# Memory index\n\n- [Box loop](box-loop.md) — vitest with NODE_ENV=test in ${work}/shop\n`, T0 + 1000)
  put(box, boxMem('box-loop.md'), `Run vitest in ${work}/shop with NODE_ENV=test.\n`, T0 + 1000)
  put(box, '.codex/memories/MEMORY.md', 'codex remembers the box', T0)
  put(box, '.codex/memories/.git/HEAD', 'ref: refs/heads/main', T0)
  put(box, '.codex/AGENTS.md', 'codex user rules', T0)
}

describe('the first sync', () => {
  it('lands each side\'s memory on the other, the project dir and the paths translated, MEMORY.md unioned; transcripts and secrets never cross', async () => {
    seedBoth()
    const { sender, receiver, sent } = pair()
    await sender.syncWith('env_box', 'link-up')
    // The Mac's memory on the box, under the box's project dir, its paths translated.
    expect(read(box, boxMem('mac-build.md'))).toBe(`---\nname: mac-build\n---\nBuild from ${work}/shop with xcodebuild.\n`)
    expect(mtimeOf(box, boxMem('mac-build.md'))).toBe(T0)
    expect(read(box, '.claude/plans/sunny-otter.md')).toBe('# a plan')
    expect(read(box, '.claude/CLAUDE.md')).toBe('user rules from the mac')
    // The box's memory on the Mac, under the Mac's project dir, its paths translated the other way.
    expect(read(mac, macMem('box-loop.md'))).toBe(`Run vitest in ${mac}/IdeaProjects/shop with NODE_ENV=test.\n`)
    expect(read(mac, '.codex/memories/MEMORY.md')).toBe('codex remembers the box')
    expect(read(mac, '.codex/AGENTS.md')).toBe('codex user rules')
    // One index, both lines, on both hosts, each in its own spelling.
    expect(read(box, boxMem('MEMORY.md'))).toBe(`# Memory index\n\n- [Box loop](box-loop.md) — vitest with NODE_ENV=test in ${work}/shop\n- [Mac build](mac-build.md) — xcode lives at ${work}/shop/build\n`)
    expect(read(mac, macMem('MEMORY.md'))).toBe(`# Memory index\n\n- [Box loop](box-loop.md) — vitest with NODE_ENV=test in ${mac}/IdeaProjects/shop\n- [Mac build](mac-build.md) — xcode lives at ${mac}/IdeaProjects/shop/build\n`)
    // Nothing else crossed.
    expect(walk(box).filter((r) => r.includes(MAC_SHOP()))).toEqual([])
    expect(walk(box).filter((r) => r.endsWith('.jsonl') || r.endsWith('.pem'))).toEqual([])
    expect(has(mac, '.codex/memories/.git/HEAD')).toBe(false)
    const exchange = sent.find((s) => s.method === 'memory.exchange')!.params as { entries: { relPath: string }[] }
    expect(exchange.entries.some((e) => e.relPath.endsWith('.pem') || e.relPath.endsWith('.jsonl'))).toBe(false)
    const status = sender.status()
    expect(status.environments[0]).toMatchObject({ name: 'box', files: 7, error: null, conflicts: 0 })
    expect(status.conflicts).toEqual([])
    expect(receiver.status().conflicts).toEqual([])
  })

  it('a second sync with nothing changed sends and writes nothing', async () => {
    seedBoth()
    const { sender, sent } = pair()
    await sender.syncWith('env_box')
    const before = walk(box).map((r) => [r, mtimeOf(box, r)])
    sent.length = 0
    await sender.syncWith('env_box')
    const exchange = sent.find((s) => s.method === 'memory.exchange')
    expect(exchange).toBeDefined()
    const files = sent.filter((s) => s.method === 'memory.files') as { params: { files: unknown[]; landed?: Record<string, string> } }[]
    expect(files.every((f) => f.params.files.length === 0)).toBe(true)
    expect(walk(box).map((r) => [r, mtimeOf(box, r)])).toEqual(before)
  })
})

describe('changes after the first sync', () => {
  it('an edit on either side crosses; a new file on either side crosses', async () => {
    seedBoth()
    const { sender } = pair()
    await sender.syncWith('env_box')
    put(box, boxMem('box-loop.md'), 'edited on the box\n', T0 + 5000)
    put(mac, macMem('mac-build.md'), 'edited on the mac\n', T0 + 5000)
    put(box, boxMem('new-on-box.md'), 'new on the box', T0 + 5000)
    put(mac, '.claude/plans/new-plan.md', 'new on the mac', T0 + 5000)
    await sender.syncWith('env_box', 'idle')
    expect(read(mac, macMem('box-loop.md'))).toBe('edited on the box\n')
    expect(read(box, boxMem('mac-build.md'))).toBe('edited on the mac\n')
    expect(read(mac, macMem('new-on-box.md'))).toBe('new on the box')
    expect(read(box, '.claude/plans/new-plan.md')).toBe('new on the mac')
    expect(sender.status().conflicts).toEqual([])
  })

  it('both edited since the last sync: the newer wins everywhere, the other is kept beside it on both hosts, and the status says so', async () => {
    seedBoth()
    const now = { t: T0 + 60_000 }
    const { sender, receiver } = pair({ now: () => now.t })
    await sender.syncWith('env_box')
    put(mac, macMem('mac-build.md'), 'the mac edit\n', T0 + 10_000)
    put(box, boxMem('mac-build.md'), 'the box edit, later\n', T0 + 20_000)
    await sender.syncWith('env_box')
    expect(read(mac, macMem('mac-build.md'))).toBe('the box edit, later\n')
    expect(read(box, boxMem('mac-build.md'))).toBe('the box edit, later\n')
    const copies = walk(box).filter((r) => r.includes('.conflict-'))
    expect(copies).toEqual([boxMem('mac-build.conflict-mac-20261021T120100.md')])
    expect(read(box, copies[0])).toBe('the mac edit\n')
    // The copy reached the Mac in the second round.
    expect(read(mac, macMem('mac-build.conflict-mac-20261021T120100.md'))).toBe('the mac edit\n')
    expect(sender.status().environments[0].conflicts).toBe(1)
    expect(sender.status().conflicts).toEqual([{ path: join(mac, macMem('mac-build.conflict-mac-20261021T120100.md')), of: macMem('mac-build.md'), host: 'mac', at: T0 + 60_000 }])
    expect(receiver.status().conflicts.map((c) => c.host)).toEqual(['mac'])
    // Settled: a third sync changes nothing.
    const before = walk(mac).map((r) => [r, mtimeOf(mac, r)])
    await sender.syncWith('env_box')
    expect(walk(mac).map((r) => [r, mtimeOf(mac, r)])).toEqual(before)
  })

  it('both added lines to MEMORY.md: one index with every line, on both hosts', async () => {
    seedBoth()
    const { sender } = pair()
    await sender.syncWith('env_box')
    put(mac, macMem('MEMORY.md'), read(mac, macMem('MEMORY.md')) + '- [Mac two](mac-two.md) — added on the mac\n', T0 + 10_000)
    put(mac, macMem('mac-two.md'), 'two', T0 + 10_000)
    put(box, boxMem('MEMORY.md'), read(box, boxMem('MEMORY.md')) + '- [Box two](box-two.md) — added on the box\n', T0 + 20_000)
    put(box, boxMem('box-two.md'), 'two', T0 + 20_000)
    await sender.syncWith('env_box')
    const lines = (t: string) => t.split('\n').filter((l) => l.startsWith('- ')).map((l) => /\]\(([^)]+)\)/.exec(l)![1])
    expect(lines(read(box, boxMem('MEMORY.md')))).toEqual(['box-loop.md', 'mac-build.md', 'mac-two.md', 'box-two.md'])
    expect(read(mac, macMem('MEMORY.md'))).toBe(read(box, boxMem('MEMORY.md')).replaceAll(`${work}/shop`, `${mac}/IdeaProjects/shop`))
    expect(walk(mac).filter((r) => r.includes('.conflict-'))).toEqual([])
    const before = walk(box).map((r) => [r, mtimeOf(box, r)])
    await sender.syncWith('env_box')
    expect(walk(box).map((r) => [r, mtimeOf(box, r)])).toEqual(before)
  })
})

describe('deletions', () => {
  it('a deletion on the Mac reaches the box, and one on the box reaches the Mac; the index drops the line of a memory gone from both', async () => {
    seedBoth()
    const { sender } = pair()
    await sender.syncWith('env_box')
    rmSync(join(mac, macMem('mac-build.md')))
    rmSync(join(box, boxMem('box-loop.md')))
    await sender.syncWith('env_box')
    expect(has(box, boxMem('mac-build.md'))).toBe(false)
    expect(has(mac, macMem('box-loop.md'))).toBe(false)
    expect(has(mac, macMem('MEMORY.md'))).toBe(true)
  })

  it('an edit after a deletion wins and brings the file back; an older edit the deletion beats is kept beside', async () => {
    seedBoth()
    const now = { t: T0 + 60_000 }
    const { sender } = pair({ now: () => now.t })
    await sender.syncWith('env_box')
    // The box deletes plans/sunny-otter at T0+60s (the dir's mtime); the Mac edited it later: it comes back.
    rmSync(join(box, '.claude/plans/sunny-otter.md'))
    utimesSync(join(box, '.claude/plans'), new Date(now.t), new Date(now.t))
    put(mac, '.claude/plans/sunny-otter.md', 'revised after the box deleted it', now.t + 5000)
    // The Mac deletes CLAUDE.md; the box edited it before that: the deletion wins, the edit is kept beside.
    put(box, '.claude/CLAUDE.md', 'box tweak', now.t - 5000)
    rmSync(join(mac, '.claude/CLAUDE.md'))
    utimesSync(join(mac, '.claude'), new Date(now.t), new Date(now.t))
    now.t += 10_000
    await sender.syncWith('env_box')
    expect(read(box, '.claude/plans/sunny-otter.md')).toBe('revised after the box deleted it')
    expect(has(box, '.claude/CLAUDE.md')).toBe(false)
    const copies = walk(box).filter((r) => r.includes('CLAUDE.conflict-'))
    expect(copies).toEqual(['.claude/CLAUDE.conflict-box-20261021T120110.md'])
    expect(read(box, copies[0])).toBe('box tweak')
    expect(read(mac, copies[0])).toBe('box tweak')
    // The deletion does not come back on the next sync.
    await sender.syncWith('env_box')
    expect(has(mac, '.claude/CLAUDE.md')).toBe(false)
    expect(has(box, '.claude/CLAUDE.md')).toBe(false)
  })

  it('a tombstone is forgotten after 30 days', async () => {
    seedBoth()
    const now = { t: T0 + 60_000 }
    const { sender } = pair({ now: () => now.t })
    await sender.syncWith('env_box')
    rmSync(join(mac, '.claude/plans/sunny-otter.md'))
    await sender.syncWith('env_box')
    const state = () => JSON.parse(readFileSync(join(root, 'mac-data/memory-sync/state.json'), 'utf8')) as { tombstones: Record<string, unknown> }
    expect(Object.keys(state().tombstones)).toEqual(['.claude/plans/sunny-otter.md'])
    now.t += TOMBSTONE_MS + 1000
    await sender.syncWith('env_box')
    expect(Object.keys(state().tombstones)).toEqual([])
  })
})

describe('triggers', () => {
  it('a thread settling idle syncs after a short quiet and nudges the hosts linked here; a nudge from the other side syncs', async () => {
    vi.useFakeTimers()
    try {
      const { sender, receiver, nudged, sent } = pair()
      const spy = vi.spyOn(sender, 'syncAll').mockResolvedValue()
      sender.onSessionMeta({ id: 's1', status: 'running' })
      sender.onSessionMeta({ id: 's1', status: 'idle' })
      sender.onSessionMeta({ id: 's2', status: 'idle' }) // never live: not a settle
      expect(spy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('idle')
      expect(nudged).toEqual([{ push: 'memory.nudge', from: 'env_mac' }])
      spy.mockRestore()
      expect(sender.onPeerPush('env_box', { push: 'memory.nudge', from: 'env_box' })).toBe(true)
      expect(sender.onPeerPush('env_box', { push: 'session-removed', sessionIds: [] })).toBe(false)
      await vi.advanceTimersByTimeAsync(3_100)
      expect(sent.some((s) => s.method === 'memory.exchange')).toBe(true)
      expect(receiver.status().environments).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sending off sends nothing; the receiver still answers', async () => {
    seedBoth()
    const { sender, sent, macStore } = pair()
    macStore.setSetting('memory.sync.enabled', 'false')
    await sender.syncWith('env_box')
    expect(sent).toEqual([])
    expect(sender.status().enabled).toBe(false)
  })
})

describe('the receiver', () => {
  it('refuses paths outside the set, secrets, traversal and a landing through a symlink that points out; none of it is written', async () => {
    const { receiver, link } = pair()
    const entry = (relPath: string) => ({ relPath, size: 1, sha256: 'a'.repeat(64), mode: 0o644, mtime: T0 })
    const answer = await link.request<{ pull: string[]; refused: number }>('memory.exchange', {
      from: 'env_mac',
      home: mac,
      generation: 'g1',
      entries: [entry('.claude/settings.json'), entry(`.claude/projects/${MAC_SHOP()}/abc.jsonl`), entry(macMem('x.pem')), entry('.claude/plans/../../etc/passwd'), entry('.codex/memories/.git/config'), entry('.claude/plans/ok.md')],
      tombstones: []
    })
    expect(answer.pull).toEqual(['.claude/plans/ok.md'])
    expect(answer.refused).toBe(5)
    await expect(link.request('memory.files', { generation: 'g1', files: [{ relPath: '.claude/plans/other.md', mtime: T0, sha256: 'a'.repeat(64), mode: 0o644, dataBase64: 'eA==' }], done: true })).rejects.toThrow(/not a file this generation asked for/)
    await expect(link.request('memory.files', { generation: 'g1', files: [{ relPath: '.claude/plans/ok.md', mtime: T0, sha256: 'b'.repeat(64), mode: 0o644, dataBase64: 'eA==' }], done: true })).rejects.toThrow(/does not match its hash/)
    expect(walk(box)).toEqual([])
    expect(receiver.status().environments).toEqual([])
  })
})
