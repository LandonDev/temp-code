import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activityPayload, notificationPayload, type ApnsActivityUpdate, type ApnsNotice } from './apnsPayload'

/**
 * Parity by shared fixtures: infra/hub/test/fixtures/apns/*.json holds one
 * case per notification kind and per activity phase, `{ input, payload }`.
 * The hub's test reads the same files against its own builders, so the two
 * sides cannot drift; each `payload` is also what the master pushes with
 * `xcrun simctl push` for the simulator pass.
 */
const DIR = join(__dirname, '../../../../infra/hub/test/fixtures/apns')
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { input: unknown; payload: unknown }) }))

describe('the APNs payloads match the shared fixtures', () => {
  it('has every case the plan names', () => {
    expect(fixtures.map((f) => f.file.replace(/\.json$/, ''))).toEqual([
      'activity-failed',
      'activity-finished',
      'activity-paused',
      'activity-stopped',
      'activity-waiting',
      'activity-working-notasks',
      'activity-working-tasks',
      'activity-working-threads',
      'failed-batch-step',
      'failed-stopped',
      'failed-summary',
      'finished-batch',
      'finished-done',
      'finished-plan-started',
      'finished-plan-waiting',
      'host-down',
      'host-up',
      'needs-you-approval',
      'needs-you-plan',
      'needs-you-question',
      'needs-you-waiting',
      'stuck'
    ])
  })
  for (const f of fixtures.filter((f) => !f.file.startsWith('activity-'))) {
    it(`alert ${f.file}`, () => {
      expect(notificationPayload(f.input as ApnsNotice)).toEqual(f.payload)
    })
  }
  for (const f of fixtures.filter((f) => f.file.startsWith('activity-'))) {
    it(`activity ${f.file}`, () => {
      const update = f.input as ApnsActivityUpdate
      expect(activityPayload(update, update.ts)).toEqual(f.payload)
    })
  }
})

describe('the rules the fixtures rest on', () => {
  const base: ApnsNotice = { event: 'finished', hostId: 'box', title: 'T', body: 'b', ts: 1_000 }
  it('every alert is mutable, a notice without a host carries no tc.host, one without a thread no category', () => {
    const payload = notificationPayload(base) as { aps: Record<string, unknown>; tc: Record<string, unknown> }
    expect(payload.aps['mutable-content']).toBe(1)
    expect(payload.aps).not.toHaveProperty('category')
    expect(payload.tc).not.toHaveProperty('host')
    expect((notificationPayload({ ...base, hostName: 'mac' }) as { tc: Record<string, unknown> }).tc.host).toBe('mac')
  })
  it('a stopped end ranks with waiting and failed; a working update does not', () => {
    const score = (phase: ApnsActivityUpdate['state']['phase'], event: 'update' | 'end' = 'end') =>
      (activityPayload({ threadId: 't', event, state: { phase, since: 1, ts: 2 }, ts: 2 }, 2_000) as { aps: Record<string, number> }).aps['relevance-score']
    expect([score('stopped'), score('failed'), score('waiting')]).toEqual([100, 100, 100])
    expect([score('working', 'update'), score('paused', 'update'), score('finished')]).toEqual([50, 50, 50])
  })
})
