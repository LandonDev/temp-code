import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from '../db'
import { SessionRegistry } from '../sessions'
import type { ProjectSettingsBundle } from '@shared/projectLinks'
import { PROJECT_SETTINGS_DEBOUNCE_MS, ProjectSettingsSync, refusal } from './projectSettingsSync'

// Two real registries: the Mac (this host, the follower) and the box (the
// settings home), joined by a fake peer link that answers the box's RPCs.

const MAC = 'env_mac'
const BOX = 'env_box'
const LINK = 'pl_rail'

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
    request: <T>(method: string, params?: unknown) => Promise<T>
  }
  sync: ProjectSettingsSync
}

function host(id: string, project: string, path: string, linkId: string | null): { db: ReturnType<typeof openDb>; store: Store; registry: SessionRegistry } {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: `w-${id}`, name: 'temp-code', path, git: true, createdAt: 1 })
  store.insertProject({ id: project, workspaceId: `w-${id}`, name: 'Rail', mode: 'local', branch: null, cwd: path, archived: false, createdAt: 1 })
  if (linkId) store.setProjectLink(project, linkId)
  return { db, store, registry: new SessionRegistry(store) }
}

function world(opts: { macLinked?: boolean } = {}): World {
  const mac = host(MAC, 'p-mac', '/Users/me/IdeaProjects/temp-code', opts.macLinked === false ? null : LINK)
  const box = host(BOX, 'p-box', '/srv/agents/work/temp-code', LINK)
  const b = box.registry
  const link: World['link'] = {
    id: BOX,
    env: { id: BOX, name: 'box' },
    connected: true,
    build: { platform: 'linux' },
    calls: [],
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error('box is not connected')
      link.calls.push(method)
      const p = (params ?? {}) as Record<string, any>
      switch (method) {
        case 'project.list':
          return b.listProjects() as T
        case 'project.settings.get':
          return b.getProjectSettings(p.projectId) as T
        case 'project.settings.set':
          b.setProjectSettings(p.projectId, p.bundle)
          return null as T
        case 'project.setPreamble':
          b.setProjectPreamble(p.projectId, p.preamble, p.enabled)
          return null as T
        case 'project.rename':
          b.renameProject(p.projectId, p.name)
          return null as T
        case 'project.archive':
          await b.archiveProject(p.projectId, p.archived, p.cleanup)
          return null as T
        case 'build.set':
          if (p.workspaceId !== 'w-env_box') throw new Error(`wrong workspace ${p.workspaceId}`)
          b.setProjectBuild(p.projectId, p.config)
          return null as T
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const peers = { get: (id: string) => (id === BOX ? link : undefined), all: () => [link] }
  const sync = new ProjectSettingsSync({
    environmentId: MAC,
    platform: 'darwin',
    registry: mac.registry,
    store: mac.store,
    peers: peers as never,
    log: () => {}
  })
  return { dbs: [mac.db, box.db], mac: mac.registry, macStore: mac.store, box: b, link, sync }
}

const bundle = (b: SessionRegistry, patch: Partial<ProjectSettingsBundle>): ProjectSettingsBundle => ({ ...b.getProjectSettings('p-box'), ...patch })

let w: World
beforeEach(() => {
  w = world()
})
afterEach(() => {
  w.sync.close()
  for (const db of w.dbs) db.close()
  vi.useRealTimers()
})

describe('the follower', () => {
  it('a link-up pulls the home bundle under the local id, with the home stamp', async () => {
    vi.useFakeTimers()
    w.box.setProjectSettings('p-box', bundle(w.box, { preamble: 'BOX RULES', review: null }), 5_000)
    w.sync.linkUp(BOX)
    await vi.advanceTimersByTimeAsync(PROJECT_SETTINGS_DEBOUNCE_MS + 10)
    const mine = w.mac.getProjectSettings('p-mac')
    expect(mine.preamble).toBe('BOX RULES')
    expect(mine.updatedAt).toBe(5_000)
    expect(w.mac.getProject('p-mac')?.settingsUpdatedAt).toBe(5_000)
  })

  it('an older home stamp does not overwrite, and an equal one pulls nothing', async () => {
    w.mac.setProjectSettings('p-mac', { ...w.mac.getProjectSettings('p-mac'), preamble: 'MAC' }, 9_000)
    w.box.setProjectSettings('p-box', bundle(w.box, { preamble: 'OLD BOX' }), 5_000)
    await w.sync.syncWith(BOX)
    expect(w.mac.getProjectSettings('p-mac').preamble).toBe('MAC')
    expect(w.link.calls).not.toContain('project.settings.get')
  })

  it('a home that never stamped takes this copy once, keeping its own name', async () => {
    w.mac.setProjectPreamble('p-mac', 'MINE', true)
    w.mac.renameProject('p-mac', 'Rail here')
    await w.sync.syncWith(BOX)
    expect(w.box.getProjectSettings('p-box').preamble).toBe('MINE')
    expect(w.box.getProject('p-box')?.name).toBe('Rail')
    const stamp = w.box.getProject('p-box')?.settingsUpdatedAt
    expect(stamp).not.toBeNull()
    expect(w.mac.getProject('p-mac')?.settingsUpdatedAt).toBe(stamp)
    // a forwarded write keeps the seeded preamble
    await w.sync.forward('p-mac', 'build.set', { projectId: 'p-mac', workspaceId: 'w-env_mac', config: null })
    expect(w.mac.getProjectSettings('p-mac').preamble).toBe('MINE')
    w.link.calls.length = 0
    await w.sync.syncWith(BOX)
    expect(w.link.calls).toEqual(['project.list'])
  })

  it('a copy with nothing set seeds nothing', async () => {
    await w.sync.syncWith(BOX)
    expect(w.link.calls).toEqual(['project.list'])
    expect(w.box.getProject('p-box')?.settingsUpdatedAt).toBeNull()
  })

  it('a rename on the home follows on its projects push', async () => {
    vi.useFakeTimers()
    w.box.renameProject('p-box', 'Rail v2')
    w.sync.onPeerPush(BOX, { push: 'projects', projects: w.box.listProjects() })
    await vi.advanceTimersByTimeAsync(PROJECT_SETTINGS_DEBOUNCE_MS + 10)
    expect(w.mac.getProject('p-mac')?.name).toBe('Rail v2')
  })

  it('an archive on the home follows', async () => {
    await w.box.archiveProject('p-box', true)
    await w.sync.syncWith(BOX)
    expect(w.mac.getProject('p-mac')?.archived).toBe(true)
  })

  it('a burst of pushes is one pull', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 5; i++) w.sync.onPeerPush(BOX, { push: 'projects', projects: w.box.listProjects() })
    await vi.advanceTimersByTimeAsync(PROJECT_SETTINGS_DEBOUNCE_MS + 10)
    expect(w.link.calls.filter((m) => m === 'project.list')).toHaveLength(1)
  })

  it('never writes toward a home that has stamped', async () => {
    w.box.setProjectSettings('p-box', bundle(w.box, { preamble: 'BOX' }), 5_000)
    w.mac.setProjectSettings('p-mac', { ...w.mac.getProjectSettings('p-mac'), preamble: 'MAC' }, 9_000)
    await w.sync.syncWith(BOX)
    expect(w.link.calls).toEqual(['project.list'])
  })
})

