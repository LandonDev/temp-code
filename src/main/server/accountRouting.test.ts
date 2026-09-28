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
  it('project beats workspace; unset levels inherit; a thread has no pin of its own', () => {
    expect(resolvePin({ provider: 'claude' }, project, workspace)).toEqual({ name: 'proj@x.com', level: 'project' })
    expect(resolvePin({ provider: 'claude' }, { accountPins: {} }, workspace)).toEqual({ name: 'ws@x.com', level: 'workspace' })
    expect(resolvePin({ provider: 'claude' }, null, workspace)).toEqual({ name: 'ws@x.com', level: 'workspace' })
    expect(resolvePin({ provider: 'claude' }, null, null)).toBeNull()
  })
  it('pins are per provider: a codex thread ignores the claude pins', () => {
    expect(resolvePin({ provider: 'codex' }, project, workspace)).toEqual({ name: 'ws-codex', level: 'workspace' })
    expect(resolvePin({ provider: 'cursor' }, project, workspace)).toBeNull()
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
  it('an Opus thread leaves a Fable-fresh account for a Fable-spent one; a Fable thread and a thread on a spent account stay', () => {
    const spentB = { 'a@x.com': [fine('Weekly', 10, NOW + 1), fine('Fable', 0, NOW + 9)], 'b@x.com': [fine('Weekly', 20, NOW + 9), full('Fable')] }
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: null, current: 'a@x.com', snapshot: snapshot(spentB) })).toEqual({
      route: { account: 'b@x.com', pin: false },
      current: 'b@x.com'
    })
    expect(chooseAccount({ ...base, model: 'claude-fable-5-1', pin: null, current: 'a@x.com', snapshot: snapshot(spentB) }).route).toEqual({ account: 'a@x.com', pin: false })
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: null, current: 'b@x.com', snapshot: snapshot(spentB) }).route).toEqual({ account: 'b@x.com', pin: false })
    // Two Fable-fresh accounts: the fuller one ranks first, but the thread stays where it is.
    const bothFresh = { 'a@x.com': [fine('Weekly', 10, NOW + 1), fine('Fable', 20, NOW + 9)], 'b@x.com': [fine('Weekly', 10, NOW + 1), fine('Fable', 60, NOW + 9)] }
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: null, current: 'a@x.com', snapshot: snapshot(bothFresh) }).route).toEqual({ account: 'a@x.com', pin: false })
    // The spent account has no weekly room: nothing outranks the current one.
    const spentOut = { 'a@x.com': [fine('Weekly', 10, NOW + 1), fine('Fable', 0, NOW + 9)], 'b@x.com': [full('Weekly'), full('Fable')] }
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: null, current: 'a@x.com', snapshot: snapshot(spentOut) }).route).toEqual({ account: 'a@x.com', pin: false })
    // A pin holds whatever the classes say.
    expect(chooseAccount({ ...base, model: 'claude-opus-5-5', pin: 'a@x.com', current: 'a@x.com', snapshot: snapshot(spentB) }).route).toEqual({ account: 'a@x.com', pin: true })
  })
  it('an unpinned first spawn picks by soonest reset of the model\'s window, ties to the fuller account', () => {
    const snap = snapshot({
      'late@x.com': [fine('Weekly', 10, NOW + 9)],
      'soon@x.com': [fine('Weekly', 10, NOW + 1)],
      'soon-full@x.com': [fine('Weekly', 80, NOW + 1)]
    })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: snap })).toEqual({ route: { account: 'soon-full@x.com', pin: false }, current: 'soon-full@x.com' })
  })
  it('a usage-poll throttle on the soonest-reset account does not push it behind the rest', () => {
    const snap = snapshot({
      'late@x.com': [fine('Weekly', 30, NOW + 9_000), fine('Fable', 30, NOW + 9_000)],
      'soon-marked@x.com': [fine('Weekly', 32, NOW + 1_000), fine('Fable', 45, NOW + 1_000)]
    })
    const marked = snap.providers.claude!.reports.find((r) => r.profileName === 'soon-marked@x.com')!
    marked.rateLimit = { provider: 'Claude', until: NOW + 180_000 }
    expect(chooseAccount({ ...base, model: 'claude-fable-5-1', pin: null, current: null, snapshot: snap })).toEqual({
      route: { account: 'soon-marked@x.com', pin: false },
      current: 'soon-marked@x.com'
    })
  })
  it('nothing with room keeps the current account; with nothing at all the URL goes unscoped', () => {
    const snap = snapshot({ 'a@x.com': [full('5h')], 'b@x.com': [full('5h')] })
    expect(chooseAccount({ ...base, pin: null, current: 'b@x.com', snapshot: snap })).toEqual({ route: { account: 'b@x.com', pin: false }, current: 'b@x.com' })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: snap })).toEqual({ route: null, current: null })
    expect(chooseAccount({ ...base, pin: null, current: null, snapshot: emptyAccounts() })).toEqual({ route: null, current: null })
    expect(chooseAccount({ ...base, provider: 'cursor', pin: 'x', current: null, snapshot: snap })).toEqual({ route: null, current: null })
  })
})
