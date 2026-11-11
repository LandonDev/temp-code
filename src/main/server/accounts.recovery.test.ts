import { afterEach, beforeEach, expect, it } from 'vitest'
import { configure, type ServiceView, type UsageWindow } from 'aliax-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountsService } from './accounts'
import { HeadroomStore } from './headroom'
import type { SessionMeta } from '@shared/events'

let vaultDir: string
beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'tc-quota-vault-'))
  configure({ dataDir: vaultDir, secrets: { mode: 'fileKey' }, fetch: async () => { throw new Error('unexpected network') } })
})
afterEach(() => rmSync(vaultDir, { recursive: true, force: true }))

const NOW = 1_800_000_000_000
const full: UsageWindow[] = [{ label: '5h', usedPercent: 20 }, { label: 'Weekly', usedPercent: 100, resetsAt: NOW + 7 * 86400_000 }]
const room = full.map(w => ({ ...w, usedPercent: 20 }))
const meta = { provider: 'claude', model: 'claude-opus-5-5', account: 'a', updatedAt: NOW } as SessionMeta

function host(id: string) {
  let now = NOW
  let windows = full
  const headroom = new HeadroomStore({ environmentId: id, now: () => now })
  const svc = new AccountsService({
    vaultPresent: () => true, locked: () => false, owner: () => 'temp-code', now: () => now,
    listServices: async () => [{ id: 'claude-code', profiles: [{ name: 'a', createdAt: 0, active: true }] }] as ServiceView[],
    pinned: () => null, headroom: () => headroom,
    usage: async id => id === 'claude-code' ? [{ profileName: 'a', windows }] : [],
    markStale: () => {}
  })
  return { headroom, svc, advance: () => { now += 1000 }, setWindows: (w: UsageWindow[]) => { windows = w } }
}

it('a fresh weekly report restores eligibility here and after the peer message', async () => {
  const mac = host('mac'), box = host('box')
  for (const h of [mac, box]) {
    await h.svc.list()
    h.headroom.observe({ service: 'claude-code', account: 'a', model: meta.model, status: 429, headers: new Headers({ 'retry-after': '604800' }) })
    await h.svc.rebuildNow()
    expect(h.svc.roomElsewhere('claude', meta.model, null)).toBe(false)
    h.advance()
  }
  mac.setWindows(room)
  // This hook fires only on real provider samples, never on a cached poll.
  for (const window of room) mac.svc.observeFreshWindow('claude-code', 'a', window)
  await mac.svc.refresh('claude')
  expect(mac.svc.roomElsewhere('claude', meta.model, null)).toBe(true)
  box.headroom.merge('mac', mac.headroom.own())
  await box.svc.rebuildNow()
  expect(box.svc.roomElsewhere('claude', meta.model, null)).toBe(true)
  expect(box.svc.snapshot().providers.claude.reports[0].windows).toEqual(room)
  mac.svc.stop()
  box.svc.stop()
})

it('a cached report with room is not proof, and a fresh full window stays limited', async () => {
  const h = host('mac')
  await h.svc.list()
  h.headroom.observe({ service: 'claude-code', account: 'a', model: meta.model, status: 429, quotaWindow: 'Weekly', headers: new Headers({ 'retry-after': '604800' }) })
  h.advance()
  h.setWindows(room)
  await h.svc.refresh('claude')
  expect(h.svc.hasRoom('claude', meta.model, 'a')).toBe(false)
  for (const w of full) h.svc.observeFreshWindow('claude-code', 'a', w)
  await h.svc.rebuildNow()
  expect(h.svc.hasRoom('claude', meta.model, 'a')).toBe(false)
  h.svc.stop()
})

it('a regular rebuild recovers on fresh evidence without clearing a 401 mark', async () => {
  const h = host('mac')
  await h.svc.list()
  h.headroom.observe({ service: 'claude-code', account: 'a', model: meta.model, status: 429, quotaWindow: 'Weekly', headers: new Headers({ 'retry-after': '604800' }) })
  h.svc.markOut('claude-code', 'a')
  h.advance()
  for (const w of room) h.svc.observeFreshWindow('claude-code', 'a', w)
  await h.svc.rebuildNow()
  expect(h.headroom.view('claude-code', 'a').throttledUntil).toBeUndefined()
  expect(h.svc.isOut('claude', 'a')).toBe(true)
  expect(h.svc.hasRoom('claude', meta.model, 'a')).toBe(false)
  h.svc.markAnswered('claude-code', 'a')
  expect(h.svc.hasRoom('claude', meta.model, 'a')).toBe(true)
  h.svc.stop()
})

it('an expired sign-in remains ineligible even with room evidence', async () => {
  const headroom = new HeadroomStore({ environmentId: 'mac', now: () => NOW + 1000 })
  const svc = new AccountsService({
    vaultPresent: () => true, locked: () => false,
    listServices: async () => [{ id: 'claude-code', profiles: [{ name: 'a' }] }] as ServiceView[],
    usage: async () => [{ profileName: 'a', windows: full, expired: true }],
    headroom: () => headroom, now: () => NOW + 1000
  })
  for (const w of room) svc.observeFreshWindow('claude-code', 'a', w)
  await svc.rebuildNow()
  expect(svc.hasRoom('claude', meta.model, 'a')).toBe(false)
  svc.stop()
})


it('a failed provider sweep reports its reason without granting room', async () => {
  const h = host('mac')
  await h.svc.list()
  const svc = new AccountsService({
    vaultPresent: () => true, locked: () => false,
    listServices: async () => [{ id: 'claude-code', profiles: [{ name: 'a' }] }] as ServiceView[],
    usage: async () => { throw new Error('provider timeout') }, headroom: () => h.headroom
  })
  await expect(svc.refresh('claude')).rejects.toThrow('usage unavailable (provider timeout)')
  svc.stop()
  h.svc.stop()
})
