import { describe, expect, it } from 'vitest'
import { METHOD_CAPABILITY } from './capabilities'
import { ClientRequestSchema } from './contract'
import {
  RELAY_BOX_LOCAL,
  RELAY_METHODS,
  linkDownText,
  relayForbidden,
  relayRefusal,
  relayState,
  sinceText,
  type HostPresence
} from './contract-relay'
import { SUBSET } from '../../scripts/gen-swift-contract'

const UTC = 'UTC'
// 2026-03-04 09:14 UTC
const T_0914 = Date.UTC(2026, 2, 4, 9, 14, 30)
const T_SAME_DAY = Date.UTC(2026, 2, 4, 18, 0)
const T_NEXT_DAY = Date.UTC(2026, 2, 5, 1, 0)

const host = (over: Partial<HostPresence> = {}): HostPresence => ({
  environmentId: 'env_mac',
  name: 'Studio',
  platform: 'darwin',
  link: 'up',
  since: T_0914,
  screen: 'unlocked',
  power: 'awake',
  lastSeenAt: T_0914,
  build: null,
  ...over
})

describe('relayState', () => {
  it('names the four states, link first, then power, then screen', () => {
    expect(relayState(host())).toBe('available')
    expect(relayState(host({ screen: 'locked' }))).toBe('locked')
    expect(relayState(host({ power: 'asleep' }))).toBe('asleep')
    expect(relayState(host({ power: 'asleep', screen: 'locked' }))).toBe('asleep')
    expect(relayState(host({ link: 'down', screen: 'locked', power: 'asleep' }))).toBe('unreachable')
    expect(relayState(host({ screen: 'unknown', power: 'unknown' }))).toBe('available')
  })
})

describe('sinceText', () => {
  it('is the clock alone today and the day before it otherwise', () => {
    expect(sinceText(T_0914, T_SAME_DAY, UTC)).toBe('09:14')
    expect(sinceText(T_0914, T_NEXT_DAY, UTC)).toBe('4 Mar 09:14')
    expect(sinceText(Date.UTC(2025, 11, 31, 23, 5), T_SAME_DAY, UTC)).toBe('31 Dec 23:05')
  })
  it('reads the zone it is given', () => {
    // 09:14 UTC is 10:14 in Paris in March (CET)
    expect(sinceText(T_0914, T_SAME_DAY, 'Europe/Paris')).toBe('10:14')
  })
  it('formats in the process zone when none is given', () => {
    expect(sinceText(T_0914, T_SAME_DAY)).toMatch(/^(\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d$/)
  })
})

describe('relayRefusal', () => {
  it('runs everything on an available host', () => {
    expect(relayRefusal(host(), 'link', T_SAME_DAY, UTC)).toBeNull()
    expect(relayRefusal(host(), 'screen', T_SAME_DAY, UTC)).toBeNull()
  })
  it('refuses only a screen method on a locked host', () => {
    expect(relayRefusal(host({ screen: 'locked' }), 'link', T_SAME_DAY, UTC)).toBeNull()
    expect(relayRefusal(host({ screen: 'locked' }), 'screen', T_SAME_DAY, UTC)).toBe('unavailable: the Mac is locked')
  })
  it('refuses everything on an asleep host', () => {
    expect(relayRefusal(host({ power: 'asleep' }), 'link', T_SAME_DAY, UTC)).toBe('unavailable: the Mac is asleep')
    expect(relayRefusal(host({ power: 'asleep', screen: 'locked' }), 'screen', T_SAME_DAY, UTC)).toBe('unavailable: the Mac is asleep')
  })
  it('refuses everything on an unreachable host and says since when', () => {
    expect(relayRefusal(host({ link: 'down' }), 'link', T_SAME_DAY, UTC)).toBe('unavailable: the Mac is unreachable since 09:14')
    expect(relayRefusal(host({ link: 'down' }), 'screen', T_NEXT_DAY, UTC)).toBe('unavailable: the Mac is unreachable since 4 Mar 09:14')
  })
})

describe('linkDownText and relayForbidden', () => {
  it('say the same words', () => {
    expect(linkDownText(host(), T_SAME_DAY, UTC)).toBe('linkDown: the Mac is unreachable since 09:14')
    expect(linkDownText({ since: T_0914 }, T_NEXT_DAY, UTC)).toBe('linkDown: the Mac is unreachable since 4 Mar 09:14')
    expect(relayForbidden('remote.keys.list')).toBe('forbidden: remote.keys.list does not relay to another host')
  })
})

describe('RELAY_METHODS', () => {
  const contractMethods = new Set(
    (ClientRequestSchema.options as { shape: { method: { value: string } } }[]).map((o) => o.shape.method.value)
  )
  it('names only contract methods, none of them local', () => {
    for (const m of Object.keys(RELAY_METHODS)) {
      expect(contractMethods.has(m), m).toBe(true)
      expect(METHOD_CAPABILITY[m as keyof typeof METHOD_CAPABILITY], m).not.toBe('local')
    }
    for (const m of RELAY_BOX_LOCAL) expect(contractMethods.has(m), m).toBe(true)
  })
  it('needs the screen only for opening Xcode', () => {
    expect(Object.entries(RELAY_METHODS).filter(([, need]) => need === 'screen').map(([m]) => m)).toEqual(['host.device.openXcode'])
  })
  it('covers every method the phone speaks (the Swift SUBSET)', () => {
    // gen-swift-contract.ts runs main() only under import.meta.main, so the import is the list itself.
    const spoken = SUBSET.filter((e) => e.kind === 'method').map((e) => (e as { method: string }).method)
    expect(spoken.length).toBeGreaterThan(20)
    const relayed = new Set<string>([...Object.keys(RELAY_METHODS), ...RELAY_BOX_LOCAL])
    // The key's own management rows (remote.*) are the box's business and never cross; everything else must.
    const missing = spoken.filter((m) => !relayed.has(m) && !m.startsWith('remote.'))
    expect(missing).toEqual([])
    for (const m of RELAY_BOX_LOCAL) expect(m.startsWith('remote.push.')).toBe(true)
  })
})
