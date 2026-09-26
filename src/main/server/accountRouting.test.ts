import { describe, expect, it } from 'vitest'
import { emptyAccounts, type AccountsSnapshot } from '@shared/accounts'
import { chooseAccount, resolvePin } from './accountRouting'

const NOW = 1_800_000_000_000
const full = (label: string) => ({ label, usedPercent: 100, resetsAt: NOW + 3_600_000 })
const fine = (label: string, usedPercent = 10, resetsAt = NOW + 60_000) => ({ label, usedPercent, resetsAt })

function snapshot(reports: Record<string, { label: string; usedPercent: number; resetsAt?: number }[]>): AccountsSnapshot {
  const snap = emptyAccounts()
  snap.providers.claude = {
    pinned: null,
    owner: 'temp-code',
    profiles: Object.keys(reports).map((name) => ({ name, createdAt: 1, active: false })),
    reports: Object.entries(reports).map(([profileName, windows]) => ({ profileName, windows }))
  }
  return snap
}

describe('resolvePin', () => {
  const project = { accountPins: { claude: 'proj@x.com' } }
  const workspace = { accountPins: { claude: 'ws@x.com', codex: 'ws-codex' } }
  it('thread beats project beats workspace; unset levels inherit', () => {
    expect(resolvePin({ provider: 'claude', accountPin: 'me@x.com' }, project, workspace)).toEqual({ name: 'me@x.com', level: 'thread' })
    expect(resolvePin({ provider: 'claude', accountPin: null }, project, workspace)).toEqual({ name: 'proj@x.com', level: 'project' })
    expect(resolvePin({ provider: 'claude', accountPin: null }, { accountPins: {} }, workspace)).toEqual({ name: 'ws@x.com', level: 'workspace' })
    expect(resolvePin({ provider: 'claude', accountPin: null }, null, workspace)).toEqual({ name: 'ws@x.com', level: 'workspace' })
    expect(resolvePin({ provider: 'claude', accountPin: null }, null, null)).toBeNull()
  })
  it('pins are per provider: a codex thread ignores the claude pins', () => {
    expect(resolvePin({ provider: 'codex', accountPin: null }, project, workspace)).toEqual({ name: 'ws-codex', level: 'workspace' })
    expect(resolvePin({ provider: 'cursor', accountPin: 'x' }, project, workspace)).toBeNull()
  })
  it('a child of a pinned parent has no pin of its own: the parent pin never cascades', () => {
    // The child row carries accountPin null (create never copies it); only project and workspace apply.
    const child = { provider: 'claude' as const, accountPin: null }
    expect(resolvePin(child, null, null)).toBeNull()
    expect(resolvePin(child, project, null)?.level).toBe('project')
  })
})

describe('chooseAccount', () => {
  const base = { model: 'claude-opus-5-5', provider: 'claude' as const, now: NOW }
  it('a pin with room is the route and the expected account', () => {
    const snap = snapshot({ 'a@x.com': [fine('5h')], 'b@x.com': [fine('5h')] })
    expect(chooseAccount({ ...base, pin: 'a@x.com', current: null, snapshot: snap })).toEqual({ route: { account: 'a@x.com', pin: true }, current: 'a@x.com' })
  })
  it('a pin that is out stays the route (the gateway returns to it) while the row expects the fallback', () => {
    const snap = snapshot({ 'a@x.com': [full('Weekly')], 'b@x.com': [fine('Weekly', 50, NOW + 5)], 'c@x.com': [fine('Weekly', 10, NOW + 9)] })
    // Already fell over to c: sticky.
    expect(chooseAccount({ ...base, pin: 'a@x.com', current: 'c@x.com', snapshot: snap })).toEqual({ route: { account: 'a@x.com', pin: true }, current: 'c@x.com' })
    // First spawn: the best pick for the model, soonest reset first.
    expect(chooseAccount({ ...base, pin: 'a@x.com', current: null, snapshot: snap })).toEqual({ route: { account: 'a@x.com', pin: true }, current: 'b@x.com' })
    // Nothing has room: the pin it is, and the 429 surfaces.
    const none = snapshot({ 'a@x.com': [full('Weekly')], 'b@x.com': [full('5h')] })
    expect(chooseAccount({ ...base, pin: 'a@x.com', current: null, snapshot: none })).toEqual({ route: { account: 'a@x.com', pin: true }, current: 'a@x.com' })
  })
  it('a pin the vault no longer holds is ignored', () => {
    const snap = snapshot({ 'b@x.com': [fine('5h')] })
    expect(chooseAccount({ ...base, pin: 'gone@x.com', current: null, snapshot: snap })).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
  })
  it('without a pin the current account is sticky while it has room for the model', () => {
    const snap = snapshot({ 'a@x.com': [fine('Weekly', 10, NOW + 1)], 'b@x.com': [fine('Weekly', 90, NOW + 9)] })
    expect(chooseAccount({ ...base, pin: null, current: 'b@x.com', snapshot: snap })).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
  })
  it('room is judged in the model\'s own windows: a Fable thread leaves a full Fable cap, an Opus thread does not', () => {
    const snap = snapshot({ 'a@x.com': [fine('Weekly', 10, NOW + 1), full('Fable')], 'b@x.com': [fine('Weekly', 20, NOW + 9)] })
    expect(chooseAccount({ ...base, model: 'claude-fable-5-1', pin: null, current: 'a@x.com', snapshot: snap }).route).toEqual({ account: 'b@x.com', pin: false })
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: null, current: 'a@x.com', snapshot: snap }).route).toEqual({ account: 'a@x.com', pin: false })
  })
  it('an unpinned first spawn picks by soonest reset of the model\'s window, ties to the fuller account', () => {
    const snap = snapshot({
      'late@x.com': [fine('Weekly', 10, NOW + 9)],
      'soon@x.com': [fine('Weekly', 10, NOW + 1)],
      'soon-full@x.com': [fine('Weekly', 80, NOW + 1)]
    })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: snap })).toEqual({ route: { account: 'soon-full@x.com', pin: false }, current: 'soon-full@x.com' })
  })
  it('nothing with room keeps the current account; with nothing at all the URL goes unscoped', () => {
    const snap = snapshot({ 'a@x.com': [full('5h')], 'b@x.com': [full('5h')] })
    expect(chooseAccount({ ...base, pin: null, current: 'b@x.com', snapshot: snap })).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: snap })).toEqual({ route: null, current: null })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: emptyAccounts() })).toEqual({ route: null, current: null })
    expect(chooseAccount({ ...base, provider: 'cursor', pin: 'x', current: null, snapshot: snap })).toEqual({ route: null, current: null })
  })
})
