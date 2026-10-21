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
  it('reads back what a full write put, newest first, with the cursor and lists', () => {
    const mirror = open()
    mirror.write(
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

  it('a partial write upserts and removes without touching the rest; a full write replaces the set', () => {
    const mirror = open()
    mirror.write({ environmentId: 'box', full: true, upserts: [summary('a', 1), summary('b', 2), summary('c', 3)] })
    mirror.write({ environmentId: 'box', upserts: [summary('b', 9, { title: 'renamed' })], removed: ['c'] })
    let [host] = mirror.read()
    expect(host.sessions.map((s) => [s.id, s.title])).toEqual([
      ['b', 'renamed'],
      ['a', 'thread a']
    ])
    mirror.write({ environmentId: 'box', full: true, upserts: [summary('z', 5)] })
    ;[host] = mirror.read()
    expect(host.sessions.map((s) => s.id)).toEqual(['z'])
  })

  it('a write with no cursor leaves the saved cursor alone; null clears it', () => {
    const mirror = open()
    mirror.write({ environmentId: 'box', cursor: { seq: 3, generation: 'g' } })
    mirror.write({ environmentId: 'box', upserts: [summary('a', 1)] })
    expect(mirror.read()[0].cursor).toEqual({ seq: 3, generation: 'g' })
    mirror.write({ environmentId: 'box', cursor: null })
    expect(mirror.read()[0].cursor).toBeNull()
  })

  it('keeps hosts apart and forgets one whole', () => {
    const mirror = open()
    mirror.write({ environmentId: 'local', upserts: [summary('a', 1)] })
    mirror.write({ environmentId: 'box', upserts: [summary('b', 1)] })
    expect(mirror.hostIds().sort()).toEqual(['box', 'local'])
    mirror.forget('box')
    expect(mirror.read().map((h) => h.environmentId)).toEqual(['local'])
  })

  it('read with a keep-set forgets the hosts that are no longer saved', () => {
    const mirror = open()
    mirror.write({ environmentId: 'local', upserts: [summary('a', 1)] })
    mirror.write({ environmentId: 'gone', upserts: [summary('b', 1)] })
    const hosts = mirror.read(['local', 'other'])
    expect(hosts.map((h) => h.environmentId)).toEqual(['local'])
    expect(mirror.hostIds()).toEqual(['local'])
  })

  it('prunes archived summaries older than thirty days, keeps live ones however old', () => {
    const mirror = open()
    const now = 100 * MIRROR_ARCHIVED_KEEP_MS
    mirror.write(
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

  it('caps a host at MIRROR_MAX_SESSIONS, dropping the oldest', () => {
    const mirror = open()
    const many = Array.from({ length: MIRROR_MAX_SESSIONS + 25 }, (_, i) => summary(`s${i}`, i))
    mirror.write({ environmentId: 'box', full: true, upserts: many })
    const kept = mirror.read()[0].sessions
    expect(kept).toHaveLength(MIRROR_MAX_SESSIONS)
    expect(kept[0].id).toBe(`s${MIRROR_MAX_SESSIONS + 24}`)
    expect(kept.some((s) => s.id === 's0')).toBe(false)
    expect(kept.some((s) => s.id === 's24')).toBe(false)
    expect(kept.some((s) => s.id === 's25')).toBe(true)
  })

  it('ignores malformed writes and summaries instead of throwing', () => {
    const mirror = open()
    mirror.write({ environmentId: '' })
    mirror.write({ environmentId: 'box', upserts: [{ nope: true } as unknown as MirrorSummary, summary('ok', 1)] })
    expect(mirror.read()[0].sessions.map((s) => s.id)).toEqual(['ok'])
  })
})
