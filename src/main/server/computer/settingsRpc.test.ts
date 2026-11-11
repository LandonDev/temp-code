import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerServiceState, ComputerSettingsPush } from '@shared/contract-computer'
import { SCHEDULE, SESSION_IDLE_SETTING, sessionIdleMs } from '@shared/computer/scheduleRules'
import { tierVerdictSetting } from '@shared/computer/tools'
import { ComputerSettingsRpc, SETTINGS_PUSH_MS, type ComputerSettingsHost } from './settingsRpc'
import { TierVerdicts } from './verdicts'

function memoryStore() {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (k: string) => rows.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? rows.delete(k) : rows.set(k, v)),
    settingsWithPrefix: (p: string) => new Map([...rows].filter(([k]) => k.startsWith(p)))
  }
}

function fakeBin(body: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'tc-computer-perms-')), 'tc-computer')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

function make(over: { state?: ComputerServiceState['state']; live?: { accessibility: boolean; screenRecording: boolean } | null; bin?: string; unavailable?: string | null; host?: boolean } = {}) {
  const store = memoryStore()
  const verdicts = new TierVerdicts(store)
  const state: ComputerServiceState = { state: over.state ?? 'off', restarts: 0, permissions: over.live ?? null }
  const retried: number[] = []
  const host: ComputerSettingsHost = {
    verdicts,
    service: {
      state: () => state,
      permissions: () => over.live ?? null,
      retry: async () => (retried.push(1), { ...state, state: 'up' })
    }
  }
  const rpc = new ComputerSettingsRpc({
    host: over.host === false ? null : host,
    store,
    unavailable: () => over.unavailable ?? null,
    ...(over.bin ? { bin: () => over.bin! } : {})
  })
  const pushes: ComputerSettingsPush[] = []
  rpc.onPush((p) => pushes.push(p))
  rpcs.push(rpc)
  return { rpc, store, verdicts, pushes, retried }
}
const rpcs: ComputerSettingsRpc[] = []
afterEach(() => {
  for (const r of rpcs.splice(0)) r.close()
  vi.useRealTimers()
})

describe('ComputerSettingsRpc', () => {
  it('answers the default threshold and no apps on a fresh host', () => {
    expect(make().rpc.get()).toEqual({ sessionIdleMs: SCHEDULE.sessionIdleMsDefault, apps: [] })
  })

  it('answers the threshold and every learned app with its name', () => {
    const { rpc, store, verdicts } = make()
    store.setSetting(SESSION_IDLE_SETTING, '300000')
    verdicts.stampProbe('com.apple.TextEdit', 'TextEdit')
    store.setSetting(tierVerdictSetting('dev.old'), JSON.stringify({ bundleId: 'dev.old', classes: { click: 'session' }, misses: {}, updatedAt: Date.now() }))
    const got = rpc.get()
    expect(got.sessionIdleMs).toBe(300_000)
    expect(got.apps).toEqual(
      expect.arrayContaining([
        { bundleId: 'com.apple.TextEdit', name: 'TextEdit', classes: {}, updatedAt: expect.any(Number) },
        { bundleId: 'dev.old', name: null, classes: { click: 'session' }, updatedAt: expect.any(Number) }
      ])
    )
  })

  it('set writes the setting the scheduler reads', () => {
    const { rpc, store } = make()
    expect(rpc.set({ sessionIdleMs: 600_000 }).sessionIdleMs).toBe(600_000)
    expect(sessionIdleMs(store.getSetting(SESSION_IDLE_SETTING))).toBe(600_000)
    expect(rpc.set({}).sessionIdleMs).toBe(600_000)
  })

  it('forgets one app and every app, pushing once for a burst', () => {
    vi.useFakeTimers()
    const { rpc, verdicts, pushes } = make()
    verdicts.stampProbe('a.one', 'One')
    verdicts.stampProbe('b.two', 'Two')
    vi.advanceTimersByTime(SETTINGS_PUSH_MS)
    pushes.length = 0
    expect(rpc.forget('a.one').apps.map((a) => a.bundleId)).toEqual(['b.two'])
    expect(rpc.forget(null).apps).toEqual([])
    expect(pushes).toHaveLength(0)
    vi.advanceTimersByTime(SETTINGS_PUSH_MS)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toEqual({ push: 'computer-settings', settings: { sessionIdleMs: SCHEDULE.sessionIdleMsDefault, apps: [] } })
  })

  it('coalesces changes to one push a second', () => {
    vi.useFakeTimers()
    const { rpc, verdicts, pushes } = make()
    rpc.set({ sessionIdleMs: 60_000 })
    vi.advanceTimersByTime(0)
    expect(pushes).toHaveLength(1)
    verdicts.stampProbe('a.one', 'One')
    rpc.set({ sessionIdleMs: 120_000 })
    vi.advanceTimersByTime(SETTINGS_PUSH_MS - 1)
    expect(pushes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(pushes).toHaveLength(2)
    expect(pushes[1].settings).toMatchObject({ sessionIdleMs: 120_000, apps: [{ bundleId: 'a.one' }] })
  })

  it('reads the grants from the service while it is up, without a child', async () => {
    const { rpc } = make({ state: 'up', live: { accessibility: true, screenRecording: false }, bin: fakeBin('exit 1') })
    await expect(rpc.permissions()).resolves.toEqual({ accessibility: true, screenRecording: false })
  })

  it('reads the grants from one tc-computer permissions while the service is not up', async () => {
    const { rpc } = make({ state: 'idle', bin: fakeBin(`echo '{"accessibility":false,"screenRecording":true}'`) })
    await expect(rpc.permissions()).resolves.toEqual({ accessibility: false, screenRecording: true })
  })

  it('answers null when computer use is unavailable or the child fails', async () => {
    await expect(make({ host: false }).rpc.permissions()).resolves.toBeNull()
    await expect(make({ unavailable: 'turned off', bin: fakeBin(`echo '{"accessibility":true,"screenRecording":true}'`) }).rpc.permissions()).resolves.toBeNull()
    await expect(make({ bin: fakeBin('exit 3') }).rpc.permissions()).resolves.toBeNull()
    await expect(make({ bin: fakeBin('echo not-json') }).rpc.permissions()).resolves.toBeNull()
  })

  it('Try again goes to the service, and answers unavailable where there is none', async () => {
    const { rpc, retried } = make({ state: 'down' })
    await expect(rpc.retry()).resolves.toMatchObject({ state: 'up' })
    expect(retried).toHaveLength(1)
    await expect(make({ host: false, unavailable: 'computer use runs on a Mac' }).rpc.retry()).resolves.toMatchObject({ state: 'unavailable', reason: 'computer use runs on a Mac' })
  })
})
