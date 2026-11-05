import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import { PeerCatalogs } from '../peerCatalogs'
import { DEFAULT_RULES, type OrchestrationRules } from '@shared/rules'
import { RulesSync, SEEDED_KEY, refusal } from './rulesSync'

// Two real registries: the Mac (this host, the follower) and the box (the
// settings home), joined by a fake peer link that answers the box's RPCs the
// way server/index.ts does.

const MAC = 'env_mac'
const BOX = 'env_box'
const WS_LINK = 'wl_temp'

const MUSE_CATALOG = {
  muse: {
    id: 'muse',
    label: 'Muse Code',
    models: [{ id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    defaultModel: 'muse-wonder-full-1.0'
  }
}
const BOX_CATALOG = { muse: { id: 'muse', label: 'Muse Code', models: [], defaultModel: 'muse-spark-1.3' } }

interface World {
  dbs: ReturnType<typeof openDb>[]
  mac: SessionRegistry
  macStore: Store
  box: SessionRegistry
  link: {
    id: string
    env: { id: string; name: string }
    connected: boolean
    build: { platform: string } | null
    calls: string[]
    /** Methods the box answers as an older build would: unknown. */
    unknown: Set<string>
    /** The next rules.get is read now and answered once this resolves. */
    hold: Promise<void> | null
    /** What the Mac sent with catalog.exchange. */
    sentCatalog: unknown
    request: <T>(method: string, params?: unknown) => Promise<T>
  }
  peerCatalogs: PeerCatalogs
  logs: string[]
  sync: RulesSync
}

function host(id: string, path: string, linked: boolean): { db: ReturnType<typeof openDb>; store: Store; registry: SessionRegistry } {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: `w-${id}`, name: 'temp-code', path, git: true, createdAt: 1 })
  if (linked) store.setWorkspaceLink(`w-${id}`, WS_LINK)
  return { db, store, registry: new SessionRegistry(store) }
}

