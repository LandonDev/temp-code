import { describe, expect, it } from 'vitest'
import { buildIsCurrent, FAMILY, GATE_CPU_PCT, GATE_RULE, gateRule, handRule, judgeSoak, parseSoakArgs, type SoakSample } from './lib/soakJudge'

const sample = (t: number, over: Partial<SoakSample> = {}): SoakSample => ({ t, heapMb: 40, rssMb: 200, cpuS: 0.5, wallS: 10, longTasks: [], ...over })

/** Six samples 10 s apart over a 50 s window, flat unless a reading says otherwise. */
const windowOf = (read: (i: number) => Partial<SoakSample>): SoakSample[] => Array.from({ length: 6 }, (_, i) => sample(i * 10_000, read(i)))

describe('the soak arguments', () => {
  it('runs the gate on the synthetic host, production build, split view, 50 s', () => {
    const args = parseSoakArgs(['--gate'])
    expect(args).toMatchObject({ gate: true, host: 'synthetic', build: 'prod', scene: 'board', view: 'split', every: 10, profile: false, cpuReportOnly: false, label: 'gate' })
    expect(parseSoakArgs(['--gate', '--cpu-report-only']).cpuReportOnly).toBe(true)
    expect(() => parseSoakArgs(['--cpu-report-only'])).toThrow('belongs to --gate')
    expect(() => parseSoakArgs(['--gate', '--cpu-fails'])).toThrow('fails on CPU by default')
    expect(args.minutes * 60).toBeCloseTo(50)
  })
  it('shows the chat scene as a stream of its one thread', () => {
    expect(parseSoakArgs(['--gate', '--scene', 'chat'])).toMatchObject({ scene: 'chat', view: 'stream', label: 'gate-chat' })
    expect(parseSoakArgs(['--scene', 'chat'])).toMatchObject({ scene: 'chat', view: 'stream', label: 'synthetic-prod-chat' })
    expect(() => parseSoakArgs(['--scene', 'chat', '--view', 'split'])).toThrow('its view is stream')
    expect(() => parseSoakArgs(['--scene', 'chat', '--host', 'box'])).toThrow('synthetic host')
    expect(() => parseSoakArgs(['--scene', 'tabs'])).toThrow('--scene')
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
  it('traces and runs an experiment only when asked', () => {
    expect(parseSoakArgs(['--gate'])).toMatchObject({ traceS: 0, evalJs: null })
    expect(parseSoakArgs(['--gate', '--trace', '5', '--eval', 'document.getAnimations().length'])).toMatchObject({ traceS: 5, evalJs: 'document.getAnimations().length' })
    expect(() => parseSoakArgs(['--trace', '60'])).toThrow('0 to 30')
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
  it('fails heap growth past 6 MB and one long task past 200 ms', () => {
    expect(judgeSoak(windowOf((i) => ({ heapMb: 40 + i * 1.5 })), GATE_RULE).ok).toBe(false)
    expect(judgeSoak(windowOf((i) => ({ longTasks: i === 3 ? [{ start: 30_000, duration: 210 }] : [] })), GATE_RULE).ok).toBe(false)
  })
  it("fails CPU past its scene's bound, and only reports it with --cpu-report-only", () => {
    const over = windowOf(() => ({ cpuS: 3.4 }))
    const failing = judgeSoak(over, gateRule('board'))
    expect(failing.ok).toBe(false)
    expect(failing.verdicts.find((v) => v.what.startsWith('renderer CPU'))).toMatchObject({ got: 34, limit: GATE_CPU_PCT.board, ok: false })
    expect(failing.verdicts.find((v) => v.what.startsWith('renderer CPU'))?.reportOnly).toBeUndefined()
    const reported = judgeSoak(over, gateRule('board', true))
    expect(reported.ok).toBe(true)
    expect(reported.verdicts.find((v) => v.what.startsWith('renderer CPU'))).toMatchObject({ ok: false, reportOnly: true })
    // The chat scene has its own, tighter bound.
    const chat = windowOf(() => ({ cpuS: (GATE_CPU_PCT.chat + 1) / 10 }))
    expect(judgeSoak(chat, gateRule('board')).ok).toBe(true)
    expect(judgeSoak(chat, gateRule('chat')).ok).toBe(false)
    expect(GATE_RULE.cpuReportOnly).toBeUndefined()
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

describe("the gate's out/", () => {
  it('is HEAD only when stamped with HEAD from a clean tree that is still clean', () => {
    expect(buildIsCurrent({ sha: 'abc', clean: true }, 'abc', true)).toBe(true)
    expect(buildIsCurrent({ sha: 'abc', clean: true }, 'def', true)).toBe(false)
    expect(buildIsCurrent({ sha: 'abc', clean: false }, 'abc', true)).toBe(false)
    expect(buildIsCurrent({ sha: 'abc', clean: true }, 'abc', false)).toBe(false)
    expect(buildIsCurrent(null, 'abc', true)).toBe(false)
  })
})
