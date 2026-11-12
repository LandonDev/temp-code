import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_EFFECT_FACTS } from '@shared/statusWords'
import type { ComputerHistoryCall } from '@shared/contract-computer'
import { tierVerdictSetting } from '@shared/computer/tools'
import { computerHarness, type ComputerHarness } from './runHarness'
import type { SessionTierGate } from './tierGate'

// The journal is a second account of a call: the first is the answer the model gets (result.ts `outcomeOf`,
// `formatStepLine`). This file holds one case per row of the table in docs/computer-protocol.md §17.9 "The answer
// and the journal": each thing the answer says of what the call did, and where the journal says it. The rows that
// had a case already keep it where it is (run.test.ts "the journal", "Splitty", "steps that need the app active").

const harnesses: ComputerHarness[] = []
const make = (opts: Parameters<typeof computerHarness>[0] = {}): ComputerHarness => {
  const h = computerHarness({ history: { pictures: () => false }, ...opts })
  harnesses.push(h)
  return h
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

/** the thread's newest call as a reader gets it, once everything queued is written */
const newest = async (h: ComputerHarness): Promise<ComputerHistoryCall> => {
  await h.sessions.drained('t1')
  return (await h.history!.read(['t1']))[0].calls.at(-1)!
}
const verdict = (h: ComputerHarness, bundleId: string, extra: Record<string, unknown> = {}): void => {
  h.rows.set(tierVerdictSetting(bundleId), JSON.stringify({ bundleId, classes: { click: 'session' }, misses: {}, updatedAt: Date.now(), ...extra }))
}
const admitAll = (): SessionTierGate => ({ admitted: () => false, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) })
const frontAdmitted = (): SessionTierGate => ({ admitted: () => false, frontAdmitted: () => true, request: async () => ({ admit: true }), run: (c, send) => send(c.tiers) })

describe('the answer and the journal: a step that ran', () => {
  it('its tier, what it acted on and its element', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(o.steps[0]).toContain(' · ax · ')
    expect((await newest(h)).steps[0]).toMatchObject({ verb: 'Clicked', state: 'ok', tier: 'ax', target: 'a checkbox in the "Formatting" group', element: 21 })
  })

  it('an effect that is not the plain one, and the steps the service did not run after it', async () => {
    const h = make({ gate: admitAll() })
    verdict(h, 'dev.fake.splitty', { key: 'session', type: 'session' })
    await h.run('computer_observe', { app: 'Splitty' })
    const o = await h.run('computer_batch', { app: 'Splitty', actions: [{ action: 'left_click', element: 5 }, { action: 'key', text: 'Return' }] })
    expect(o.steps[0]).toContain('no change seen')
    expect(o.steps[1]).toMatch(/^Not executed: /)
    const steps = (await newest(h)).steps
    expect(steps[0]).toMatchObject({ verb: 'Clicked', state: 'ok' })
    expect(steps[0].facts).toContain(COMPUTER_EFFECT_FACTS.none)
    // the service's reason for not running it is the model's to act on: the row says it did not run
    expect(steps[1]).toMatchObject({ verb: 'Press', state: 'not-run' })
    expect(steps[1].reason).toBeUndefined()
  })

  it('what it did on disk and the route it took, in front', async () => {
    const h = make({ gate: frontAdmitted() })
    await h.run('computer_observe', { app: 'Fronty' })
    const o = await h.run('computer_act', { app: 'Fronty', action: 'key', text: 'super+s' })
    expect(o.steps[0]).toBe('key super+s · front menu File › Save · changed · on disk: saved ~/run/Total.txt')
    const step = (await newest(h)).steps[0]
    expect(step).toMatchObject({ verb: 'Pressed', object: '⌘S', state: 'ok', tier: 'front' })
    expect(step.facts).toEqual(expect.arrayContaining(['saved ~/run/Total.txt', 'through the menu File › Save']))
  })

  it('a window it opened', async () => {
    const h = make()
    verdict(h, 'dev.fake.newdoc', { type: 'session' })
    await h.run('computer_observe', { app: 'Newdoc' })
    const o = await h.run('computer_act', { app: 'Newdoc', action: 'key', text: 'super+n' })
    expect(o.steps[0]).toMatch(/ · opened window "Untitled 2"$/)
    expect((await newest(h)).steps[0].facts).toContain('opened "Untitled 2"')
  })

  it('the element a name resolved to', async () => {
    const h = make({ gate: admitAll() })
    await h.run('computer_observe', { app: 'Splitty' })
    const o = await h.run('computer_act', { app: 'Splitty', action: 'left_click', named: 'Search' })
    expect(o.steps[0]).toContain('"Search" [7] text field')
    expect((await newest(h)).steps[0]).toMatchObject({ verb: 'Clicked', object: 'Search', state: 'ok', element: 7 })
  })

  it('a menu it left open', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'Menuy' })
    const o = await h.run('computer_act', { app: 'Menuy', action: 'perform', element: 4, name: 'show menu' })
    expect(o.steps).toContain('menu left open: Action')
    expect((await newest(h)).steps[0].facts).toContain('left the menu Action open')
  })

  it('the app coming to the front during the call', async () => {
    const h = make({ env: { FAKE_ACT_STEAL: '1' } })
    await h.run('computer_observe', { app: 'TextEdit' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', element: 21 })
    expect(o.steps.at(-1)).toMatch(/^TextEdit came to the front; /)
    expect((await newest(h)).steps[0].facts?.some((f) => /^TextEdit came to the front and .+ was put back$/.test(f))).toBe(true)
  })

  it('the browser tab the host selected for it', async () => {
    const h = make({ gate: admitAll(), env: { FAKE_WEB_ACTIVE: '1' } })
    await h.run('computer_apps', {})
    await h.run('computer_observe', { app: 'Webby' })
    const o = await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })
    expect(o.steps[0]).toBe('Selected tab "Web report" in window "Web report - Webby"')
    expect((await newest(h)).steps[0].facts).toContain('selected the tab "Web report"')
  })

  it('the tab the host selected is said though the step it selected it for failed', async () => {
    const h = make({ gate: admitAll(), env: { FAKE_WEB_ACTIVE: '1' } })
    await h.run('computer_apps', {})
    await h.run('computer_observe', { app: 'Webby' })
    const o = await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'left_click', named: 'Nope' })
    expect(o.steps[0]).toBe('Selected tab "Web report" in window "Web report - Webby"')
    expect(o.steps[1]).toMatch(/^left_click "Nope" · failed: /)
    // the browser shows another tab now, whatever the click did: the fact stands on the step that was tried
    expect((await newest(h)).steps).toMatchObject([{ verb: 'Click', state: 'failed', reason: 'Nothing by that name was found', facts: ['selected the tab "Web report"'] }])
  })

  it('a read that was still changing when it was taken', async () => {
    const h = make()
    // the fake's reads always settle: this one says it ran out of time, as the service does for a busy window
    const send = h.service.request.bind(h.service) as (...a: unknown[]) => Promise<unknown>
    h.service.request = (async (method: string, ...rest: unknown[]) => {
      const answer = await send(method, ...rest)
      return method === 'state.get' ? { ...(answer as object), waited: { waitedMs: 1500, settled: false, busy: false, reason: 'max' } } : answer
    }) as typeof h.service.request
    await h.run('computer_observe', { app: 'TextEdit' })
    expect((await newest(h)).steps[0]).toMatchObject({ verb: 'Read', state: 'ok', facts: ['still changing after 1.5 s'] })
  })
})