function world(opts: { macLinked?: boolean } = {}): World {
  const mac = host(MAC, '/Users/me/IdeaProjects/temp-code', opts.macLinked !== false)
  const box = host(BOX, '/srv/agents/work/temp-code', true)
  const b = box.registry
  const link: World['link'] = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    build: { platform: 'linux' },
    calls: [],
    unknown: new Set(),
    hold: null,
    sentCatalog: null,
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      if (link.unknown.has(method)) throw new Error(`unknown method ${method}`)
      link.calls.push(method)
      const p = (params ?? {}) as Record<string, any>
      switch (method) {
        case 'workspace.list':
          return b.listWorkspaces() as T
        case 'catalog.exchange':
          link.sentCatalog = p.catalog
          return { catalog: BOX_CATALOG } as T
        case 'rules.get': {
          const scoped = b.getOrchestrationRules(p.workspaceId)
          const answer = { rules: scoped ?? b.getOrchestrationRules(null) ?? DEFAULT_RULES, overridden: scoped !== null }
          const held = link.hold
          link.hold = null
          if (held) await held
          return answer as T
        }
        case 'rules.set':
          b.setOrchestrationRules(p.workspaceId, p.rules)
          return null as T
        case 'defaults.get': {
          const scoped = b.getThreadDefaults(p.workspaceId)
          return { defaults: scoped, overridden: scoped !== null } as T
        }
        case 'defaults.set':
          b.setThreadDefaults(p.workspaceId, p.defaults)
          return null as T
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const peers = { get: (id: string) => (id === BOX ? link : undefined), all: () => [link] }
  const peerCatalogs = new PeerCatalogs(mac.store)
  const logs: string[] = []
  const sync = new RulesSync({
    environmentId: MAC,
    platform: 'darwin',
    registry: mac.registry,
    store: mac.store,
    peers: peers as never,
    catalog: () => MUSE_CATALOG,
    peerCatalogs,
    log: (line) => logs.push(line)
  })
  return { dbs: [mac.db, box.db], mac: mac.registry, macStore: mac.store, box: b, link, peerCatalogs, logs, sync }
}

const withModel = (rules: OrchestrationRules, key: string, policy: OrchestrationRules['models'][string]): OrchestrationRules => ({
  ...rules,
  models: { ...rules.models, [key]: policy }
})

let w: World
beforeEach(() => {
  w = world()
})
afterEach(() => {
  w.sync.close()
  for (const db of w.dbs) db.close()
})

describe('one copy on the box', () => {
  it('seeds each shared scope from the Mac once, then follows the box', async () => {
    const mine = withModel(DEFAULT_RULES, 'muse:muse-spark-1.3', { approved: false })
    w.mac.setOrchestrationRules(null, mine)
    await w.sync.syncWith(BOX)
    expect(w.box.getOrchestrationRules(null)).toEqual(mine)
    expect(JSON.parse(w.macStore.getSetting(`${SEEDED_KEY}${BOX}`)!)).toEqual(['global', WS_LINK])
    // From then on the box's edit wins.
    const theirs = withModel(mine, 'muse:muse-spark-1.3', { approved: true })
    w.box.setOrchestrationRules(null, theirs)
    await w.sync.syncWith(BOX)
    expect(w.mac.getOrchestrationRules(null)).toEqual(theirs)
  })

  it('a rule for a model only the Mac runs is stored on the box and read back here', async () => {
    await w.sync.syncWith(BOX)
    const next = withModel(DEFAULT_RULES, 'muse:muse-wonder-full-1.0', { approved: true, minReasoning: 'low', maxReasoning: 'xhigh' })
    expect(await w.sync.forward('rules.set', null, next)).toBe(true)
    // The box keeps a policy for a model its own catalog has no row for.
    expect(w.box.getOrchestrationRules(null)?.models['muse:muse-wonder-full-1.0']).toEqual({ approved: true, minReasoning: 'low', maxReasoning: 'xhigh' })
    expect(w.mac.getOrchestrationRules(null)).toEqual(w.box.getOrchestrationRules(null))
  })

  it('a workspace override is kept under each host its own workspace id, met by the link id', async () => {
    await w.sync.syncWith(BOX)
    const override = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: false })
    expect(await w.sync.forward('rules.set', `w-${MAC}`, override)).toBe(true)
    expect(w.box.getOrchestrationRules(`w-${BOX}`)).toEqual(override)
    expect(w.mac.getOrchestrationRules(`w-${MAC}`)).toEqual(override)
    expect(w.box.getOrchestrationRules(`w-${MAC}`)).toBeNull()
  })

  it('a pull read before a forward never writes its older answer over it', async () => {
    const r1 = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: true })
    w.mac.setOrchestrationRules(null, r1)
    await w.sync.syncWith(BOX)
    let release!: () => void
    w.link.hold = new Promise<void>((r) => (release = r))
    const pull = w.sync.syncWith(BOX)
    // Let the pull reach its rules.get, which reads r1 and waits.
    for (let i = 0; i < 20 && w.link.hold; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.link.hold).toBeNull()
    const r2 = withModel(r1, 'codex:gpt-6-astra', { approved: false })
    await w.sync.forward('rules.set', null, r2)
    expect(w.mac.getOrchestrationRules(null)).toEqual(r2)
    release()
    await pull
    expect(w.mac.getOrchestrationRules(null)).toEqual(r2)
    expect(w.box.getOrchestrationRules(null)).toEqual(r2)
  })

  it('a write while the box is out of reach is refused and nothing changes here', async () => {
    const r1 = withModel(DEFAULT_RULES, 'codex:gpt-6-astra', { approved: true })
    w.mac.setOrchestrationRules(null, r1)
    await w.sync.syncWith(BOX)
    w.link.connected = false
    await expect(w.sync.forward('rules.set', null, withModel(r1, 'codex:gpt-6-astra', { approved: false }))).rejects.toThrow(refusal('box'))
    await expect(w.sync.forward('defaults.set', null, { provider: 'codex', model: '', reasoning: 'high', permission: 'auto' })).rejects.toThrow(refusal('box'))
    expect(w.mac.getOrchestrationRules(null)).toEqual(r1)
    expect(w.mac.getThreadDefaults(null)).toBeNull()
  })

  it('says where each scope lives: the box while it answers, offline when not, nothing for a workspace of its own', async () => {
    expect(w.sync.homeFor(null)).toBeNull()
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: true })
    expect(w.sync.homeFor(`w-${MAC}`)).toEqual({ name: 'box', online: true })
    w.link.connected = false
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: false })
    w.sync.close()
    w.dbs.forEach((db) => db.close())
    w = world({ macLinked: false })
    await w.sync.syncWith(BOX)
    expect(w.sync.homeFor(null)).toEqual({ name: 'box', online: true })
    expect(w.sync.homeFor(`w-${MAC}`)).toBeNull()
  })
})

describe('the catalogs', () => {
  it('each pull sends this host its catalog and keeps the box its own', async () => {
    await w.sync.syncWith(BOX)
    expect(w.link.sentCatalog).toEqual(MUSE_CATALOG)
    expect(w.peerCatalogs.get(BOX)?.muse?.models).toEqual([])
  })

  it('a box that predates the exchange still syncs the rules, and says so once', async () => {
    w.link.unknown.add('catalog.exchange')
    const mine = withModel(DEFAULT_RULES, 'muse:muse-spark-1.3', { approved: false })
    w.mac.setOrchestrationRules(null, mine)
    await w.sync.syncWith(BOX)
    await w.sync.syncWith(BOX)
    expect(w.box.getOrchestrationRules(null)).toEqual(mine)
    expect(w.peerCatalogs.get(BOX)).toBeNull()
    expect(w.logs.filter((l) => l.includes('no catalog exchange'))).toHaveLength(1)
  })
})
