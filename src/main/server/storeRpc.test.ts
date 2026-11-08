import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Principal } from '@shared/capabilities'
import type { AddonInput, AddonRow, AddonSpec } from '@shared/contract-addons'
import type { SkillFile, SkillInput, SkillMeta } from '@shared/contract-skills'
import { AddonStore } from './addonStore'
import { SkillStore } from './skillStore'
import { isStoreMethod, storePushes, storeRpc, writerOf, type StoreRpcDeps } from './storeRpc'

const LOCAL: Principal = { kind: 'local' }
const phone: Principal = { kind: 'remote', keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate', 'admin'] }
const reader: Principal = { kind: 'remote', keyId: 'k2', name: 'Watcher', audience: 'client', caps: ['read', 'operate', 'approve'] }
const thread = { kind: 'thread', sessionId: 's', environmentId: 'env_mac', title: 'Add it' } as const
const spec: AddonSpec = { transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: ['GITHUB_TOKEN'], auth: 'fields' }
const addon = (over: Partial<AddonInput> = {}): AddonInput => ({ name: 'github', workspaceId: null, spec, ...over })
const md: SkillFile = { path: 'SKILL.md', text: '---\nname: tidy\ndescription: Tidy code.\n---\n' }
const skill = (over: Partial<SkillInput> = {}): SkillInput => ({ name: 'tidy', workspaceId: null, files: [md], ...over })

let db: DatabaseSync
let deps: StoreRpcDeps
let forwarded: { method: string; params: unknown; workspaceId: string | null }[]
let forwards: boolean
let removed: string[]
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  forwarded = []
  forwards = false
  removed = []
  deps = {
    addons: new AddonStore(db),
    skills: new SkillStore(db),
    sync: {
      forward: async (method, params, workspaceId) => {
        forwarded.push({ method, params, workspaceId })
        return forwards
      },
      homeFor: (ws) => (ws === 'w-own' ? null : { name: 'box', online: true })
    },
    onAddonRemoved: (id) => removed.push(id)
  }
})
afterEach(() => db.close())

const rpc = () => storeRpc(deps)

