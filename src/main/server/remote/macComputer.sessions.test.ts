import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { MacBridgeRequest } from '@shared/contract-macbridge'
import { ComputerPeerAnswerSchema, type ComputerPeerAnswer } from '@shared/contract-maccomputer'
import type { ComputerToolCall } from '@shared/computer/tools'
import type { PermissionPolicy } from '@shared/events'
import { computerHarness, type ComputerHarness } from '../computer/runHarness'
import { MacBridge } from './macBridge'

/**
 * A box thread's calls through the Mac bridge into the sessions build's real
 * ComputerSessions over the fake tc-computer (computer/fakeService.mjs): the
 * Mac side end to end, with only the service faked.
 */

const harnesses: ComputerHarness[] = []
const bridges: MacBridge[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close()
  for (const b of bridges.splice(0)) b.close()
})

function setup() {
  const h = computerHarness()
  harnesses.push(h)
  const settings = new Map<string, string>([
    ['macBridge.policy.env_box', 'read'],
    ['macBridge.computer.env_box', 'on']
  ])
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    managedRoots: () => [],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => null,
    home: tmpdir(),
    log: () => {},
    load: { sample: () => ({ load: 0, cores: 8 }), intervalMs: 0 },
    computerHost: () => ({ sessions: h.sessions }),
    computerUnavailable: () => null
  })
  bridges.push(mb)
  const call = async (tool: ComputerToolCall['tool'], args: Record<string, unknown>, permission: PermissionPolicy = 'auto'): Promise<ComputerPeerAnswer> =>
    ComputerPeerAnswerSchema.parse(
      await mb.handle(
        'mac.computer',
        { thread: { id: 's1', title: 'drives TextEdit' }, args: { call: { tool, args, threadId: 's1', permission }, turn: 'boot:1', rootId: 's1' } } as never,
        { from: 'env_box', deadlineAt: Date.now() + 60 * 60_000, callId: `c${Math.random()}` }
      )
    )
  const cards = (): MacBridgeRequest[] => mb.pending().filter((r) => r.status === 'pending')
  return { h, mb, call, cards }
}

const until = async (pred: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((ok) => setTimeout(ok, 5))
  }
  throw new Error(`timed out: ${label}`)
}

describe('a box thread on the real sessions host', () => {
  it('observes, acts after the Mac card, and a session-tier key is refused by the gate', async () => {
    const s = setup()
    const seen = await s.call('computer_observe', { app: 'TextEdit' })
    expect(seen.isError).toBe(false)
    expect(seen.body).toContain('TextEdit')
    expect(seen.row).toMatchObject({ threadId: 'env_box:s1', apps: [{ name: 'TextEdit' }] })
    expect(s.h.requests().find((r) => r.method === 'session.open')?.params).toMatchObject({ session: expect.stringMatching(/^t_[0-9a-f]{40}$/) })

    const act = s.call('computer_act', { app: 'TextEdit', action: 'set_value', element: 3, value: 'Lunch?' }, 'safe')
    await until(() => s.cards().length === 1, 'the Mac card')
    expect(s.cards()[0]).toMatchObject({ kind: 'computer', computer: { app: 'TextEdit' } })
    expect(s.cards()[0].computer?.actions).toHaveLength(1)
    s.mb.decide(s.cards()[0].id, true)
    const acted = await act
    expect(acted.isError).toBe(false)
    expect(acted.steps[0]).toMatch(/^set_value .* · ax/)

    await s.call('computer_observe', { app: 'KeyWin' })
    const key = await s.call('computer_act', { app: 'KeyWin', action: 'key', text: 'a' })
    expect(key.steps[0]).toBe('key a · failed: needs the session tier (the real pointer and keyboard), which is not available now: nothing schedules it yet')

    expect(s.mb.hosts()[0].computerLive).toBe(1)
    await s.mb.handle('mac.computerEnd', { thread: { id: 's1', title: '' }, args: { reason: 'ended' } } as never, { from: 'env_box', deadlineAt: Date.now() + 15_000 })
    expect(s.h.sessions.rows()).toEqual([])
    expect(s.mb.hosts()[0].computerLive).toBe(0)
  })
})
