import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddonSpec } from '@shared/contract-addons'
import { AddonStore, specDigest } from '../addonStore'
import { runAddonChild, type AddonChild } from './addonChild'
import { ADDON_HOST_ABSENT, ADDON_HOST_DOWN, AddonHost } from './addonHost'
import type { AddonCallResult, AddonHostLink, AddonWireMessage, ResolvedGrant } from './addonWire'
import type { AddonGrantSource } from './grants'
import { wirePair } from './testWire'

const FAKE = fileURLToPath(new URL('../../../../scripts/lib/fakeMcpServer.ts', import.meta.url))
const RUN = process.versions.bun ? [] : ['--no-warnings']
const SECRET = 'grant-secret-91c2'
const stdio: AddonSpec = { transport: 'stdio', command: process.execPath, args: [...RUN, FAKE, '--stdio'], env: ['FAKE_TOKEN'], auth: 'fields' }
const person = { kind: 'person' as const }

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A spawner whose child end the test drives: every message main sends lands in `seen`. */
function manualSpawner() {
  const children: { other: ReturnType<typeof wirePair<AddonWireMessage>>[1]; seen: AddonWireMessage[]; exit: (code: number | null) => void }[] = []
  const spawn = (): AddonHostLink => {
    const [main, other] = wirePair<AddonWireMessage>()
    const seen: AddonWireMessage[] = []
    let onExit: (code: number | null) => void = () => {}
    other.onMessage((m) => seen.push(m))
    children.push({ other, seen, exit: (code) => onExit(code) })
    return { wire: main, kill: () => {}, onExit: (fn) => void (onExit = fn) }
  }
  return { spawn, children }
}

const hosts: AddonHost[] = []
const childs: AddonChild[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  await Promise.all(childs.splice(0).map((c) => c.stop()))
  vi.restoreAllMocks()
})

function setup(opts: { spawnChild?: () => AddonHostLink; grants?: AddonGrantSource; platform?: string; retryMs?: number } = {}) {
  const store = new AddonStore(new DatabaseSync(':memory:'))
  const grants: AddonGrantSource = opts.grants ?? { read: async (id) => ({ v: 1, mintedBy: 'app', addonId: id, fields: { FAKE_TOKEN: SECRET } }) }
  const host = new AddonHost({
    store,
    spawnChild: opts.spawnChild,
    grants,
    platform: () => opts.platform ?? 'linux',
    baseEnv: async () => ({ PATH: process.env.PATH ?? '' }),
    cwd: () => tmpdir(),
    retryMs: opts.retryMs
  })
  hosts.push(host)
  return { store, host }
}

