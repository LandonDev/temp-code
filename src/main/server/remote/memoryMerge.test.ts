import { describe, expect, it } from 'vitest'
import { decide, indexLineKey, pruneTombstones, TOMBSTONE_MS, unionIndex } from './memoryMerge'

const A = { sha256: 'a', mtime: 1000 }
const A2 = { sha256: 'a2', mtime: 2000 }
const B = { sha256: 'b', mtime: 1500 }
const B2 = { sha256: 'b2', mtime: 3000 }
const synced = { remote: 'a', local: 'b' }

describe('decide', () => {
  it('does nothing when both sides are as they were, or never synced and identical', () => {
    expect(decide({ remote: A, local: B, ledger: synced, index: false })).toEqual({ kind: 'nothing' })
    expect(decide({ remote: A, local: { sha256: 'a', mtime: 5 }, index: false })).toEqual({ kind: 'nothing' })
    expect(decide({ index: false })).toEqual({ kind: 'nothing' })
  })
  it('crosses the one side that changed', () => {
    expect(decide({ remote: A2, local: B, ledger: synced, index: false })).toEqual({ kind: 'pull' })
    expect(decide({ remote: A, local: B2, ledger: synced, index: false })).toEqual({ kind: 'push' })
  })
  it('a new file crosses from wherever it is', () => {
    expect(decide({ remote: A, index: false })).toEqual({ kind: 'pull' })
    expect(decide({ local: B, index: false })).toEqual({ kind: 'push' })
  })
  it('both changed: the newer wins and the other is kept beside; the index is unioned', () => {
    expect(decide({ remote: A2, local: B2, ledger: synced, index: false })).toEqual({ kind: 'push', keep: 'conflict' })
    expect(decide({ remote: { sha256: 'a2', mtime: 4000 }, local: B2, ledger: synced, index: false })).toEqual({ kind: 'pull', keep: 'conflict' })
    expect(decide({ remote: A, local: B, index: false })).toEqual({ kind: 'push', keep: 'conflict' })
    expect(decide({ remote: A2, local: B2, ledger: synced, index: true })).toEqual({ kind: 'union' })
    expect(decide({ remote: A, local: B, index: true })).toEqual({ kind: 'union' })
  })
  it('a deletion here crosses when the driver did not edit since; an edit after the deletion brings the file back; an older edit is kept beside', () => {
    expect(decide({ remote: A, localTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'delete-remote' })
    expect(decide({ remote: { sha256: 'a2', mtime: 6000 }, localTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'pull' })
    expect(decide({ remote: A2, localTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'delete-remote', keep: 'conflict' })
    // Gone here without a tombstone (noticed late): the ledger says it was synced, so it is a deletion unless the driver edited.
    expect(decide({ remote: A, ledger: synced, index: false })).toEqual({ kind: 'delete-remote' })
    expect(decide({ remote: A2, ledger: synced, index: false })).toEqual({ kind: 'pull' })
  })
  it('a deletion on the driver crosses when this host did not edit since; otherwise the newer side wins', () => {
    expect(decide({ local: B, remoteTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'delete-local' })
    expect(decide({ local: { sha256: 'b2', mtime: 6000 }, remoteTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'push' })
    expect(decide({ local: B2, remoteTombAt: 5000, ledger: synced, index: false })).toEqual({ kind: 'delete-local', keep: 'conflict' })
    // No tombstone and no file on the driver, synced before: the driver's record is gone, the file comes back rather than vanishing.
    expect(decide({ local: B, ledger: synced, index: false })).toEqual({ kind: 'push' })
  })
})

describe('tombstones', () => {
  it('keeps one for 30 days', () => {
    const now = 10_000_000_000_000
    const kept = pruneTombstones({ fresh: { at: now - TOMBSTONE_MS + 1000 }, old: { at: now - TOMBSTONE_MS - 1 } }, now)
    expect(Object.keys(kept)).toEqual(['fresh'])
  })
})

describe('unionIndex', () => {
  const mac = '# Memory index\n\n- [Box loop](box-loop.md) — vitest on the box\n- [Mac build](mac-build.md) — xcode\n'
  it('keys a line by its linked file, else its text; blank lines have no key', () => {
    expect(indexLineKey('- [T](dir/note.md) — hook')).toBe('file:note.md')
    expect(indexLineKey('# Memory index')).toBe('text:# Memory index')
    expect(indexLineKey('   ')).toBeNull()
  })
  it('unions lines both hosts added, one per file, in order, deduped by file name', () => {
    const box = '# Memory index\n\n- [Box loop](box-loop.md) — vitest on the box, NODE_ENV=test\n- [Peers](peers.md) — the link\n'
    const out = unionIndex(mac, box)
    expect(out).toBe('# Memory index\n\n- [Box loop](box-loop.md) — vitest on the box\n- [Peers](peers.md) — the link\n- [Mac build](mac-build.md) — xcode\n')
    // The same inputs the other way round: the same files, the base's wording of a shared line.
    const files = (t: string) => t.split('\n').map(indexLineKey).filter((k) => k?.startsWith('file:')).sort()
    expect(files(unionIndex(box, mac))).toEqual(files(out))
    expect(unionIndex(box, mac)).toContain('vitest on the box, NODE_ENV=test')
    expect(unionIndex(mac, mac)).toBe(mac)
  })
  it('a line the other side has and the base lacks lands after the last shared line, or at the end of the list when none is shared yet', () => {
    expect(unionIndex('# Memory index\n\n- [A](a.md) — a\n', '- [Z](z.md) — z\n')).toBe('# Memory index\n\n- [A](a.md) — a\n- [Z](z.md) — z\n')
    expect(unionIndex('# Memory index\n\n- [A](a.md) — a\n- [B](b.md) — b\n', '- [A](a.md) — a\n- [N](n.md) — n\n- [B](b.md) — b\n')).toBe('# Memory index\n\n- [A](a.md) — a\n- [N](n.md) — n\n- [B](b.md) — b\n')
  })
  it('drops a line whose memory file is gone from both hosts; external links stay', () => {
    const out = unionIndex(mac + '- [Docs](https://example.com) — site\n', mac, (file) => file !== 'mac-build.md')
    expect(out).toBe('# Memory index\n\n- [Box loop](box-loop.md) — vitest on the box\n- [Docs](https://example.com) — site\n')
  })
})
