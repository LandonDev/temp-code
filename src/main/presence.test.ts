import { describe, expect, it } from 'vitest'
import { MacPresenceWatcher, parseConsoleUsers, presenceFromEnv, staticPresence, type PowerMonitorLike } from './presence'

const plist = (users: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>IOConsoleLocked</key>\n\t<false/>\n\t<key>IOConsoleUsers</key>\n\t${users}\n\t<key>IORegistryEntryName</key>\n\t<string>Root</string>\n</dict>\n</plist>\n`
const LOCKED = plist(
  '<array>\n\t\t<dict>\n\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>\n\t\t\t<key>kCGSSessionUserNameKey</key>\n\t\t\t<string>landon</string>\n\t\t</dict>\n\t</array>'
)
const UNLOCKED = plist(
  '<array>\n\t\t<dict>\n\t\t\t<key>kCGSSessionOnConsoleKey</key>\n\t\t\t<true/>\n\t\t\t<key>kCGSSessionUserNameKey</key>\n\t\t\t<string>landon</string>\n\t\t</dict>\n\t</array>'
)

describe('parseConsoleUsers', () => {
  it('reads the lock flag off the console user', () => {
    expect(parseConsoleUsers(LOCKED)).toBe(true)
    expect(parseConsoleUsers(UNLOCKED)).toBe(false)
    expect(parseConsoleUsers(plist('<array>\n<dict>\n<key>CGSSessionScreenIsLocked</key>\n<false/>\n</dict>\n</array>'))).toBe(false)
  })
  it('has no answer for garbage, a missing entry or no console user', () => {
    expect(parseConsoleUsers('')).toBeNull()
    expect(parseConsoleUsers('not a plist')).toBeNull()
    expect(parseConsoleUsers('<plist><dict><key>IORegistryEntryName</key><string>Root</string></dict></plist>')).toBeNull()
    expect(parseConsoleUsers(plist('<array/>'))).toBeNull()
    expect(parseConsoleUsers(plist('<array>\n\t</array>'))).toBeNull()
  })
})

describe('presenceFromEnv', () => {
  it('reads the words only on an isolated instance', () => {
    expect(presenceFromEnv({ TEMP_CODE_PRESENCE: 'locked,asleep' })).toEqual({})
    expect(presenceFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_PRESENCE: 'locked,asleep' })).toEqual({ screen: 'locked', power: 'asleep' })
    expect(presenceFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_PRESENCE: 'Unlocked' })).toEqual({ screen: 'unlocked' })
    expect(presenceFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_PRESENCE: 'awake, bogus' })).toEqual({ power: 'awake' })
    expect(presenceFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x' })).toEqual({})
  })
})

function fakeMonitor(): PowerMonitorLike & { fire: (event: string) => void } {
  const handlers = new Map<string, () => void>()
  return {
    on: (event, listener) => handlers.set(event, listener),
    fire: (event) => handlers.get(event)?.()
  }
}

describe('MacPresenceWatcher', () => {
  it('starts unknown and awake, or from what it is given', () => {
    let t = 1_000
    const w = new MacPresenceWatcher({ now: () => t })
    expect(w.snapshot()).toEqual({ screen: 'unknown', power: 'awake', at: 1_000 })
    t = 2_000
    expect(new MacPresenceWatcher({ initial: { screen: 'locked' }, now: () => t }).snapshot()).toEqual({ screen: 'locked', power: 'awake', at: 2_000 })
    expect(staticPresence({ power: 'asleep' }).snapshot()).toMatchObject({ screen: 'unknown', power: 'asleep' })
  })
  it('follows the power monitor, one change per event', () => {
    let t = 10
    const w = new MacPresenceWatcher({ initial: { screen: 'unlocked' }, now: () => t })
    const seen: string[] = []
    w.onChange((p) => seen.push(`${p.screen}/${p.power}@${p.at}`))
    const monitor = fakeMonitor()
    w.attach(monitor)
    t = 11
    monitor.fire('lock-screen')
    t = 12
    monitor.fire('suspend')
    t = 13
    monitor.fire('resume')
    t = 14
    monitor.fire('unlock-screen')
    expect(seen).toEqual(['locked/awake@11', 'locked/asleep@12', 'locked/awake@13', 'unlocked/awake@14'])
    expect(w.snapshot()).toEqual({ screen: 'unlocked', power: 'awake', at: 14 })
  })
  it('set emits only on a change and answers the picture either way', () => {
    const w = new MacPresenceWatcher({ initial: { screen: 'unlocked' }, now: () => 5 })
    let fired = 0
    const off = w.onChange(() => fired++)
    expect(w.set({ screen: 'unlocked' })).toMatchObject({ screen: 'unlocked' })
    expect(fired).toBe(0)
    expect(w.set({})).toMatchObject({ screen: 'unlocked', power: 'awake' })
    expect(w.set({ screen: 'locked' }).screen).toBe('locked')
    expect(fired).toBe(1)
    off()
    w.set({ power: 'asleep' })
    expect(fired).toBe(1)
  })
  it('readInitialLock takes the session dictionary and leaves unknown on a failure', async () => {
    const exec =
      (stdout: string | null) =>
      (_file: string, args: readonly string[], _o: unknown, cb: (e: Error | null, out: string) => void): unknown => {
        expect(args).toEqual(['-n', 'Root', '-d1', '-a'])
        cb(stdout === null ? new Error('ioreg failed') : null, stdout ?? '')
        return null
      }
    const locked = new MacPresenceWatcher()
    await locked.readInitialLock(exec(LOCKED))
    expect(locked.snapshot().screen).toBe('locked')
    const unlocked = new MacPresenceWatcher()
    await unlocked.readInitialLock(exec(UNLOCKED))
    expect(unlocked.snapshot().screen).toBe('unlocked')
    const failed = new MacPresenceWatcher()
    await failed.readInitialLock(exec(null))
    expect(failed.snapshot().screen).toBe('unknown')
    const garbage = new MacPresenceWatcher()
    await garbage.readInitialLock(exec('nope'))
    expect(garbage.snapshot().screen).toBe('unknown')
    const threw = new MacPresenceWatcher()
    await threw.readInitialLock(() => {
      throw new Error('no such binary')
    })
    expect(threw.snapshot().screen).toBe('unknown')
  })
})
