import { describe, expect, it } from 'vitest'
import { FAMILY, GATE_RULE, handRule, judgeSoak, parseSoakArgs, type SoakSample } from './lib/soakJudge'

const sample = (t: number, over: Partial<SoakSample> = {}): SoakSample => ({ t, heapMb: 40, rssMb: 200, cpuS: 0.5, wallS: 10, longTasks: [], ...over })

/** Six samples 10 s apart over a 50 s window, flat unless a reading says otherwise. */
const windowOf = (read: (i: number) => Partial<SoakSample>): SoakSample[] => Array.from({ length: 6 }, (_, i) => sample(i * 10_000, read(i)))

describe('the soak arguments', () => {
  it('runs the gate on the synthetic host, production build, split view, 50 s', () => {
    const args = parseSoakArgs(['--gate'])
    expect(args).toMatchObject({ gate: true, host: 'synthetic', build: 'prod', view: 'split', every: 10, profile: false })
    expect(args.minutes * 60).toBeCloseTo(50)
  })
  it('refuses the box, a dev build or a timing of its own in gate mode', () => {
    expect(() => parseSoakArgs(['--gate', '--host', 'box'])).toThrow('synthetic host only')
    expect(() => parseSoakArgs(['--gate', '--build', 'dev'])).toThrow('production build only')
    expect(() => parseSoakArgs(['--gate', '--minutes', '30'])).toThrow('its own timing')
  })
  it('takes a hand run as asked', () => {
    expect(parseSoakArgs(['--host', 'box', '--view', 'stream', '--minutes', '30', '--every', '30', '--label', 'after-box'])).toMatchObject({
      host: 'box',
      view: 'stream',
      minutes: 30,
      every: 30,
      label: 'after-box',
      profile: true
    })
    expect(() => parseSoakArgs(['--view', 'tabs'])).toThrow('--view')
    expect(() => parseSoakArgs(['--label', 'a b'])).toThrow('--label')
    expect(() => parseSoakArgs(['--minutes'])).toThrow('needs a value')
  })
})

describe('the gate rule', () => {
  it('passes a flat, quiet window', () => {
    const verdict = judgeSoak(windowOf(() => ({})), GATE_RULE)
    expect(verdict.ok).toBe(true)
    expect(verdict.verdicts.map((v) => v.what)).toEqual([
      'heap after GC growth, MB',
      'renderer RSS after GC growth, MB',
      'renderer CPU, % of one core',
      'longest long task, ms',
      'long tasks in one second, ms'
    ])
  })
  it('fails a leak of the incident class: dev at +66 MB a minute passes 30 MB in under a minute', () => {
    const verdict = judgeSoak(windowOf((i) => ({ rssMb: 200 + (66 / 6) * i })), GATE_RULE)
    expect(verdict.ok).toBe(false)
    expect(verdict.verdicts.find((v) => v.what.startsWith('renderer RSS'))).toMatchObject({ got: 55, ok: false })
  })
  it('fails heap growth past 6 MB, CPU past 12% and one long task past 200 ms', () => {
    expect(judgeSoak(windowOf((i) => ({ heapMb: 40 + i * 1.5 })), GATE_RULE).ok).toBe(false)
    expect(judgeSoak(windowOf(() => ({ cpuS: 1.3 })), GATE_RULE).verdicts.find((v) => v.what.startsWith('renderer CPU'))).toMatchObject({ got: 13, ok: false })
    expect(judgeSoak(windowOf((i) => ({ longTasks: i === 3 ? [{ start: 30_000, duration: 210 }] : [] })), GATE_RULE).ok).toBe(false)
  })
  it('sums the long tasks of one second', () => {
    const tasks = [
      { start: 12_000, duration: 120 },
      { start: 12_400, duration: 140 },
      { start: 13_100, duration: 150 }
    ]
    const verdict = judgeSoak(windowOf((i) => ({ longTasks: i === 2 ? tasks : [] })), GATE_RULE)
    expect(verdict.verdicts.find((v) => v.what === 'long tasks in one second, ms')).toMatchObject({ got: 260, ok: false })
  })
  it('reads CPU over the window, not the launch before it', () => {
    const verdict = judgeSoak(windowOf((i) => ({ cpuS: i === 0 ? 9 : 0.5 })), GATE_RULE)
    expect(verdict.verdicts.find((v) => v.what.startsWith('renderer CPU'))).toMatchObject({ got: 5, ok: true })
  })
})

describe('a hand run', () => {
  it('states growth as the slope per 30 minutes', () => {
    const samples = Array.from({ length: 11 }, (_, i) => sample(i * 60_000, { heapMb: 40 + i * 2, rssMb: 200 + i * 2, wallS: 60, cpuS: 3 }))
    const verdict = judgeSoak(samples, handRule('prod', 'board'))
    expect(verdict.verdicts.find((v) => v.what.startsWith('heap'))).toMatchObject({ got: 60, limit: 50, ok: false })
    expect(verdict.verdicts.find((v) => v.what.startsWith('renderer RSS'))).toMatchObject({ got: 60, limit: 100, ok: true })
    expect(verdict.verdicts.find((v) => v.what.startsWith('renderer CPU'))).toMatchObject({ got: 5, limit: 6, ok: true })
  })
  it('bounds a dev build by its re-renders instead of a CPU figure', () => {
    const rule = handRule('dev', 'board')
    expect(rule.cpuPct).toBeUndefined()
    expect(rule.rssGrowthMb).toBe(150)
    const samples = Array.from({ length: 3 }, (_, i) => sample(i * 60_000, { wallS: 60, renders: { total: 51_000, family: 35_000 } }))
    const verdict = judgeSoak(samples, rule)
    expect(verdict.verdicts.find((v) => v.what.startsWith('changed-props'))).toMatchObject({ got: 51_000, ok: false })
    expect(verdict.verdicts.find((v) => v.what.startsWith('tooltip'))).toMatchObject({ got: 35_000, ok: false })
  })
  it('counts the tooltip and button family by component name', () => {
    for (const name of ['Tooltip', 'TooltipTrigger', 'TooltipRoot', 'Tip', 'Button', 'HoverAction']) expect(FAMILY.test(name), name).toBe(true)
    for (const name of ['RailRow', 'WorkspaceRow', 'Chip', 'ButtonGroup']) expect(FAMILY.test(name), name).toBe(false)
  })
})
