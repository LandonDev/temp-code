import { describe, expect, it } from 'vitest'
import { BridgeTimingSchema, CallTiming, bridgeLegs, bridgeOverhead, parseTimingLine, timingLine, type BridgeTiming } from './bridgeTiming'

const mac: BridgeTiming = { macMs: 700, checksMs: 1, guardMs: 3, runMs: 680, serviceMs: 650, waitedMs: 120, shotsMs: 12, shotChars: 4000 }
const stamps = { startedAt: 1000, dispatchedAt: 1010, sentAt: 1014, repliedAt: 1760, answeredAt: 1768 }

describe('the bridge timing', () => {
  it('takes each leg from the stamps it names', () => {
    expect(bridgeLegs({ ...stamps, timing: mac })).toEqual({ total: 768, queue: 10, box: 12, transit: 46, mac: 700, run: 680 })
    expect(bridgeOverhead(bridgeLegs({ ...stamps, timing: mac }))).toBe(78)
  })

  it('never reads a transit below zero', () => {
    // a reply that came back faster than the Mac says it worked: the two clocks disagree, the leg floors at 0
    expect(bridgeLegs({ ...stamps, repliedAt: 1500, timing: mac }).transit).toBe(0)
  })

  it('reads an answer without the Mac timing as unknown Mac legs', () => {
    const legs = bridgeLegs({ ...stamps, timing: undefined })
    expect(legs).toEqual({ total: 768, queue: 10, box: 12, transit: null, mac: null, run: null })
    expect(bridgeOverhead(legs)).toBeNull()
    expect(timingLine(legs)).toBe('timing total=768 queue=10 box=12 transit=- mac=- run=-')
  })

  it('writes a line the proof reads back', () => {
    const line = `[computer-bridge] thread=t1 ${timingLine(bridgeLegs({ ...stamps, timing: mac }), { tool: 'computer_observe', service: 650, shotChars: 4000, lag: null })}`
    expect(parseTimingLine(line)).toEqual({ total: 768, queue: 10, box: 12, transit: 46, mac: 700, run: 680, tool: 'computer_observe', service: 650, shotChars: 4000, lag: null })
    expect(parseTimingLine('[computer-bridge] no line here')).toBeNull()
    expect(timingLine({ total: 5 }, { app: 'TC Probe' })).toBe('timing total=5 app=TC_Probe')
  })

  it('tallies service round trips and waits', () => {
    const t = new CallTiming()
    t.addService(12.4)
    t.addService(30)
    t.addWaited(200)
    t.addWaited(-3)
    expect([t.serviceMs, t.waitedMs]).toEqual([42, 200])
  })

  it('parses the Mac timing and refuses a negative leg', () => {
    expect(BridgeTimingSchema.parse(mac)).toEqual(mac)
    expect(BridgeTimingSchema.safeParse({ ...mac, runMs: -1 }).success).toBe(false)
  })
})