describe('the answer and the journal: what the model saw', () => {
  it('a thin tree whose picture came with the answer reads Looked at the picture; without the picture, what it read', async () => {
    const h = make()
    const o = await h.run('computer_observe', { app: 'Thin' })
    expect(o.shots).toHaveLength(1)
    expect((await newest(h)).read).toBe('Looked at the picture')
    const blind = make()
    const none = await blind.run('computer_observe', { app: 'Thin', screenshot: false })
    expect(none.shots).toHaveLength(0)
    expect((await newest(blind)).read).toMatch(/^Read \d+ elements?$/)
  })
})

describe('the answer and the journal: a step that did not end well', () => {
  it('a failed step says why, and the steps after it did not run', async () => {
    const h = make({ gate: frontAdmitted() })
    await h.run('computer_observe', { app: 'Panely' })
    const o = await h.run('computer_batch', { app: 'Panely', actions: [{ action: 'save_as', path: '~/run/exists.txt' }, { action: 'key', text: 'Return' }] })
    expect(o.steps[0]).toMatch(/^save_as ~\/run\/exists\.txt · failed: /)
    const steps = (await newest(h)).steps
    expect(steps[0]).toMatchObject({ state: 'failed' })
    expect(steps[0].reason).toBeTruthy()
    expect(steps[1]).toMatchObject({ verb: 'Press', state: 'not-run' })
  })

  it('a screenshot step with Screen Recording off says the permission', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'NoShot' })
    const o = await h.run('computer_batch', { app: 'NoShot', actions: [{ action: 'screenshot' }] })
    expect(o.steps[0]).toMatch(/^screenshot · failed: /)
    expect((await newest(h)).steps[0]).toMatchObject({ state: 'failed', reason: 'Screen Recording was off' })
  })

  it('a step the gate refused where nothing schedules it says what it needed', async () => {
    const h = make()
    await h.run('computer_observe', { app: 'KeyWin' })
    await h.run('computer_act', { app: 'KeyWin', action: 'type', text: 'hi' })
    const o = await h.run('computer_act', { app: 'KeyWin', action: 'key', text: 'a' })
    expect(o.steps[0]).toMatch(/nothing schedules it yet$/)
    expect((await newest(h)).steps[0]).toMatchObject({ verb: 'Press', state: 'failed', reason: 'It needed your pointer and keyboard' })
  })

  it('a browser tab the gate would not switch to, whatever its reason, is never a step with no why', async () => {
    for (const [reason, state, words] of [
      ['no-scheduler', 'failed', 'It needed your pointer and keyboard'],
      ['cancelled', 'stopped', 'Cancelled']
    ] as const) {
      const gate: SessionTierGate = { admitted: () => false, request: async () => ({ admit: false, reason, message: 'the gate refused this tab switch' }), run: (c, send) => send(c.tiers) }
      const h = make({ gate, env: { FAKE_WEB_ACTIVE: '1' } })
      expect(await h.run('computer_act', { app: 'Webby', window: 'Web report', action: 'key', text: 'Tab' })).toMatchObject({ isError: true })
      expect((await newest(h)).steps.map((s) => [s.verb, s.state, s.reason]), reason).toEqual([['Press', state, words]])
    }
  })
})
