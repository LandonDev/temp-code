import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LaunchMirror, MIRROR_ARCHIVED_KEEP_MS, MIRROR_MAX_SESSIONS, type MirrorSummary } from './launchMirror'

const summary = (id: string, updatedAt: number, extra: Partial<MirrorSummary> = {}): MirrorSummary => ({
  id,
  archived: false,
  updatedAt,
  title: `thread ${id}`,
  status: 'idle',
  ...extra
})

const open = (): LaunchMirror => new LaunchMirror(new DatabaseSync(':memory:'))

describe('LaunchMirror', () => {
  it('reads back what a full write put, newest first, with the cursor and lists', async () => {
    const mirror = open()
    await mirror.write(
      {
        environmentId: 'box',
        full: true,
        upserts: [summary('a', 10), summary('b', 30), summary('c', 20)],
        cursor: { seq: 7, generation: 'g1' },
        workspaces: [{ id: 'w1' }],
        projects: [{ id: 'p1' }]
      },
      1_000
    )
    const [host] = mirror.read()
    expect(host.environmentId).toBe('box')
    expect(host.cursor).toEqual({ seq: 7, generation: 'g1' })
    expect(host.workspaces).toEqual([{ id: 'w1' }])
    expect(host.projects).toEqual([{ id: 'p1' }])
    expect(host.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(host.sessions[0].title).toBe('thread b')
    expect(host.writtenAt).toBe(1_000)
  })

  it('a partial write upserts and removes without touching the rest; a full write replaces the set', async () => {
    const mirror = open()
    await mirror.write({ environmentId: 'box', full: true, upserts: [summary('a', 1), summary('b', 2), summary('c', 3)] })
    await mirror.write({ environmentId: 'box', upserts: [summary('b', 9, { title: 'renamed' })], removed: ['c'] })
    let [host] = mirror.read()
    expect(host.sessions.map((s) => [s.id, s.title])).toEqual([
      ['b', 'renamed'],
      ['a', 'thread a']
    ])
    await mirror.write({ environmentId: 'box', full: true, upserts: [summary('z', 5)] })
    ;[host] = mirror.read()
    expect(host.sessions.map((s) => s.id)).toEqual(['z'])
  })

  it('a write with no cursor leaves the saved cursor alone; null clears it', async () => {
    const mirror = open()
    await mirror.write({ environmentId: 'box', cursor: { seq: 3, generation: 'g' } })
    await mirror.write({ environmentId: 'box', upserts: [summary('a', 1)] })
    expect(mirror.read()[0].cursor).toEqual({ seq: 3, generation: 'g' })
    await mirror.write({ environmentId: 'box', cursor: null })
    expect(mirror.read()[0].cursor).toBeNull()
  })

  it('keeps hosts apart and forgets one whole', async () => {
    const mirror = open()
    await mirror.write({ environmentId: 'local', upserts: [summary('a', 1)] })
    await mirror.write({ environmentId: 'box', upserts: [summary('b', 1)] })
    expect(mirror.hostIds().sort()).toEqual(['box', 'local'])
    mirror.forget('box')
    expect(mirror.read().map((h) => h.environmentId)).toEqual(['local'])
  })

  it('read with a keep-set forgets the hosts that are no longer saved', async () => {
    const mirror = open()
    await mirror.write({ environmentId: 'local', upserts: [summary('a', 1)] })
    await mirror.write({ environmentId: 'gone', upserts: [summary('b', 1)] })
    const hosts = mirror.read(['local', 'other'])
    expect(hosts.map((h) => h.environmentId)).toEqual(['local'])
    expect(mirror.hostIds()).toEqual(['local'])
  })

  it('prunes archived summaries older than thirty days, keeps live ones however old', async () => {
    const mirror = open()
    const now = 100 * MIRROR_ARCHIVED_KEEP_MS
    await mirror.write(
      {
        environmentId: 'box',
        upserts: [
          summary('old-archived', now - MIRROR_ARCHIVED_KEEP_MS - 1, { archived: true }),
          summary('new-archived', now - MIRROR_ARCHIVED_KEEP_MS + 1_000, { archived: true }),
          summary('old-live', 1)
        ]
      },
      now
    )
    expect(
      mirror
        .read()[0]
        .sessions.map((s) => s.id)
        .sort()
    ).toEqual(['new-archived', 'old-live'])
  })

  it('caps a host at MIRROR_MAX_SESSIONS, dropping the oldest', async () => {
    const mirror = open()
    const many = Array.from({ length: MIRROR_MAX_SESSIONS + 25 }, (_, i) => summary(`s${i}`, i))
    await mirror.write({ environmentId: 'box', full: true, upserts: many })
    const kept = mirror.read()[0].sessions
    expect(kept).toHaveLength(MIRROR_MAX_SESSIONS)
    expect(kept[0].id).toBe(`s${MIRROR_MAX_SESSIONS + 24}`)
    expect(kept.some((s) => s.id === 's0')).toBe(false)
    expect(kept.some((s) => s.id === 's24')).toBe(false)
    expect(kept.some((s) => s.id === 's25')).toBe(true)
  })

  it('ignores malformed writes and summaries instead of throwing', async () => {
    const mirror = open()
    await mirror.write({ environmentId: '' })
    await mirror.write({ environmentId: 'box', upserts: [{ nope: true } as unknown as MirrorSummary, summary('ok', 1)] })
    expect(mirror.read()[0].sessions.map((s) => s.id)).toEqual(['ok'])
  })
})

it('a 2,000-row write lands in 200-row slices and ends with the whole write', async () => {
  const db = new DatabaseSync(':memory:')
  const mirror = new LaunchMirror(db)
  const upserts = Array.from({ length: 2000 }, (_, i) => summary(`s${i}`, i))
  const counts: number[] = []
  let finished = false
  const observe = (): void => {
    counts.push((db.prepare('SELECT count(*) AS n FROM launch_mirror_sessions').get() as { n: number }).n)
    if (!finished) setImmediate(observe)
  }
  const writing = mirror.write({ environmentId: 'box', full: true, upserts, cursor: { seq: 2000, generation: 'g' } }, 10)
  setImmediate(observe)
  // A later delta waits behind all slices of the full write.
  const delta = mirror.write({ environmentId: 'box', upserts: [summary('s0', 3000, { title: 'latest' })] }, 11)
  await writing
  finished = true
  await delta
  expect(counts.length).toBeGreaterThanOrEqual(9)
  expect(counts.every((n) => n % 200 === 0)).toBe(true)
  const host = mirror.read()[0]
  expect(host.sessions).toEqual([summary('s0', 3000, { title: 'latest' }), ...upserts.slice(1).reverse()])
  expect(host.cursor).toEqual({ seq: 2000, generation: 'g' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  db.close()
})

it('forget cancels queued writes and remaining slices so a removed host stays gone', async () => {
  const mirror = open()
  const writing = mirror.write({ environmentId: 'box', upserts: Array.from({ length: 2000 }, (_, i) => summary(`s${i}`, i)) })
  const queued = mirror.write({ environmentId: 'box', upserts: [summary('late', 3000)] })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mirror.read()[0].sessions.length).toBeGreaterThan(0)
  mirror.forget('box')
  await Promise.all([writing, queued])
  expect(mirror.read()).toEqual([])
})
