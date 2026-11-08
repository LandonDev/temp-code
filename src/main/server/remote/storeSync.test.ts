import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AddonStore } from '../addonStore'
import { SkillStore } from '../skillStore'
import { STORE_SEEDED_KEY, StoreSync, offlineRefusal } from './storeSync'
import type { Scope } from './rulesSync'
import type { AddonInput, AddonSpec } from '@shared/contract-addons'
import type { SkillFile, SkillInput } from '@shared/contract-skills'

// The Mac (this host, the follower) against a fake box: the box's own
// stores behind a link that answers the store's RPCs; the home and the
// shared scopes are given as RulesSync would know them.

const MAC = 'env_mac'
const BOX = 'env_box'
const you = { kind: 'person' } as const
const spec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: ['GITHUB_TOKEN'], auth: 'fields' }
const addon = (over: Partial<AddonInput> = {}): AddonInput => ({ name: 'github', workspaceId: null, spec, ...over })
const md = (name: string, words = 'Tidy code.'): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${words}\n---\n` })
const skill = (over: Partial<SkillInput> = {}): SkillInput => ({ name: 'tidy', workspaceId: null, files: [md('tidy')], ...over })

interface Half {
  db: DatabaseSync
  addons: AddonStore
  skills: SkillStore
  settings: Map<string, string>
}
const half = (): Half => {
  const db = new DatabaseSync(':memory:')
  return { db, addons: new AddonStore(db), skills: new SkillStore(db), settings: new Map() }
}

let mac: Half
let box: Half
let link: {
  id: string
  env: { id: string; name: string }
  connected: boolean
  calls: string[]
  /** The next list is read now and answered once this resolves. */
  hold: Promise<void> | null
  request: <T>(method: string, params?: unknown) => Promise<T>
}
let scopes: Scope[]
let home: string
let logs: string[]
let sync: StoreSync

beforeEach(() => {
  mac = half()
  box = half()
  scopes = [
    { key: 'global', local: null, peer: null },
    { key: 'wl_temp', local: 'w-mac', peer: 'w-box' }
  ]
  home = BOX
  logs = []
  link = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    calls: [],
    hold: null,
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      link.calls.push(method)
      const p = (params ?? {}) as Record<string, any>
      switch (method) {
        case 'addons.list': {
          const answer = { addons: box.addons.list(), status: {}, home: null }
          const held = link.hold
          link.hold = null
          if (held) await held
          return answer as T
        }
        case 'addons.set':
          return { addon: box.addons.set(p.addon, you) } as T
        case 'addons.remove':
          return { removed: box.addons.remove(p.id) } as T
        case 'skills.list':
          return { skills: box.skills.list(), home: null } as T
        case 'skills.get':
          return { skill: box.skills.get(p.id) } as T
        case 'skills.set':
          return { skill: box.skills.set(p.skill, you) } as T
        case 'skills.remove':
          return { removed: box.skills.remove(p.id) } as T
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  sync = new StoreSync({
    environmentId: MAC,
    home: { homeOf: () => home, sharedScopes: () => scopes, syncWith: async () => {} },
    addons: mac.addons,
    skills: mac.skills,
    store: { getSetting: (k) => mac.settings.get(k) ?? null, setSetting: (k, v) => (v === null ? mac.settings.delete(k) : mac.settings.set(k, v)) },
    peers: { get: (id: string) => (id === BOX ? link : undefined), all: () => [link] } as never,
    log: (line) => logs.push(line)
  })
})
afterEach(() => {
  sync.close()
  mac.db.close()
  box.db.close()
})

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort()

describe('the follow', () => {
  it('writes the home\'s rows here with their ids, mapping each workspace by its link', async () => {
    const g = box.addons.set(addon(), you)
    const w = box.addons.set(addon({ name: 'linear', workspaceId: 'w-box' }), you)
    const s = box.skills.set(skill({ workspaceId: 'w-box' }), you)
    await sync.syncWith(BOX)
    expect(mac.addons.get(g.id)).toEqual(g)
    expect(mac.addons.get(w.id)).toEqual({ ...w, workspaceId: 'w-mac' })
    expect(mac.skills.get(s.id)).toEqual({ ...box.skills.get(s.id)!, workspaceId: 'w-mac' })
  })

  it('skips a row of a workspace this host has no copy of', async () => {
    box.addons.set(addon({ workspaceId: 'w-only-box' }), you)
    await sync.syncWith(BOX)
    expect(mac.addons.list()).toEqual([])
  })

  it('drops a row of a shared scope the home no longer lists, and keeps a scope that is not shared', async () => {
    const g = box.addons.set(addon(), you)
    const mine = mac.addons.set(addon({ name: 'local', workspaceId: 'w-unshared' }), you)
    await sync.syncWith(BOX)
    box.addons.remove(g.id)
    await sync.syncWith(BOX)
    expect(ids(mac.addons.list())).toEqual([mine.id])
    expect(box.addons.list()).toEqual([])
  })

  it('fetches a skill\'s files only when its digest moved', async () => {
    const s = box.skills.set(skill(), you)
    await sync.syncWith(BOX)
    expect(link.calls.filter((c) => c === 'skills.get')).toHaveLength(1)
    box.skills.set(skill({ enabled: false }), you)
    link.calls = []
    await sync.syncWith(BOX)
    expect(link.calls).not.toContain('skills.get')
    expect(mac.skills.meta(s.id)).toMatchObject({ enabled: false, version: 2 })
    box.skills.set(skill({ files: [md('tidy', 'New words.')] }), you)
    await sync.syncWith(BOX)
    expect(link.calls.filter((c) => c === 'skills.get')).toHaveLength(1)
    expect(mac.skills.meta(s.id)?.description).toBe('New words.')
  })
})

describe('the seed', () => {
  it('takes this host\'s rows to the home once per scope, ids and writers kept', async () => {
    const thread = { kind: 'thread', sessionId: 's', environmentId: MAC, title: 'Add it' } as const
    const a = mac.addons.set(addon(), thread)
    const s = mac.skills.set(skill({ workspaceId: 'w-mac' }), you)
    await sync.syncWith(BOX)
    expect(box.addons.get(a.id)).toMatchObject({ name: 'github', addedBy: thread, writtenBy: thread })
    expect(box.skills.meta(s.id)).toMatchObject({ name: 'tidy', workspaceId: 'w-box', digest: s.digest })
    expect(JSON.parse(mac.settings.get(`${STORE_SEEDED_KEY}${BOX}:addons`)!)).toEqual(['global', 'wl_temp'])
    // Seeded once: a row the box removed is not sent back.
    box.addons.remove(a.id)
    await sync.syncWith(BOX)
    expect(mac.addons.list()).toEqual([])
    expect(box.addons.list()).toEqual([])
  })

  it('a workspace linked after the first sync keeps its rows: they seed before the follow could drop them', async () => {
    scopes = [{ key: 'global', local: null, peer: null }]
    const later = mac.addons.set(addon({ workspaceId: 'w-mac' }), you)
    await sync.syncWith(BOX)
    expect(box.addons.list()).toEqual([])
    scopes = [...scopes, { key: 'wl_temp', local: 'w-mac', peer: 'w-box' }]
    await sync.syncWith(BOX)
    expect(box.addons.get(later.id)?.workspaceId).toBe('w-box')
    expect(mac.addons.get(later.id)?.workspaceId).toBe('w-mac')
  })

  it('a name the home already uses in that scope is the home\'s: this host\'s row is dropped and said', async () => {
    const theirs = box.addons.set(addon(), you)
    const mine = mac.addons.set(addon({ spec: { ...spec, args: ['mine'] } }), you)
    await sync.syncWith(BOX)
    expect(ids(mac.addons.list())).toEqual([theirs.id])
    expect(box.addons.list()).toHaveLength(1)
    expect(logs.some((l) => l.includes(theirs.id) && l.includes(mine.id))).toBe(true)
  })
})

describe('forward', () => {
  it('sends a write for a shared scope to the home and lands its answer here', async () => {
    await sync.syncWith(BOX)
    expect(await sync.forward('addons.set', { addon: { ...addon({ workspaceId: 'w-mac' }), writtenBy: you, addedBy: you } }, 'w-mac')).toBe(true)
    const row = box.addons.byName('w-box', 'github')!
    expect(mac.addons.get(row.id)).toEqual({ ...row, workspaceId: 'w-mac' })
    const files: SkillFile[] = [md('tidy'), { path: 'bin.dat', base64: 'AAH/', executable: true }]
    expect(await sync.forward('skills.set', { skill: skill({ files }) }, null)).toBe(true)
    const s = box.skills.byName(null, 'tidy')!
    expect(mac.skills.get(s.id)?.files).toEqual(box.skills.get(s.id)?.files)
    expect(await sync.forward('addons.remove', { id: row.id }, 'w-mac')).toBe(true)
    expect(box.addons.list()).toEqual([])
    expect(mac.addons.list()).toEqual([])
  })

  it('leaves a write to this host when it is the home or the scope is its own', async () => {
    expect(await sync.forward('addons.set', { addon: addon({ workspaceId: 'w-unshared' }) }, 'w-unshared')).toBe(false)
    home = MAC
    expect(await sync.forward('addons.set', { addon: addon() }, null)).toBe(false)
    expect(box.addons.list()).toEqual([])
  })

  it('refuses while the home is out of reach, writing nothing', async () => {
    link.connected = false
    await expect(sync.forward('addons.set', { addon: addon() }, null)).rejects.toThrow(offlineRefusal('box'))
    await expect(sync.forward('skills.remove', { id: 'sk_x' }, null)).rejects.toThrow(offlineRefusal('box'))
    expect(mac.addons.list()).toEqual([])
  })

  it('a follow read before a forward never writes its older answer over it', async () => {
    const first = box.addons.set(addon({ description: 'one' }), you)
    await sync.syncWith(BOX)
    let release!: () => void
    link.hold = new Promise<void>((r) => (release = r))
    const pull = sync.syncWith(BOX)
    for (let i = 0; i < 20 && link.hold; i++) await new Promise((r) => setTimeout(r, 0))
    expect(link.hold).toBeNull()
    await sync.forward('addons.set', { addon: { ...addon({ description: 'two' }), id: first.id } }, null)
    expect(mac.addons.get(first.id)?.description).toBe('two')
    release()
    await pull
    expect(mac.addons.get(first.id)?.description).toBe('two')
  })

  it('says where each scope lives', () => {
    expect(sync.homeFor(null)).toEqual({ name: 'box', online: true })
    expect(sync.homeFor('w-mac')).toEqual({ name: 'box', online: true })
    expect(sync.homeFor('w-unshared')).toBeNull()
    link.connected = false
    expect(sync.homeFor(null)).toEqual({ name: 'box', online: false })
    home = MAC
    expect(sync.homeFor(null)).toBeNull()
  })

  it('follows the home\'s pushes and never consumes them', async () => {
    expect(sync.onPeerPush(BOX, { push: 'addons', addons: [] })).toBe(false)
    expect(sync.onPeerPush(BOX, { push: 'skills', skills: [] })).toBe(false)
    box.addons.set(addon(), you)
    await new Promise((r) => setTimeout(r, 600))
    await sync.syncWith(BOX)
    expect(mac.addons.list()).toHaveLength(1)
  })
})
