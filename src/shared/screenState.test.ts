import { describe, expect, it } from 'vitest'
import { classifyScreen, parseLockPolicy } from './screenState'

const facts = (over: Partial<Parameters<typeof classifyScreen>[0]> = {}) => ({ sessionLocked: true, onConsole: true, saverRunning: true, ...over })

describe('parseLockPolicy', () => {
  it("reads sysadminctl's three answers after its log prefix", () => {
    expect(parseLockPolicy('2026-11-11 01:02:03.456 sysadminctl[812:9940] screenLock is off')).toEqual({ kind: 'off' })
    expect(parseLockPolicy('… sysadminctl[1:2] screenLock delay is immediate')).toEqual({ kind: 'immediate' })
    expect(parseLockPolicy('… screenLock delay is 300 seconds')).toEqual({ kind: 'delay', seconds: 300 })
    expect(parseLockPolicy('')).toEqual({ kind: 'unknown' })
  })
})

describe('classifyScreen', () => {
  it('a screen saver with no password needed is not a lock', () => {
    expect(classifyScreen(facts(), { kind: 'off' })).toBe('saver')
    expect(classifyScreen(facts({ sessionLocked: false }), { kind: 'immediate' })).toBe('unlocked')
  })

  it('a password needed, an explicit lock, another user or an unread policy is locked', () => {
    expect(classifyScreen(facts(), { kind: 'immediate' })).toBe('locked')
    expect(classifyScreen(facts({ saverRunning: false }), { kind: 'off' })).toBe('locked')
    expect(classifyScreen(facts({ onConsole: false, sessionLocked: false }), { kind: 'off' })).toBe('locked')
    expect(classifyScreen(facts(), { kind: 'unknown' })).toBe('locked')
  })

  it("under a delay the saver is passwordless only while its age is known and under it", () => {
    const delay = { kind: 'delay' as const, seconds: 60 }
    expect(classifyScreen(facts(), delay, 59_999)).toBe('saver')
    expect(classifyScreen(facts(), delay, 60_000)).toBe('locked')
    expect(classifyScreen(facts(), delay, null)).toBe('locked')
  })
})
