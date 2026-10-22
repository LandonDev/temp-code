import { describe, expect, it } from 'vitest'
import { resolveProjectHome, type HostFacts } from './projectHome'
import type { ProjectMeta } from './tcserver/types'

const row = (environmentId: string, id: string, linkId?: string): ProjectMeta => ({
  id,
  workspaceId: 'w',
  name: 'Alpha',
  mode: 'local',
  branch: null,
  cwd: '/x',
  archived: false,
  createdAt: 1,
  environmentId,
  ...(linkId ? { linkId } : {})
})

// Slots: `local` is this Mac (host env_mac); env_box and env_box2 are boxes.
const facts = (over: { platforms?: Record<string, string | undefined>; offline?: string[] } = {}): HostFacts => ({
  hostIdOf: (slot) => (slot === 'local' ? 'env_mac' : slot),
  platformOf: (slot) =>
    over.platforms && slot in over.platforms ? over.platforms[slot] : slot === 'local' ? 'darwin' : 'linux',
  nameOf: (slot) => (slot === 'local' ? 'this Mac' : slot.replace('env_', '')),
  isOpen: (slot) => !(over.offline ?? []).includes(slot)
})

describe('resolveProjectHome', () => {
  it('an unlinked project is its own home', () => {
    const p = row('local', 'p1')
    const at = resolveProjectHome(p, [p, row('env_box', 'p2')], facts())
    expect(at).toMatchObject({ home: p, linked: false, open: true, blocked: null })
  })

  it('a link held by one host only is not linked', () => {
    const p = row('local', 'p1', 'pl_1')
    expect(resolveProjectHome(p, [p], facts()).linked).toBe(false)
  })

  it('the box copy is the home, from either side, with the catalog’s fresh row', () => {
    const mac = row('local', 'p1', 'pl_1')
    const box = row('env_box', 'p2', 'pl_1')
    const fresh = { ...mac, name: 'Renamed' }
    const fromMac = resolveProjectHome(mac, [fresh, box], facts())
    expect(fromMac.home).toBe(box)
    expect(fromMac.copies).toEqual([fresh, box])
    expect(fromMac).toMatchObject({ linked: true, hostName: 'box', open: true, blocked: null })
    expect(resolveProjectHome(box, [fresh, box], facts()).home).toBe(box)
  })

  it('two boxes: the host id sorting first; a host not heard from counts as a box', () => {
    const a = row('env_box2', 'p1', 'pl_1')
    const b = row('env_box', 'p2', 'pl_1')
    expect(resolveProjectHome(a, [a, b], facts()).home).toBe(b)
    const mac = row('local', 'p3', 'pl_1')
    expect(resolveProjectHome(mac, [mac, a], facts({ platforms: { env_box2: undefined } })).home).toBe(a)
  })

  it('a home whose link is down blocks with the reason', () => {
    const mac = row('local', 'p1', 'pl_1')
    const box = row('env_box', 'p2', 'pl_1')
    expect(resolveProjectHome(mac, [mac, box], facts({ offline: ['env_box'] }))).toMatchObject({
      home: box,
      open: false,
      blocked: 'box is offline'
    })
  })
})