describe('the settings home', () => {
  it('names the box over the Mac', async () => {
    await w.sync.syncWith(BOX)
    expect(w.sync.homeOf(LINK)).toBe(BOX)
  })

  it('a write with the home reachable lands on the home, and the copy follows with its stamp', async () => {
    await w.sync.syncWith(BOX)
    const sent = await w.sync.forward('p-mac', 'project.setPreamble', { projectId: 'p-mac', preamble: 'SAVED ON THE BOX', enabled: true })
    expect(sent).toBe(true)
    expect(w.box.getProjectSettings('p-box').preamble).toBe('SAVED ON THE BOX')
    expect(w.mac.getProjectSettings('p-mac').preamble).toBe('SAVED ON THE BOX')
    expect(w.mac.getProject('p-mac')?.settingsUpdatedAt).toBe(w.box.getProject('p-box')?.settingsUpdatedAt)
    // The next pull has nothing to do.
    w.link.calls = []
    await w.sync.syncWith(BOX)
    expect(w.link.calls).toEqual(['project.list'])
  })

  it('maps the workspace id of a setter that carries one', async () => {
    await w.sync.syncWith(BOX)
    const config = { command: 'bun run build', outputs: '' }
    await w.sync.forward('p-mac', 'build.set', { workspaceId: 'w-env_mac', projectId: 'p-mac', config })
    expect(w.box.getProjectBuild('p-box')).toEqual(config)
    expect(w.mac.getProjectBuild('p-mac')).toEqual(config)
  })

  it('a rename and an archive from here are written on the home first', async () => {
    await w.sync.syncWith(BOX)
    await w.sync.forward('p-mac', 'project.rename', { projectId: 'p-mac', name: 'Renamed' })
    await w.sync.forward('p-mac', 'project.archive', { projectId: 'p-mac', archived: true })
    expect(w.box.getProject('p-box')).toMatchObject({ name: 'Renamed', archived: true })
    expect(w.mac.getProject('p-mac')).toMatchObject({ name: 'Renamed', archived: true })
  })

  it('a home out of reach refuses, and nothing is written here', async () => {
    await w.sync.syncWith(BOX)
    const before = w.mac.getProjectSettings('p-mac')
    w.link.connected = false
    await expect(w.sync.forward('p-mac', 'project.setPreamble', { projectId: 'p-mac', preamble: 'X', enabled: true })).rejects.toThrow(
      'refused: settings of Rail live on box; it is offline'
    )
    expect(w.mac.getProjectSettings('p-mac')).toEqual(before)
  })

  it('remembers the home across a restart: a cold Mac with the box down still refuses', async () => {
    await w.sync.syncWith(BOX)
    w.link.connected = false
    w.link.build = null
    const cold = new ProjectSettingsSync({
      environmentId: MAC,
      platform: 'darwin',
      registry: w.mac,
      store: w.macStore,
      peers: { get: () => w.link, all: () => [w.link] } as never,
      log: () => {}
    })
    expect(() => cold.route('p-mac')).toThrow(refusal('Rail', 'box'))
  })

  it('an unlinked project is written here as before', async () => {
    const solo = world({ macLinked: false })
    await solo.sync.syncWith(BOX)
    expect(await solo.sync.forward('p-mac', 'project.setPreamble', { projectId: 'p-mac', preamble: 'X', enabled: true })).toBe(false)
    expect(await solo.sync.forward(null, 'review.set', { projectId: null, settings: null })).toBe(false)
    solo.sync.close()
    for (const db of solo.dbs) db.close()
  })

  it('a linked project with no copy heard from a peer, or whose home is this host, is written here', async () => {
    // Nothing remembered yet: no peer is known to hold a copy.
    expect(w.sync.route('p-mac')).toEqual({ kind: 'local' })
    // On the box itself (it sorts first among two Linux hosts, or is the only non-darwin one), nothing changes.
    const onBox = new ProjectSettingsSync({
      environmentId: 'env_a',
      platform: 'linux',
      registry: w.mac,
      store: w.macStore,
      peers: { get: () => ({ ...w.link, id: 'env_b', build: { platform: 'darwin' } }), all: () => [{ ...w.link, id: 'env_b', build: { platform: 'darwin' } }] } as never,
      log: () => {}
    })
    w.macStore.setSetting('project-settings-sync:peer:env_b', JSON.stringify({ platform: 'darwin', projects: [{ id: 'p-box', workspaceId: 'w-env_box', linkId: LINK, name: 'Rail' }] }))
    expect(onBox.homeOf(LINK)).toBe('env_a')
    expect(onBox.route('p-mac')).toEqual({ kind: 'local' })
  })
})