describe('storeRpc', () => {
  it('knows its eight methods', () => {
    for (const m of ['addons.list', 'addons.set', 'addons.remove', 'addons.tools', 'skills.list', 'skills.get', 'skills.set', 'skills.remove']) expect(isStoreMethod(m)).toBe(true)
    expect(isStoreMethod('rules.set')).toBe(false)
  })

  it('stamps a person: the local socket as You, a remote key by its name', async () => {
    const a = (await rpc().handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)) as { addon: AddonRow }
    expect(a.addon).toMatchObject({ addedBy: { kind: 'person' }, writtenBy: { kind: 'person' } })
    const b = (await rpc().handle({ method: 'addons.set', params: { addon: addon() } }, reader)) as { addon: AddonRow }
    expect(b.addon).toMatchObject({ addedBy: { kind: 'person' }, writtenBy: { kind: 'person', key: 'Watcher' } })
    expect(writerOf(phone)).toEqual({ kind: 'person', key: 'Phone' })
  })

  it('keeps the writers a request carries only for an admin caller', async () => {
    const kept = (await rpc().handle({ method: 'skills.set', params: { skill: skill({ addedBy: thread, writtenBy: thread }) } }, phone)) as { skill: SkillMeta }
    expect(kept.skill).toMatchObject({ addedBy: thread, writtenBy: thread })
    const stripped = (await rpc().handle({ method: 'addons.set', params: { addon: addon({ addedBy: thread, writtenBy: thread }) } }, reader)) as { addon: AddonRow }
    expect(stripped.addon.writtenBy).toEqual({ kind: 'person', key: 'Watcher' })
    expect(stripped.addon.addedBy).toEqual({ kind: 'person', key: 'Watcher' })
  })

  it('refuses an unsafe add-on or a broken skill before anything is sent', async () => {
    await expect(rpc().handle({ method: 'addons.set', params: { addon: addon({ spec: { ...spec, args: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] } }) } }, LOCAL)).rejects.toThrow(
      /^refused: args\[0\] looks like a secret/
    )
    await expect(rpc().handle({ method: 'skills.set', params: { skill: skill({ name: 'other' }) } }, LOCAL)).rejects.toThrow('refused: SKILL.md names the skill tidy, not other')
    expect(forwarded).toEqual([])
  })

  it('sends a write to the home with its writers, and answers the row the home sent back', async () => {
    forwards = true
    // The forward lands the home's row here, as StoreSync does.
    deps.sync!.forward = async (method, params, workspaceId) => {
      forwarded.push({ method, params, workspaceId })
      if (method === 'addons.set') deps.addons.put({ ...(params as { addon: AddonInput }).addon, id: 'ad_home00000001', enabled: true, description: '', createdAt: 1, updatedAt: 1 } as AddonRow)
      return true
    }
    const res = (await rpc().handle({ method: 'addons.set', params: { addon: addon({ workspaceId: 'w1' }) } }, reader)) as { addon: AddonRow }
    expect(forwarded).toEqual([
      { method: 'addons.set', params: { addon: { ...addon({ workspaceId: 'w1' }), addedBy: { kind: 'person', key: 'Watcher' }, writtenBy: { kind: 'person', key: 'Watcher' } } }, workspaceId: 'w1' }
    ])
    expect(res.addon.id).toBe('ad_home00000001')
    expect(await rpc().handle({ method: 'addons.remove', params: { id: 'ad_home00000001' } }, LOCAL)).toEqual({ removed: true })
    // The home removed it and deletes its grant there; this host deletes nothing.
    expect(removed).toEqual([])
    expect(forwarded.at(-1)).toEqual({ method: 'addons.remove', params: { id: 'ad_home00000001' }, workspaceId: 'w1' })
  })

  it('removes here, with the grant, when the row is this host\'s own', async () => {
    const { addon: row } = (await rpc().handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)) as { addon: AddonRow }
    expect(await rpc().handle({ method: 'addons.remove', params: { id: row.id } }, LOCAL)).toEqual({ removed: true })
    expect(removed).toEqual([row.id])
    expect(await rpc().handle({ method: 'addons.remove', params: { id: row.id } }, LOCAL)).toEqual({ removed: false })
  })

  it('lists rows with this host\'s status and the named scope\'s home, and reads a skill whole', async () => {
    const { addon: row } = (await rpc().handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)) as { addon: AddonRow }
    deps.addons.setStatus(row.id, { state: 'ready', tools: 3, at: 5 })
    expect(await rpc().handle({ method: 'addons.list', params: { workspaceId: 'w-own' } }, reader)).toEqual({ addons: [row], status: { [row.id]: { state: 'ready', tools: 3, at: 5 } }, home: null })
    expect((await rpc().handle({ method: 'addons.list' }, reader)) as { home: unknown }).toMatchObject({ home: { name: 'box', online: true } })
    expect(await rpc().handle({ method: 'addons.tools', params: { id: row.id } }, reader)).toEqual({ tools: [], fetchedAt: null })
    deps.addons.setTools(row.id, [{ name: 'a', exposed: 'github__a', description: '', inputSchema: {} }], 9)
    expect(await rpc().handle({ method: 'addons.tools', params: { id: row.id } }, reader)).toMatchObject({ fetchedAt: 9 })
    const { skill: meta } = (await rpc().handle({ method: 'skills.set', params: { skill: skill() } }, LOCAL)) as { skill: SkillMeta }
    expect(await rpc().handle({ method: 'skills.list' }, reader)).toEqual({ skills: [meta], home: { name: 'box', online: true } })
    expect(await rpc().handle({ method: 'skills.get', params: { id: meta.id } }, reader)).toEqual({ skill: { ...meta, files: [md] } })
    await expect(rpc().handle({ method: 'skills.get', params: { id: 'sk_none' } }, reader)).rejects.toThrow('unknown skill: sk_none')
    expect(await rpc().handle({ method: 'skills.remove', params: { id: meta.id } }, LOCAL)).toEqual({ removed: true })
  })

  it('a host with no sync writes everything here and names no home', async () => {
    deps.sync = null
    await rpc().handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)
    expect(await rpc().handle({ method: 'addons.list' }, LOCAL)).toMatchObject({ home: null })
  })

  it('pushes each list once per burst of changes, to every listener', async () => {
    const pushes = storePushes(deps.addons, deps.skills, 10)
    const seen: string[] = []
    const off = pushes.onPush((p) => seen.push(`${p.push}:${p.push === 'addons' ? p.addons.length : p.push === 'skills' ? p.skills.length : Object.keys(p.status).length}`))
    const a = deps.addons.set(addon(), { kind: 'person' })
    deps.addons.set(addon({ name: 'linear' }), { kind: 'person' })
    deps.addons.setStatus(a.id, { state: 'ready', tools: 1, at: 1 })
    deps.skills.set(skill(), { kind: 'person' })
    expect(seen).toEqual([])
    await new Promise((r) => setTimeout(r, 30))
    expect(seen.sort()).toEqual(['addon-status:1', 'addons:2', 'skills:1'])
    off()
    deps.addons.remove(a.id)
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toHaveLength(3)
    pushes.close()
  })

  it('a refusal from the home reaches the caller, nothing written here', async () => {
    deps.sync!.forward = async () => {
      throw new Error('refused: add-ons and skills live on box; it is offline')
    }
    await expect(rpc().handle({ method: 'addons.set', params: { addon: addon() } }, LOCAL)).rejects.toThrow('live on box; it is offline')
    expect(deps.addons.list()).toEqual([])
  })
})
