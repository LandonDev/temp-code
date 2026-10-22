import { describe, expect, it } from 'vitest'
import { AccountsSnapshotSchema, WireAgentEventSchema } from '../src/shared/wireSchemas'
import { HostDevicesReportSchema } from '../src/shared/contract-hostdevices'
import { FailureKindSchema, NoticeKindSchema } from '../src/shared/events'
import { NOTE_SECTIONS, notesEmpty, parseNotes, stateLine } from '../src/shared/notes'
import { parseProjectPlan } from '../src/shared/projectPlan'
import { BatchStateSchema } from '../src/shared/contract-batch'
import { MacDevices } from '../src/main/server/devices/hostDevices'
import {
  PREAMBLE_WORDS,
  accountsSnapshot,
  batchRowMidRun,
  devicesReport,
  failureRows,
  fakeMacDevicesDeps,
  noticeRows,
  noticesThreadRows,
  notesFive,
  notesTwo,
  preambleRow,
  preambleText,
  projectPlanMarkdown,
  withShellLog
} from './lib/ios-seeds'

describe('the notices thread', () => {
  it('carries one notice per NoticeKind and one error per FailureKind, every row on the wire schema', () => {
    const kinds = noticeRows().map((r) => (r.type === 'notice' ? r.kind : null))
    for (const kind of NoticeKindSchema.options) expect(kinds).toContain(kind)
    const failures = failureRows().map((r) => (r.type === 'error' ? r.failure?.kind : null))
    expect(failures).toEqual(FailureKindSchema.options)
    for (const row of noticesThreadRows()) expect(WireAgentEventSchema.parse(row)).toEqual(row)
  })
  it('names the review and gate payloads the cards read', () => {
    const rows = noticeRows('rev')
    const held = rows.find((r) => r.type === 'notice' && r.review?.outcome === 'held')
    expect(held?.type === 'notice' && held.review?.blocking[0]?.verdict).toBe('CONFIRMED')
    expect(held?.type === 'notice' && held.review?.minor).toHaveLength(2)
    expect(held?.type === 'notice' && held.review?.reviewerId).toBe('rev')
    const red = rows.find((r) => r.type === 'notice' && r.gate?.ok === false)
    expect(red?.type === 'notice' && red.gate?.log.split('\n')).toHaveLength(40)
    expect(red?.type === 'notice' && red.gate?.log.endsWith('✗ vitest 12s')).toBe(true)
    const limited = failureRows().find((r) => r.type === 'error' && r.failure?.kind === 'rate_limited')
    expect(limited?.type === 'error' && limited.limit?.window).toBe('5h')
    const whole = noticesThreadRows('build-1')
    expect(whole.at(-1)).toEqual({ type: 'status', status: 'error' })
    expect(whole.find((r) => r.type === 'plan-handoff')).toMatchObject({ sessionId: 'build-1', how: 'auto' })
    expect(whole.some((r) => r.type === 'errors-cleared')).toBe(true)
  })
  it('stamps the preamble with its word count', () => {
    expect(preambleText().split(/\s+/)).toHaveLength(PREAMBLE_WORDS)
    const row = preambleRow()
    expect(row.type === 'user-text' && row.preamble?.words).toBe(PREAMBLE_WORDS)
  })
})

describe('the notes', () => {
  it('fill every heading, or two, with the headings always present', () => {
    const five = parseNotes(notesFive())
    expect(five.sections.map((s) => s.heading)).toEqual([...NOTE_SECTIONS])
    expect(five.sections.every((s) => s.body.trim().length > 0)).toBe(true)
    expect(stateLine(notesFive())).toBe('Drawer built; the banner line next.')
    const two = parseNotes(notesTwo())
    expect(two.sections.map((s) => s.heading)).toEqual([...NOTE_SECTIONS])
    expect(two.sections.filter((s) => s.body.trim()).map((s) => s.heading)).toEqual(['Goal', 'State'])
    expect(notesEmpty(notesTwo())).toBe(false)
  })
})

describe('the project plan', () => {
  it('is complete with seven milestones, three done, no missing section', () => {
    const plan = parseProjectPlan(projectPlanMarkdown())
    expect(plan.status).toBe('complete')
    expect(plan.missing).toEqual([])
    expect(plan.milestones).toHaveLength(7)
    expect(plan.milestones.filter((m) => m.done).map((m) => m.index)).toEqual([1, 2, 3])
    expect(plan.milestones[3]?.title).toBe('Search across hosts')
    expect(plan.milestones.every((m) => m.scope && m.dependencies && m.doneWhen)).toBe(true)
  })
})

