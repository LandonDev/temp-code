// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { HostGlyph } from './HostGlyph'

/** The registry as the glyph reads it: the hosts, each one's saved platform and live hello. */
const h = vi.hoisted(() => ({
  environments: [] as { id: string; name: string; platform?: string }[],
  hellos: new Map<string, { build?: { platform: string } }>(),
  listeners: new Set<() => void>(),
  native: 'darwin'
}))

vi.mock('../lib/connection/status', () => ({ useEnvironments: () => h.environments }))
vi.mock('../lib/connection/registry', () => ({
  LOCAL_ENVIRONMENT_ID: 'local',
  registry: {
    statusOf: (id: string) => ({ lastHello: h.hellos.get(id) ?? null }),
    environment: (id: string) => h.environments.find((e) => e.id === id),
    subscribe: (fn: () => void) => {
      h.listeners.add(fn)
      return () => h.listeners.delete(fn)
    }
  }
}))
vi.mock('../lib/native', () => ({ nativePlatform: () => h.native }))

const TWO = [
  { id: 'local', name: 'This Mac' },
  { id: 'env_box', name: 'The box' }
]
const glyph = (c: HTMLElement) => c.querySelector('[data-host-glyph]')

afterEach(() => {
  cleanup()
  h.environments = []
  h.hellos.clear()
  h.native = 'darwin'
})

describe('HostGlyph', () => {
  it('draws nothing while the window knows one host, or for a row with no host', () => {
    h.environments = [TWO[0]]
    expect(glyph(render(<HostGlyph environmentId="local" />).container)).toBeNull()
    h.environments = TWO
    expect(glyph(render(<HostGlyph environmentId={undefined} />).container)).toBeNull()
  })

  it('a laptop for a Mac, a server for anything else, the host name on hover', () => {
    h.environments = [TWO[0], { ...TWO[1], platform: 'linux' }]
    const mac = glyph(render(<HostGlyph environmentId="local" />).container)!
    expect(mac.getAttribute('data-host-kind')).toBe('mac')
    expect(mac.getAttribute('title')).toBe('This Mac')
    expect(mac.getAttribute('aria-label')).toBe('This Mac')
    expect(mac.className).toContain('text-content/45')
    expect(mac.querySelector('svg')).not.toBeNull()
    const box = glyph(render(<HostGlyph environmentId="env_box" />).container)!
    expect(box.getAttribute('data-host-kind')).toBe('server')
    expect(box.getAttribute('title')).toBe('The box')
  })

  it('reads the live hello first, the saved platform before it, and preload for this machine', () => {
    // Saved as a Mac (a mirror paint before the socket), then the hello says linux.
    h.environments = [TWO[0], { ...TWO[1], platform: 'darwin' }]
    const { container } = render(<HostGlyph environmentId="env_box" />)
    expect(glyph(container)!.getAttribute('data-host-kind')).toBe('mac')
    act(() => {
      h.hellos.set('env_box', { build: { platform: 'linux' } })
      for (const fn of h.listeners) fn()
    })
    expect(glyph(container)!.getAttribute('data-host-kind')).toBe('server')
    // This machine before its hello: preload's platform.
    h.native = 'linux'
    expect(glyph(render(<HostGlyph environmentId="local" />).container)!.getAttribute('data-host-kind')).toBe('server')
    // A host nothing is known of yet is a server.
    expect(glyph(render(<HostGlyph environmentId="env_box2" />).container)!.getAttribute('title')).toBe('env_box2')
  })

  it('a row may say more than the name on hover', () => {
    h.environments = TWO
    const g = glyph(render(<HostGlyph environmentId="env_box" title="The box is offline" />).container)!
    expect(g.getAttribute('title')).toBe('The box is offline')
  })
})
