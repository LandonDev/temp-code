import { afterEach, describe, expect, it, vi } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import { AWAY_DECIDED_SETTING, AWAY_SETTING, AWAY_TALLY_MS, AwayService } from './away'

const settingsStore = () => {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (key: string) => rows.get(key) ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
    }
  }
}

const make = (now = () => 1_000) => {
  const settings = settingsStore()
  const away = new AwayService({ ...settings, environmentId: 'env_mac', now })
  return { away, settings }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AwayService', () => {
  it('starts off and stamps a flip with the time and this host', () => {
    let t = 5_000
    const { away, settings } = make(() => t)
    expect(away.get().state).toEqual({ enabled: false, at: 0, by: '' })
    expect(away.set(true)).toEqual({ enabled: true, at: 5_000, by: 'env_mac' })
    expect(JSON.parse(settings.rows.get(AWAY_SETTING)!)).toEqual({ enabled: true, at: 5_000, by: 'env_mac' })
    t = 6_000
    // A flip to the value it already has changes nothing, not even the stamp.
    expect(away.set(true).at).toBe(5_000)
  })

  it('reads the state back from the settings table', () => {
    const settings = settingsStore()
    settings.setSetting(AWAY_SETTING, JSON.stringify({ enabled: true, at: 9, by: 'env_box' }))
    const away = new AwayService({ ...settings, environmentId: 'env_mac' })
    expect(away.enabled).toBe(true)
    expect(away.get().state.by).toBe('env_box')
  })

  it('applies a peer state only when it is newer', () => {
    const { away } = make(() => 2_000)
    away.set(true)
    expect(away.apply({ enabled: false, at: 1_500, by: 'env_box' })).toBe(false)
    expect(away.enabled).toBe(true)
    expect(away.apply({ enabled: false, at: 2_000, by: 'env_box' })).toBe(false)
    expect(away.enabled).toBe(true)
    expect(away.apply({ enabled: false, at: 2_500, by: 'env_box' })).toBe(true)
    expect(away.get().state).toEqual({ enabled: false, at: 2_500, by: 'env_box' })
  })

  it('takes a newer stamp of the same value without telling anyone', () => {
    const { away } = make(() => 2_000)
    away.set(true)
    const heard = vi.fn()
    away.onChange(heard)
    expect(away.apply({ enabled: true, at: 3_000, by: 'env_box' })).toBe(false)
    expect(away.get().state.at).toBe(3_000)
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells its listeners on every change of the state', () => {
    let t = 1_000
    const { away } = make(() => t)
    const heard = vi.fn()
    away.onChange(heard)
    away.set(true)
    t = 2_000
    away.set(false)
    away.set(false)
    expect(heard).toHaveBeenCalledTimes(2)
    expect(heard.mock.calls[0][0].state.enabled).toBe(true)
    expect(heard.mock.calls[0][1]).toBe(true)
    expect(heard.mock.calls[1][0].state.enabled).toBe(false)
  })

  it('writes the tally a second after its counts and pushes it', () => {
    vi.useFakeTimers()
    const { away, settings } = make()
    away.set(true)
    const heard = vi.fn()
    away.onChange(heard)
    away.count('a')
    away.count('a')
    away.count('b')
    expect(away.get().decided.threads).toEqual([
      { sessionId: 'a', count: 2 },
      { sessionId: 'b', count: 1 }
    ])
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toEqual([])
    expect(heard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(AWAY_TALLY_MS)
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toHaveLength(2)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard.mock.calls[0][1]).toBe(false)
  })

  it('starts a new tally when away turns on and keeps it when it turns off', () => {
    let t = 1_000
    const { away } = make(() => t)
    away.set(true)
    away.count('a')
    t = 2_000
    away.set(false)
    expect(away.get().decided.threads).toEqual([{ sessionId: 'a', count: 1 }])
    t = 3_000
    away.set(true)
    expect(away.get().decided).toEqual({ since: 3_000, threads: [] })
  })

  it('flushes a pending tally on dispose', () => {
    vi.useFakeTimers()
    const { away, settings } = make()
    away.set(true)
    away.count('a')
    away.dispose()
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toEqual([{ sessionId: 'a', count: 1 }])
  })
})

describe('away capabilities', () => {
  it('reads with read, flips with approve, applies a peer state with admin', () => {
    expect(requiredCapability({ method: 'away.get' })).toBe('read')
    expect(requiredCapability({ method: 'away.set', params: { enabled: true } })).toBe('approve')
    expect(requiredCapability({ method: 'away.apply', params: { state: { enabled: true, at: 1, by: 'x' } } })).toBe('admin')
  })
})