describe('the batch row', () => {
  it('is mid-run: land passed, gate running at 2 of 3, the shell step streaming', () => {
    const row = batchRowMidRun('m', { landed: ['a', 'b'], pending: ['c', 'd'] })
    const { armed: _armed, branches: _b, subjects: _s, holds: _h, version: _v, deployRef: _d, leftOut: _l, ...wire } = row
    expect(BatchStateSchema.parse({ ...wire, pending: ['c', 'd'] })).toBeTruthy()
    expect(row.steps.map((s) => [s.id, s.status])).toEqual([['land', 'passed'], ['gate', 'running'], ['release', 'pending'], ['smoke', 'running']])
    expect(row.steps[0]?.detail).toBe('2 of 4 branches landed')
    expect(row.steps[1]?.progress).toEqual({ done: 2, total: 3, label: 'vitest' })
    const smoke = row.steps[3]!
    expect(smoke.kind).toBe('shell')
    expect(smoke.log).toHaveLength(40)
    expect(smoke.log[0]).toBe('$ bun run smoke')
    expect(row.landed).toEqual(['a', 'b'])
    expect(row.held).toEqual([])
    expect(row.rules.steps.at(-1)).toMatchObject({ kind: 'shell', run: 'bun run smoke', when: 'all-done' })
  })
  it('appends to the running shell step, keeping the newest 200 lines', () => {
    const row = withShellLog(batchRowMidRun('m', { landed: [], pending: ['c'] }), Array.from({ length: 170 }, (_, i) => `more ${i}`))
    const smoke = row.steps.find((s) => s.kind === 'shell')!
    expect(smoke.log).toHaveLength(200)
    expect(smoke.log.at(-1)).toBe('more 169')
    expect(row.steps.find((s) => s.id === 'gate')?.log).toHaveLength(2)
  })
})

describe('devices', () => {
  it('the hand-written report parses', () => {
    expect(HostDevicesReportSchema.parse(devicesReport('env_a'))).toEqual(devicesReport('env_a'))
  })
  it('the fake gatherer answers the same simulators, phone, Xcode and load', async () => {
    const report = await new MacDevices(fakeMacDevicesDeps('env_a')).report()
    expect(HostDevicesReportSchema.parse(report)).toEqual(report)
    expect(report.problems).toEqual([])
    expect(report.simulators.map((s) => [s.name, s.state])).toEqual([['iPhone 17', 'booted'], ['iPhone 17 Pro', 'shutdown']])
    expect(report.simulators[0]?.holder?.sessionId).toBe('ios-resources')
    expect(report.simulators[0]?.cpu).toBe(12.5)
    expect(report.simulators[1]?.holder).toBeNull()
    expect(report.phones.map((p) => [p.model, p.connection, p.transport])).toEqual([['iPhone 16 Pro', 'paired', 'Wi-Fi']])
    expect(report.xcode).toEqual({ path: '/Applications/Xcode-26.app', name: 'Xcode-26', version: '26.0', from: 'newest' })
    expect(report.load).toEqual({ oneMinute: 3.2, cores: 8 })
    expect(report).toEqual(devicesReport('env_a'))
  })
})

describe('accounts', () => {
  it('the snapshot carries two Claude profiles of different headroom and the peer, and the phone's subset parses it', () => {
    const build = { release: 400, version: '1.0.400', sha: 'abc', platform: 'linux' }
    const snapshot = accountsSnapshot({ environmentId: 'env_b', name: 'The box', build })
    expect(AccountsSnapshotSchema.safeParse(snapshot).success).toBe(true)
    const claude = snapshot.providers.claude
    expect(claude.pinned).toBe('work@example.com')
    expect(claude.profiles.map((p) => p.name)).toEqual(['work@example.com', 'spare@example.com'])
    expect(claude.headroom?.['work@example.com']?.room).toBe(0.8)
    expect(claude.headroom?.['spare@example.com']?.throttledUntil).toBeGreaterThan(snapshot.updatedAt)
    expect(claude.reports[1]?.windows.find((w) => w.label === 'Weekly')?.usedPercent).toBe(95)
    expect(snapshot.providers.codex.profiles).toHaveLength(1)
    expect(snapshot.peers?.env_b).toMatchObject({ connected: true, build })
  })
})
