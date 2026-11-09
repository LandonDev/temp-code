import { afterEach, describe, expect, it } from 'vitest'
import { REFUSE_SESSION_TIER, currentSessionTierGate, setSessionTierGate, type SessionTierGate, type TierGateContext } from './tierGate'

const ctx: TierGateContext = {
  threadId: 't1',
  rootId: 't1',
  permission: 'auto',
  app: { pid: 1, bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
  window: null,
  classes: ['key'],
  serviceSession: 't1'
}

afterEach(() => setSessionTierGate(null))

describe('the session tier gate', () => {
  it('refuses with no scheduler', async () => {
    expect(currentSessionTierGate()).toBe(REFUSE_SESSION_TIER)
    expect(REFUSE_SESSION_TIER.admitted(ctx)).toBe(false)
    const decision = await REFUSE_SESSION_TIER.request({
      ...ctx,
      step: 0,
      action: { action: 'hold_key', text: 'shift', duration: 1 },
      words: 'hold shift for 1 s',
      call: 't1:1',
      signal: new AbortController().signal
    })
    expect(decision).toEqual({ admit: false, reason: 'no-scheduler', message: 'nothing schedules it yet' })
  })
  it('sends a call without the session tier, and holds nothing else: no paste quiet, no clipboard wait', async () => {
    const sent: string[][] = []
    const step = { index: 0, action: 'key', status: 'ok', tier: 'process', effect: 'changed' } as const
    const r = await REFUSE_SESSION_TIER.run({ ...ctx, tiers: ['ax', 'process', 'session'], actions: [{ action: 'key', text: 'a' }], signal: new AbortController().signal }, async (tiers) => {
      sent.push(tiers)
      return { step }
    })
    expect(sent).toEqual([['ax', 'process']])
    expect(r).toEqual({ step })
    expect(REFUSE_SESSION_TIER.pasteQuietMs).toBeUndefined()
    expect(REFUSE_SESSION_TIER.clipboard).toBeUndefined()
    expect(REFUSE_SESSION_TIER.cardAllowed).toBeUndefined()
    expect(REFUSE_SESSION_TIER.settle).toBeUndefined()
  })
  it('a scheduler plugs in, and null puts the refusal back', () => {
    const gate: SessionTierGate = { admitted: () => true, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) }
    setSessionTierGate(gate)
    expect(currentSessionTierGate()).toBe(gate)
    setSessionTierGate(null)
    expect(currentSessionTierGate()).toBe(REFUSE_SESSION_TIER)
  })
})
