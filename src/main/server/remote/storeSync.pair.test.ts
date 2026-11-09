import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { AddonStore } from '../addonStore'
import { SkillStore } from '../skillStore'
import { storePushes, storeRpc, type StoreRequest } from '../storeRpc'
import { RulesSync } from './rulesSync'
import { StoreSync, offlineRefusal } from './storeSync'
import { DEFAULT_RULES } from '@shared/rules'
import type { Principal } from '@shared/capabilities'
import type { ServerPush } from '@shared/contract'
import type { AddonInput, AddonRow, AddonSpec } from '@shared/contract-addons'
import type { SkillFile, SkillMeta } from '@shared/contract-skills'

// The two-host proof (CLAUDE.md "Add-ons and skills: one store, on the
// box"): a box (linux) and a Mac (darwin), each with its own database,
// stores, RulesSync, StoreSync and storeRpc, joined by an in-memory link
// that carries the Mac's requests to the box's handlers under the Mac's
// admin key and the box's pushes back to the Mac.

const MAC = 'env_mac'
const BOX = 'env_box'
const LINK = 'wl_temp'
const LOCAL: Principal = { kind: 'local' }
const MAC_KEY: Principal = { kind: 'remote', keyId: 'k_mac', name: 'The Mac', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] }
const spec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: ['GITHUB_TOKEN'], auth: 'fields' }
const addon = (over: Partial<AddonInput> = {}): AddonInput => ({ name: 'github', workspaceId: null, spec, ...over })
const md = (name: string, words = 'Tidy code.'): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${words}\n---\n` })

interface Host {
  db: ReturnType<typeof openDb>
  store: Store
  registry: SessionRegistry
  addons: AddonStore
  skills: SkillStore
  rules: RulesSync
  sync: StoreSync
  rpc: ReturnType<typeof storeRpc>
  pushes: ReturnType<typeof storePushes>
}

function host(id: string, platform: string, peers: { get(id: string): unknown; all(): unknown[] }): Host {
  const db = openDb(':memory:')
  const store = new Store(db)
  const registry = new SessionRegistry(store)
  const addons = new AddonStore(db)
  const skills = new SkillStore(db)
  const rules = new RulesSync({ environmentId: id, platform, registry, store, peers: peers as never, log: () => {} })
  const sync = new StoreSync({ environmentId: id, home: rules, addons, skills, store, peers: peers as never, log: () => {} })
  return { db, store, registry, addons, skills, rules, sync, rpc: storeRpc({ addons, skills, sync }), pushes: storePushes(addons, skills, 0) }
}

let box: Host
let mac: Host
let link: {
  id: string
  env: { id: string; name: string }
  connected: boolean
  build: { platform: string }
  request: <T>(method: string, params?: unknown) => Promise<T>
}

/** The box's answer to a request on the Mac's link, as its index.ts would give it. */
async function boxServe(method: string, params: Record<string, any>): Promise<unknown> {
  const r = box.registry
  switch (method) {
    case 'workspace.list':
      return r.listWorkspaces()
    case 'rules.get': {
      const scoped = r.getOrchestrationRules(params.workspaceId)
      return { rules: scoped ?? r.getOrchestrationRules(null) ?? DEFAULT_RULES, overridden: scoped !== null }
    }
    case 'rules.set':
      return r.setOrchestrationRules(params.workspaceId, params.rules)
    case 'defaults.get': {
      const scoped = r.getThreadDefaults(params.workspaceId)
      return { defaults: scoped, overridden: scoped !== null }
    }
    case 'defaults.set':
      return r.setThreadDefaults(params.workspaceId, params.defaults)
  }
  if (method.startsWith('addons.') || method.startsWith('skills.')) return box.rpc.handle({ method, params } as StoreRequest, MAC_KEY)
  throw new Error(`unknown method ${method}`)
}

beforeEach(() => {
  link = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    build: { platform: 'linux' },
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      // The wire: JSON both ways.
      return JSON.parse(JSON.stringify((await boxServe(method, JSON.parse(JSON.stringify(params ?? {})))) ?? null)) as T
    }
  }
  box = host(BOX, 'linux', { get: () => undefined, all: () => [] })
  mac = host(MAC, 'darwin', { get: (id) => (id === BOX ? link : undefined), all: () => [link] })
  box.store.insertWorkspace({ id: 'w-box', name: 'temp-code', path: '/srv/agents/work/temp-code', git: true, createdAt: 1 })
  box.store.setWorkspaceLink('w-box', LINK)
  mac.store.insertWorkspace({ id: 'w-mac', name: 'temp-code', path: '/Users/me/IdeaProjects/temp-code', git: true, createdAt: 1 })
  mac.store.setWorkspaceLink('w-mac', LINK)
  mac.store.insertWorkspace({ id: 'w-mac-only', name: 'scratch', path: '/Users/me/scratch', git: false, createdAt: 2 })
  // The box's pushes reach the Mac's link, which follows them.
  box.pushes.onPush((push) => {
    if (link.connected) mac.sync.onPeerPush(BOX, JSON.parse(JSON.stringify(push)) as ServerPush)
  })
})
afterEach(() => {
  for (const h of [box, mac]) {
    h.sync.close()
    h.rules.close()
    h.pushes.close()
    h.db.close()
  }
})

const macSet = async (input: AddonInput): Promise<AddonRow> => ((await mac.rpc.handle({ method: 'addons.set', params: { addon: input } }, LOCAL)) as { addon: AddonRow }).addon
const macSkill = async (files: SkillFile[], over: { workspaceId?: string | null } = {}): Promise<SkillMeta> =>
  ((await mac.rpc.handle({ method: 'skills.set', params: { skill: { name: 'tidy', workspaceId: over.workspaceId ?? null, files } } }, LOCAL)) as { skill: SkillMeta }).skill
const sameRow = (a: AddonRow | null, b: AddonRow | null, macWs: string | null = null): void => expect(a).toEqual(b && { ...b, workspaceId: macWs })

describe('one copy on the box, two hosts', () => {
  it('the Mac\'s add-on and skill seed the box', async () => {
    // Written before the Mac ever met the box: its own.
    const a = await macSet(addon())
    const s = await macSkill([md('tidy')])
    expect(box.addons.list()).toEqual([])
    await mac.sync.syncWith(BOX)
    expect(box.addons.get(a.id)).toMatchObject({ name: 'github', spec, addedBy: { kind: 'person' }, writtenBy: { kind: 'person' } })
    expect(box.skills.meta(s.id)).toMatchObject({ name: 'tidy', digest: s.digest, version: 1 })
    // The follow brings back the home's rows, the box's stamps on them.
    sameRow(mac.addons.get(a.id), box.addons.get(a.id))
    expect(mac.skills.get(s.id)).toEqual(box.skills.get(s.id))
  })

  it('a Mac write is forwarded and reads back the same on both halves, ids equal', async () => {
    await mac.sync.syncWith(BOX)
    const row = await macSet(addon({ description: 'GitHub issues' }))
    expect(box.addons.get(row.id)).not.toBeNull()
    sameRow(mac.addons.get(row.id), box.addons.get(row.id))
    expect(row).toEqual(mac.addons.get(row.id))
    const listed = (await mac.rpc.handle({ method: 'addons.list' }, LOCAL)) as { home: unknown }
    expect(listed.home).toEqual({ name: 'box', online: true })
  })

  it('a box edit and a box removal reach the Mac through its push', async () => {
    await mac.sync.syncWith(BOX)
    const row = (await box.rpc.handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)) as { addon: AddonRow }
    await new Promise((r) => setTimeout(r, 700))
    sameRow(mac.addons.get(row.addon.id), box.addons.get(row.addon.id))
    await box.rpc.handle({ method: 'addons.set', params: { addon: addon({ id: row.addon.id, description: 'edited on the box' }) } }, LOCAL)
    await new Promise((r) => setTimeout(r, 700))
    expect(mac.addons.get(row.addon.id)?.description).toBe('edited on the box')
    await box.rpc.handle({ method: 'addons.remove', params: { id: row.addon.id } }, LOCAL)
    await new Promise((r) => setTimeout(r, 700))
    expect(mac.addons.list()).toEqual([])
  })

  it('a workspace-scoped row maps by link id', async () => {
    await mac.sync.syncWith(BOX)
    const row = await macSet(addon({ workspaceId: 'w-mac' }))
    expect(box.addons.get(row.id)?.workspaceId).toBe('w-box')
    expect(mac.addons.get(row.id)?.workspaceId).toBe('w-mac')
    const theirs = (await box.rpc.handle({ method: 'skills.set', params: { skill: { name: 'tidy', workspaceId: 'w-box', files: [md('tidy')] } } }, LOCAL)) as { skill: SkillMeta }
    await mac.sync.syncWith(BOX)
    expect(mac.skills.meta(theirs.skill.id)?.workspaceId).toBe('w-mac')
  })

  it('a row of a workspace the box lacks stays the Mac\'s own', async () => {
    await mac.sync.syncWith(BOX)
    const own = await macSet(addon({ workspaceId: 'w-mac-only' }))
    await mac.sync.syncWith(BOX)
    expect(box.addons.list()).toEqual([])
    expect(mac.addons.get(own.id)?.workspaceId).toBe('w-mac-only')
    expect(((await mac.rpc.handle({ method: 'addons.list', params: { workspaceId: 'w-mac-only' } }, LOCAL)) as { home: unknown }).home).toBeNull()
  })

  it('with the link down, a Mac write is refused naming the box and nothing is written', async () => {
    await mac.sync.syncWith(BOX)
    link.connected = false
    await expect(macSet(addon())).rejects.toThrow(offlineRefusal('box'))
    await expect(macSkill([md('tidy')])).rejects.toThrow(offlineRefusal('box'))
    expect(mac.addons.list()).toEqual([])
    expect(mac.skills.list()).toEqual([])
    expect(((await mac.rpc.handle({ method: 'skills.list' }, LOCAL)) as { home: unknown }).home).toEqual({ name: 'box', online: false })
  })

  it('a skill with a base64 file and an executable bit round-trips byte for byte', async () => {
    await mac.sync.syncWith(BOX)
    const blob = Uint8Array.from([0, 1, 2, 0xfe, 0xff, 0x80, 0x7f])
    const files: SkillFile[] = [md('tidy'), { path: 'bin/data.bin', base64: Buffer.from(blob).toString('base64'), executable: true }, { path: 'run.sh', text: 'echo hi\n', executable: true }]
    const meta = await macSkill(files)
    for (const h of [box, mac]) {
      const stored = h.skills.files(meta.id)
      expect(stored.find((f) => f.path === 'bin/data.bin')).toEqual({ path: 'bin/data.bin', bytes: blob, executable: true })
      expect(stored.find((f) => f.path === 'run.sh')?.executable).toBe(true)
    }
    expect(mac.skills.get(meta.id)).toEqual(box.skills.get(meta.id))
    // And from the box to the Mac by the follow, when the files change there.
    const next = Uint8Array.from([9, 8, 7, 0])
    await box.rpc.handle({ method: 'skills.set', params: { skill: { id: meta.id, name: 'tidy', workspaceId: null, files: [md('tidy'), { path: 'bin/data.bin', base64: Buffer.from(next).toString('base64'), executable: true }] } } }, LOCAL)
    await mac.sync.syncWith(BOX)
    expect(mac.skills.files(meta.id)).toEqual(box.skills.files(meta.id))
    expect(mac.skills.files(meta.id).find((f) => f.path === 'bin/data.bin')?.bytes).toEqual(next)
  })

  it('a seed name clash keeps the box\'s row', async () => {
    const theirs = (await box.rpc.handle({ method: 'addons.set', params: { addon: addon({ description: 'the box\'s' }) } }, LOCAL)) as { addon: AddonRow }
    const mine = await macSet(addon({ description: 'the Mac\'s' }))
    expect(mine.id).not.toBe(theirs.addon.id)
    await mac.sync.syncWith(BOX)
    expect(box.addons.list().map((r) => r.id)).toEqual([theirs.addon.id])
    expect(mac.addons.list().map((r) => r.id)).toEqual([theirs.addon.id])
    expect(mac.addons.get(theirs.addon.id)?.description).toBe('the box\'s')
  })
})
