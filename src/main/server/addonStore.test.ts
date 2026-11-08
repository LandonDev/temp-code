import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AddonStore, specDigest } from './addonStore'
import type { AddonInput, AddonRow, AddonSpec, AddonTool } from '@shared/contract-addons'

const you = { kind: 'person' } as const
const thread = { kind: 'thread', sessionId: 's1', environmentId: 'env_box', title: 'Wire GitHub' } as const
const spec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: ['GITHUB_TOKEN'], auth: 'fields' }
const input = (over: Partial<AddonInput> = {}): AddonInput => ({ name: 'github', workspaceId: null, spec, ...over })
const tool: AddonTool = { name: 'create_issue', exposed: 'github__create_issue', description: 'Create an issue', inputSchema: { type: 'object' } }

let db: DatabaseSync
let clock: number
let store: AddonStore
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  clock = 1_000
  store = new AddonStore(db, () => clock)
})
afterEach(() => db.close())

describe('AddonStore rows', () => {
  it('creates a row with a minted id, stamps and the writer, and reads it back', () => {
    const row = store.set(input({ description: 'GitHub issues' }), you)
    expect(row.id).toMatch(/^ad_[A-Za-z0-9_-]{12}$/)
    expect(row).toMatchObject({ name: 'github', workspaceId: null, description: 'GitHub issues', enabled: true, addedBy: you, writtenBy: you, createdAt: 1_000, updatedAt: 1_000 })
    expect(store.get(row.id)).toEqual(row)
    expect(store.byName(null, 'github')).toEqual(row)
    expect(store.list()).toEqual([row])
  })

  it('replaces by scope and name, keeping the id, the creator and the creation time', () => {
    const first = store.set(input(), you)
    clock = 2_000
    const next = store.set(input({ spec: { ...spec, args: ['-y', 'other'] }, enabled: false }), thread)
    expect(next).toMatchObject({ id: first.id, enabled: false, addedBy: you, writtenBy: thread, createdAt: 1_000, updatedAt: 2_000 })
    expect(store.list()).toHaveLength(1)
  })

  it('replaces by id, may move the scope, and creates under an id minted elsewhere', () => {
    const first = store.set(input(), you)
    expect(store.set(input({ id: first.id, workspaceId: 'ws1' }), you).workspaceId).toBe('ws1')
    expect(store.byName(null, 'github')).toBeNull()
    expect(store.set(input({ id: 'ad_fromthemac1', name: 'linear' }), you).id).toBe('ad_fromthemac1')
  })

  it('refuses a name another row holds in that scope, and an unsafe spec', () => {
    const first = store.set(input(), you)
    store.set(input({ name: 'other' }), you)
    expect(() => store.set(input({ id: first.id, name: 'other' }), you)).toThrow('refused: an add-on named other already exists there')
    expect(() => store.set(input({ spec: { ...spec, args: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] } }), you)).toThrow(/^refused: args\[0\] looks like a secret/)
    expect(() => store.set(input({ name: 'Bad' }), you)).toThrow()
  })

  it('keeps one row per scope and name, a workspace row beside a global one', () => {
    const global = store.set(input(), you)
    const ws = store.set(input({ workspaceId: 'ws1' }), you)
    expect(ws.id).not.toBe(global.id)
    expect(store.visible('ws1').map((r) => r.id)).toEqual([ws.id])
    expect(store.visible('ws2').map((r) => r.id)).toEqual([global.id])
  })

  it('the sync puts a row as it stands; a local row of that name under another id gives way', () => {
    const mine = store.set(input(), you)
    const home: AddonRow = { ...mine, id: 'ad_home00000001', writtenBy: thread, createdAt: 5, updatedAt: 6 }
    expect(store.put(home)).toBe(true)
    expect(store.list()).toEqual([home])
    expect(store.put(home)).toBe(false)
    // The same row with its keys in another order (as the wire may carry it) changes nothing.
    const reordered = Object.fromEntries(Object.entries({ ...home, spec: Object.fromEntries(Object.entries(home.spec).reverse()) }).reverse()) as AddonRow
    expect(store.put(reordered)).toBe(false)
  })

  it('removes a row, and drops a deleted workspace\'s rows', () => {
    const a = store.set(input(), you)
    store.set(input({ workspaceId: 'ws1' }), you)
    store.set(input({ workspaceId: 'ws1', name: 'linear' }), you)
    expect(store.dropWorkspace('ws1')).toBe(2)
    expect(store.list().map((r) => r.id)).toEqual([a.id])
    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('tells its listeners each change', () => {
    let changes = 0
    const off = store.onChange(() => changes++)
    const row = store.set(input(), you)
    store.put({ ...row, description: 'x' })
    store.put({ ...row, description: 'x' })
    store.remove(row.id)
    off()
    store.set(input(), you)
    expect(changes).toBe(3)
  })
})

describe('AddonStore tools and status (this host only)', () => {
  it('keeps the tools listed under the current spec; a changed spec voids them', () => {
    const row = store.set(input(), you)
    expect(store.tools(row.id)).toBeNull()
    store.setTools(row.id, [tool], 1_500)
    expect(store.tools(row.id)).toEqual({ tools: [tool], fetchedAt: 1_500 })
    // A write that keeps the spec keeps the cache.
    store.set(input({ description: 'still github' }), you)
    expect(store.tools(row.id)?.tools).toEqual([tool])
    store.set(input({ spec: { ...spec, args: ['-y', 'other'] } }), you)
    expect(store.tools(row.id)).toBeNull()
    expect(specDigest(spec)).toBe(specDigest({ ...spec }))
  })

  it('a put with another spec voids the cache too, and removal clears tools and status', () => {
    const row = store.set(input(), you)
    store.setTools(row.id, [tool])
    store.put({ ...row, spec: { ...spec, command: 'bunx' } })
    expect(store.tools(row.id)).toBeNull()
    store.setTools(row.id, [tool])
    store.setStatus(row.id, { state: 'ready', tools: 1, at: 1 })
    store.remove(row.id)
    expect(store.status()).toEqual({})
    expect(db.prepare('SELECT COUNT(*) AS n FROM addon_tool_cache').get()).toEqual({ n: 0 })
  })

  it('holds status in memory and tells its listeners only of a real change', () => {
    let seen = 0
    store.onStatus(() => seen++)
    store.setStatus('ad_x', { state: 'starting', tools: 0, at: 1 })
    store.setStatus('ad_x', { state: 'starting', tools: 0, at: 1 })
    store.setStatus('ad_x', { state: 'needs-grant', tools: 0, detail: 'GITHUB_TOKEN', at: 2 })
    expect(store.status()).toEqual({ ad_x: { state: 'needs-grant', tools: 0, detail: 'GITHUB_TOKEN', at: 2 } })
    store.setStatus('ad_x', null)
    store.setStatus('ad_x', null)
    expect(seen).toBe(3)
    expect(new AddonStore(db).status()).toEqual({})
  })
})