describe('AddonHost', () => {
  it('with no spawner every add-on reads ADDON_HOST_ABSENT; off and other-platform are decided without a launch', async () => {
    const { store, host } = setup({ platform: 'linux' })
    const on = store.set({ name: 'on', workspaceId: null, spec: stdio }, person)
    const off = store.set({ name: 'off', workspaceId: null, spec: stdio, enabled: false }, person)
    const mac = store.set({ name: 'mac', workspaceId: null, spec: { ...stdio, platforms: ['darwin'] } }, person)
    await host.start()
    const s = store.status()
    expect(s[on.id]).toMatchObject({ state: 'failed', detail: ADDON_HOST_ABSENT })
    expect(s[off.id]).toMatchObject({ state: 'off' })
    expect(s[mac.id]).toMatchObject({ state: 'other-platform' })
    await expect(host.call(on.id, 'echo', {})).rejects.toThrow(`refused: on is failed: ${ADDON_HOST_ABSENT}`)
  })

  it('runs a real child: grant answered from the source, status and tools into the store, a call through, nothing secret anywhere', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const sent: AddonWireMessage[] = []
    const spawnChild = (): AddonHostLink => {
      const [main, other] = wirePair<AddonWireMessage>()
      const post = main.post
      main.post = (m) => {
        sent.push(m)
        post(m)
      }
      childs.push(runAddonChild(other, { watchMainMs: 0, exit: () => {} }))
      return { wire: main, kill: () => {}, onExit: () => {} }
    }
    const { store, host } = setup({ spawnChild })
    const row = store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    const changed: string[] = []
    host.onChange((id) => changed.push(id))
    await host.start()
    await until(() => store.status()[row.id]?.state === 'ready')
    expect(changed).toContain(row.id)
    const tools = host.tools(row.id)
    expect(tools.find((t) => t.name === 'echo')).toMatchObject({ exposed: 'fake__echo' })
    expect(tools.find((t) => t.name === 'read')).toMatchObject({ exposed: 'fake__read', readOnly: true })
    const result: AddonCallResult = await host.call(row.id, 'echo', { text: 'through' })
    expect(result.content).toEqual([{ type: 'text', text: 'through' }])
    const start = sent.find((m) => m.t === 'start')
    expect(JSON.stringify(start)).not.toContain(SECRET)
    expect(sent.filter((m) => m.t !== 'reply').map((m) => JSON.stringify(m)).join('')).not.toContain(SECRET)
    expect(sent.some((m) => m.t === 'reply' && JSON.stringify(m).includes(SECRET))).toBe(true)
    for (const spy of logs) for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(SECRET)
    expect(host.status()).toMatchObject({ restarts: 0, down: false })
    expect(host.status().pid).toBe(process.pid)
  })

  it('drops a tools list under a stale digest and follows the launches when a row changes', async () => {
    const m = manualSpawner()
    const { store, host } = setup({ spawnChild: m.spawn })
    const row = store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    await host.start()
    await until(() => m.children[0]!.seen.some((x) => x.t === 'start'))
    const child = m.children[0]!.other
    child.post({ t: 'ready', pid: 4242 })
    child.post({ t: 'event', event: { e: 'tools', addonId: row.id, specDigest: 'stale', tools: [{ name: 'echo', description: '', inputSchema: {} }] } })
    child.post({ t: 'event', event: { e: 'status', addonId: row.id, status: { state: 'ready', tools: 1, at: 1 } } })
    await until(() => store.status()[row.id]?.state === 'ready')
    expect(host.tools(row.id)).toEqual([])
    child.post({ t: 'event', event: { e: 'tools', addonId: row.id, specDigest: specDigest(stdio), tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] } })
    await until(() => host.tools(row.id).length === 1)
    store.set({ id: row.id, name: 'fake', workspaceId: null, spec: { ...stdio, args: [...stdio.args, '--many', '3'] } }, person)
    await until(() => m.children[0]!.seen.some((x) => x.t === 'launches'))
    const launches = m.children[0]!.seen.find((x) => x.t === 'launches') as Extract<AddonWireMessage, { t: 'launches' }>
    expect(launches.launches[0]!.specDigest).not.toBe(specDigest(stdio))
    expect(host.status().pid).toBe(4242)
  })

  it('an unauthorized event refreshes the grant, then drops it', async () => {
    const m = manualSpawner()
    const order: string[] = []
    const grants: AddonGrantSource = { read: async () => null, refresh: async (id) => void order.push(`refresh ${id}`) }
    const { store, host } = setup({ spawnChild: m.spawn, grants })
    const row = store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    await host.start()
    await until(() => m.children[0]!.seen.some((x) => x.t === 'start'))
    m.children[0]!.other.post({ t: 'event', event: { e: 'unauthorized', addonId: row.id } })
    await until(() => m.children[0]!.seen.some((x) => x.t === 'grants.drop'))
    expect(order).toEqual([`refresh ${row.id}`])
    expect(m.children[0]!.seen.find((x) => x.t === 'grants.drop')).toEqual({ t: 'grants.drop', addonId: row.id })
    // An ask for a grant the source lacks answers the gaps.
    m.children[0]!.other.post({ t: 'ask', id: 7, call: { m: 'grant', addonId: row.id } })
    await until(() => m.children[0]!.seen.some((x) => x.t === 'reply' && x.id === 7))
    expect(m.children[0]!.seen.find((x) => x.t === 'reply' && x.id === 7)).toMatchObject({ ok: true, value: { ok: false, gaps: ['FAKE_TOKEN'] } as ResolvedGrant })
  })

  it('respawns with the launches; three exits in a minute leave every add-on failed until the retry', async () => {
    const m = manualSpawner()
    const { store, host } = setup({ spawnChild: m.spawn, retryMs: 200 })
    const row = store.set({ name: 'fake', workspaceId: null, spec: stdio }, person)
    await host.start()
    await until(() => m.children[0]!.seen.some((x) => x.t === 'start'))
    m.children[0]!.exit(1)
    await until(() => m.children[1]?.seen.some((x) => x.t === 'start') ?? false)
    const replay = m.children[1]!.seen.find((x) => x.t === 'start') as Extract<AddonWireMessage, { t: 'start' }>
    expect(replay.state.launches.map((l) => l.id)).toEqual([row.id])
    expect(host.status().restarts).toBe(1)
    m.children[1]!.exit(1)
    await until(() => m.children.length === 3)
    m.children[2]!.exit(1)
    expect(store.status()[row.id]).toMatchObject({ state: 'failed', detail: ADDON_HOST_DOWN })
    expect(host.status()).toMatchObject({ down: true, pid: null })
    expect(m.children.length).toBe(3)
    await until(() => m.children.length === 4, 2_000)
    expect(host.status().down).toBe(false)
  })
})
