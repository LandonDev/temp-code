import { describe, expect, it } from 'vitest'
import { summarizeSwitch, switchMarkdown, switchReady, type SwitchClick } from './lib/soakSwitch'
import { judgeSwitch, parseSoakArgs, SWITCH_RULE } from './lib/soakJudge'

const click = (target: string, readyMs: number | null, paneMs: number | null = null, longTasks: number[] = []): SwitchClick => ({
  target,
  readyMs,
  paneMs,
  longTasks: longTasks.map((duration, i) => ({ start: i * 100, duration })),
  frames: [],
  requests: { 'session.focus': 1 },
  panes: ['m']
})

describe('the switch scene', () => {
  it("is ready once the column shows the workspace's cards and the strip one of its threads", () => {
    const expect_ = { cards: ['api', 'web'], chips: ['Fix the login', 'Docs'], pane: 'm' }
    expect(switchReady({ cards: ['api', 'web'], chips: ['Docs'], pane: 'x' }, expect_)).toBe(true)
    expect(switchReady({ cards: ['api'], chips: ['Docs'], pane: 'm' }, expect_)).toBe(false)
    expect(switchReady({ cards: ['api', 'web'], chips: ['Other'], pane: 'm' }, expect_)).toBe(false)
    // A workspace whose strip was empty is ready only with an empty strip.
    expect(switchReady({ cards: ['api', 'web'], chips: [], pane: null }, { ...expect_, chips: [] })).toBe(true)
    expect(switchReady({ cards: ['api', 'web'], chips: ['Docs'], pane: null }, { ...expect_, chips: [] })).toBe(false)
  })

  it('sums the clicks by workspace, counts the clicks that never showed theirs, and judges p95 at 100 ms', () => {
    const clicks = [click('a', 60, 70), click('b', 80), click('a', 90, 95, [55]), click('b', 70), click('a', null)]
    const summary = summarizeSwitch(clicks)
    expect(summary.ready).toEqual({ n: 4, p50: 70, p95: 90, p99: 90, max: 90 })
    expect(summary.pane.n).toBe(2)
    expect(summary.missed).toBe(1)
    expect(summary.longTasks).toEqual({ count: 1, maxMs: 55 })
    expect(summary.byTarget.a!.ready.n).toBe(2)
    const verdict = judgeSwitch(summary)
    expect(verdict.ok).toBe(false)
    expect(verdict.verdicts.map((v) => [v.what, v.ok])).toEqual([
      ['click to column and strip p95, ms', true],
      ['clicks that never showed their workspace', false]
    ])
    expect(judgeSwitch(summarizeSwitch([click('a', 120), click('b', 60)])).ok).toBe(false)
    expect(SWITCH_RULE.readyP95Ms).toBe(100)
    const md = switchMarkdown(clicks, summary)
    expect(md[2]).toContain('| 1 | a | 60 | 70 |')
    expect(md.at(-1)).toContain('| all | 70 / 90 / 90 |')
  })

  it('switches between the synthetic workspaces, or two of the box named, with its own clicks and no window of its own', () => {
    expect(parseSoakArgs(['--scene', 'switch'])).toMatchObject({ scene: 'switch', host: 'synthetic', clicks: 20, workspaces: ['soak', 'client'], label: 'synthetic-prod-switch' })
    expect(parseSoakArgs(['--scene', 'switch', '--gate'])).toMatchObject({ clicks: 12, label: 'gate-switch' })
    expect(parseSoakArgs(['--scene', 'switch', '--host', 'box'])).toMatchObject({ workspaces: ['temp-code', 'CosmicClient'] })
    expect(parseSoakArgs(['--scene', 'switch', '--host', 'box', '--workspaces', 'temp-code,cosmicweb', '--clicks', '8'])).toMatchObject({ workspaces: ['temp-code', 'cosmicweb'], clicks: 8 })
    expect(() => parseSoakArgs(['--scene', 'switch', '--workspaces', 'one'])).toThrow('two names')
    expect(() => parseSoakArgs(['--scene', 'switch', '--clicks', '1'])).toThrow('at least 2')
    expect(() => parseSoakArgs(['--scene', 'switch', '--view', 'split'])).toThrow('opens no view')
    expect(() => parseSoakArgs(['--scene', 'switch', '--minutes', '3'])).toThrow('runs its own steps')
    expect(() => parseSoakArgs(['--clicks', '4'])).toThrow('belong to --scene switch')
  })
})
