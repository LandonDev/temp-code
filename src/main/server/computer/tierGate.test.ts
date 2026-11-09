import { afterEach, describe, expect, it } from 'vitest'
import { REFUSE_SESSION_TIER, currentSessionTierGate, setSessionTierGate, type SessionTierGate, type TierGateContext } from './tierGate'

const ctx: TierGateContext = {
  threadId: 't1',
  rootId: 't1',
  permission: 'auto',
  app: { pid: 1, bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
  window: null,
  classes: ['key']
}

afterEach(() => setSessionTierGate(null))

describe('the session tier gate', () => {
  it('refuses with no scheduler', async () => {
    expect(currentSessionTierGate()).toBe(REFUSE_SESSION_TIER)
    expect(REFUSE_SESSION_TIER.admitted(ctx)).toBe(false)
    const decision = await REFUSE_SESSION_TIER.request({ ...ctx, step: 0, action: { action: 'hold_key', text: 'shift', duration: 1 }, signal: new AbortController().signal })
    expect(decision).toEqual({ admit: false, reason: 'no-scheduler', message: 'nothing schedules it yet' })
  })
  it('a scheduler plugs in, and null puts the refusal back', () => {
    const gate: SessionTierGate = { admitted: () => true, request: async () => ({ admit: true }) }
    setSessionTierGate(gate)
    expect(currentSessionTierGate()).toBe(gate)
    setSessionTierGate(null)
    expect(currentSessionTierGate()).toBe(REFUSE_SESSION_TIER)
  })
})
