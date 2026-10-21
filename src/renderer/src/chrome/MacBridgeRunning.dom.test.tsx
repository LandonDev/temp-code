import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import { mountProbe } from '../test/renderProbe'
import { macBridgeStore } from '../lib/macBridge'
import { MacBridgeRunningList, countLine } from './MacBridgeRunning'

/**
 * The running list with the load guard's held rows (docs/box.md "The load
 * guard"): a held command is a row after the running ones, with its place
 * and Stop; the count line says how many run and how many wait.
 */

const req = (id: string, over: Partial<MacBridgeRequest>): MacBridgeRequest => ({
  id,
  environmentId: 'env_box',
  hostName: 'box',
  sessionId: 's1',
  threadTitle: 'iOS build',
  kind: 'run',
  method: 'mac.run',
  argv: ['xcodebuild', id],
  cwd: '/Users/me/app',
  createdAt: 1,
  expiresAt: 600_000,
  status: 'running',
  ...over
})

const seed = (requests: MacBridgeRequest[]) =>
  macBridgeStore.setState({ requests: Object.fromEntries(requests.map((r) => [r.id, r])) })

describe('MacBridgeRunningList', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  afterEach(() => {
    probe?.unmount()
    probe = null
    seed([])
    vi.restoreAllMocks()
  })

  it('draws the running rows, then the held ones in line order with their place and Stop', () => {
    seed([
      req('h2', {
        createdAt: 3,
        status: 'held',
        quiet: true,
        held: {
          reason: 'load',
          position: 2,
          load: 12.3,
          limit: 8,
          cores: 4,
          maxRunning: 4,
          running: 1
        }
      }),
      req('r1', { createdAt: 1 }),
      req('h1', {
        createdAt: 2,
        status: 'held',
        held: {
          reason: 'cap',
          position: 1,
          load: 1.2,
          limit: 8,
          cores: 4,
          maxRunning: 1,
          running: 1
        }
      })
    ])
    probe = mountProbe(<MacBridgeRunningList environmentId="env_box" hostName="box" />)
    const root = probe.container
    const rows = [...root.querySelectorAll('[data-mac-bridge-running-row]')]
    expect(rows.map((r) => r.getAttribute('data-mac-bridge-running-row'))).toEqual([
      'r1',
      'h1',
      'h2'
    ])
    expect(rows.map((r) => r.getAttribute('data-mac-bridge-held'))).toEqual([null, '1', '2'])
    expect(root.textContent).toContain('1 command running on this Mac from box · 2 waiting')
    expect(rows[1].textContent).toContain('Waiting for the Mac · 1 of 1 running · 1st in line')
    expect(rows[2].textContent).toContain('Waiting for the Mac · load 12.3 of 8 · 2nd in line')
    expect(rows[0].textContent).not.toContain('Waiting')
    // Every row has Stop; the list has Stop all.
    expect(rows.every((r) => r.querySelector('button')?.textContent === 'Stop')).toBe(true)
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Stop all')).toBe(
      true
    )
    // The thread name shows on a host's list…
    expect(rows[0].textContent).toContain('iOS build')
  })

  it('…and not on a thread own list; a thread only waiting says so', () => {
    seed([
      req('h1', {
        createdAt: 2,
        status: 'held',
        held: {
          reason: 'cap',
          position: 1,
          load: 1.2,
          limit: 8,
          cores: 4,
          maxRunning: 4,
          running: 4
        }
      }),
      req('other', { createdAt: 1, sessionId: 's2' })
    ])
    probe = mountProbe(<MacBridgeRunningList environmentId="env_box" sessionId="s1" />)
    const root = probe.container
    expect(root.querySelectorAll('[data-mac-bridge-running-row]')).toHaveLength(1)
    expect(root.textContent).toContain('1 command waiting for this Mac')
    expect(root.textContent).not.toContain('iOS build')
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Stop all')).toBe(
      false
    )
  })

  it('draws nothing with nothing in flight', () => {
    seed([req('p', { status: 'pending' })])
    probe = mountProbe(<MacBridgeRunningList environmentId="env_box" />)
    expect(probe.container.textContent).toBe('')
  })

  it('countLine', () => {
    expect(countLine(2, 0, 'box')).toBe('2 commands running on this Mac from box')
    expect(countLine(1, 3)).toBe('1 command running on this Mac · 3 waiting')
    expect(countLine(0, 1, 'box')).toBe('1 command waiting for this Mac from box')
    expect(countLine(2, 1, 'box', 1)).toBe('2 commands running on this Mac from box · 1 waiting · 1 paused')
    expect(countLine(0, 0, undefined, 1)).toBe('1 call paused with its thread')
    expect(countLine(0, 0, 'box', 2)).toBe('2 calls paused with their thread from box')
  })

  it("a paused thread's held calls are Paused rows after the others, without Stop; Stop all skips them", () => {
    seed([
      req('r', { createdAt: 1 }),
      req('p', { createdAt: 2, status: 'paused', id: 'mb_held_1' }),
      req('q', { createdAt: 3, status: 'paused', id: 'mb_held_2', sessionId: 's2' })
    ])
    probe = mountProbe(<MacBridgeRunningList environmentId="env_box" hostName="box" />)
    const root = probe.container
    const list = root.querySelector('[data-mac-bridge-running-list]')!
    expect(list.getAttribute('data-mac-bridge-paused-count')).toBe('2')
    expect(root.textContent).toContain('1 command running on this Mac from box · 2 paused')
    const rows = [...root.querySelectorAll('[data-mac-bridge-running-row]')]
    expect(rows.map((r) => r.getAttribute('data-mac-bridge-row-status'))).toEqual(['running', 'paused', 'paused'])
    expect(rows[0].querySelector('button')?.textContent).toBe('Stop')
    expect(rows[1].querySelector('button')).toBeNull()
    expect(rows[1].textContent).toContain('Paused')
    // One stoppable row: no Stop all.
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Stop'])
  })

  it("a thread's own dialog shows only its paused rows; another thread's shows nothing", () => {
    seed([req('p', { createdAt: 2, status: 'paused', id: 'mb_held_1' })])
    probe = mountProbe(<MacBridgeRunningList sessionId="s1" />)
    expect(probe.container.textContent).toContain('1 call paused with its thread')
    expect(probe.container.querySelector('button')).toBeNull()
    probe.unmount()
    probe = mountProbe(<MacBridgeRunningList sessionId="s2" />)
    expect(probe.container.querySelector('[data-mac-bridge-running-list]')).toBeNull()
  })
})
