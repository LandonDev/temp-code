import { afterEach, expect, it } from 'vitest'
import { openDb, Store } from './db'

const db = openDb(':memory:')
const store = new Store(db)
afterEach(() => {
  store.setSetting('renderer.workspaceSnapshot.v1', null)
  store.dropWorkspaceSnapshot('w-second')
})
it('round-trips and replaces the singleton JSON object', () => {
  expect(store.getWorkspaceSnapshot()).toBeNull()
  store.setWorkspaceSnapshot({ tabs: [{ id: 'one', nested: [null, true, 4] }] })
  expect(store.getWorkspaceSnapshot()).toEqual({ tabs: [{ id: 'one', nested: [null, true, 4] }] })
  store.setWorkspaceSnapshot({ tabs: [] })
  expect(store.getWorkspaceSnapshot()).toEqual({ tabs: [] })
})
it('validates objects and the exact serialized UTF-8 byte cap without overwriting on failure', () => {
  const exact = { x: 'é'.repeat(999_996) }
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(2_000_000)
  store.setWorkspaceSnapshot(exact)
  expect(() => store.setWorkspaceSnapshot({ x: exact.x + 'a' })).toThrow('too large')
  for (const invalid of [null, [], 'text', 1, { x: undefined }, { x: NaN }]) {
    expect(() => store.setWorkspaceSnapshot(invalid)).toThrow()
  }
  expect(store.getWorkspaceSnapshot()).toEqual(exact)
})

it('keeps one snapshot per window slot and drops one without touching the rest', () => {
  store.setWorkspaceSnapshot({ tabs: ['a'] })
  store.setWorkspaceSnapshot({ tabs: ['b'] }, 'w-second')
  expect(store.getWorkspaceSnapshot('main')).toEqual({ tabs: ['a'] })
  expect(store.getWorkspaceSnapshot()).toEqual({ tabs: ['a'] })
  expect(store.getWorkspaceSnapshot('w-second')).toEqual({ tabs: ['b'] })
  store.dropWorkspaceSnapshot('w-second')
  expect(store.getWorkspaceSnapshot('w-second')).toBeNull()
  expect(store.getWorkspaceSnapshot()).toEqual({ tabs: ['a'] })
})
