import { describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { startOnHostOf } from '@shared/projectLinks'
import { ThreadDefaultsSchema } from '@shared/defaults'

/** "New threads start on": the project's own value rides its row, its
 *  settings bundle and the stamp the follower compares (projectSettingsSync). */
function world() {
  const db = openDb(':memory:')
  const store = new Store(db)
  store.insertWorkspace({ id: 'w', name: 'w', path: '/w', git: true, createdAt: 1 })
  store.insertProject({ id: 'p', workspaceId: 'w', name: 'P', mode: 'local', branch: null, cwd: '/w', archived: false, createdAt: 1 })
  return { db, store, registry: new SessionRegistry(store) }
}

describe('a project’s New threads start on', () => {
  it('reads null until set, round-trips, and stamps the project’s settings', () => {
    const { db, store, registry } = world()
    expect(store.getProject('p')?.startOn).toBeNull()
    expect(registry.getProjectSettings('p').startOn).toBeNull()
    registry.setProjectStartOn('p', 'mac')
    expect(store.getProject('p')).toMatchObject({ startOn: 'mac' })
    expect(store.getProject('p')?.settingsUpdatedAt).toEqual(expect.any(Number))
    expect(registry.getProjectSettings('p').startOn).toBe('mac')
    registry.setProjectStartOn('p', null)
    expect(store.getProject('p')?.startOn).toBeNull()
    expect(() => registry.setProjectStartOn('nope', 'box')).toThrow(/unknown project/)
    db.close()
  })

  it('the bundle writes it whole; an older host’s bundle without it leaves it as it is', () => {
    const { db, store, registry } = world()
    const bundle = registry.getProjectSettings('p')
    registry.setProjectSettings('p', { ...bundle, startOn: 'box' }, 5)
    expect(store.getProject('p')).toMatchObject({ startOn: 'box', settingsUpdatedAt: 5 })
    const { startOn: _old, ...older } = registry.getProjectSettings('p')
    registry.setProjectSettings('p', older, 6)
    expect(store.getProject('p')?.startOn).toBe('box')
    registry.setProjectSettings('p', { ...older, startOn: null }, 7)
    expect(store.getProject('p')?.startOn).toBeNull()
    db.close()
  })
})

describe('startOnHostOf', () => {
  const platforms: Record<string, string | undefined> = { env_mac: 'darwin', env_box: 'linux', env_new: undefined }
  const copies = [{ environmentId: 'env_mac' }, { environmentId: 'env_box' }]
  it('the box is a host that is not a Mac, the Mac one that is, none when no copy sits there', () => {
    expect(startOnHostOf(copies, (id) => platforms[id], 'box')).toBe('env_box')
    expect(startOnHostOf(copies, (id) => platforms[id], 'mac')).toBe('env_mac')
    expect(startOnHostOf([{ environmentId: 'env_mac' }], (id) => platforms[id], 'box')).toBeNull()
    // A host not heard from yet counts as not a Mac, as settingsHomeOf reads it.
    expect(startOnHostOf([{ environmentId: 'env_new' }], (id) => platforms[id], 'box')).toBe('env_new')
  })
})

describe('Thread defaults carry it', () => {
  it('parses with and without the field', () => {
    expect(ThreadDefaultsSchema.parse({ startOn: 'mac' }).startOn).toBe('mac')
    expect(ThreadDefaultsSchema.parse({}).startOn).toBeUndefined()
    expect(() => ThreadDefaultsSchema.parse({ startOn: 'phone' })).toThrow()
  })
})
