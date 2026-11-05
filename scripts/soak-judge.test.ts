import { describe, expect, it } from 'vitest'
import { buildIsCurrent, FAMILY, GATE_CPU_PCT, GATE_RULE, gateRule, handRule, judgeSoak, judgeTyping, parseSoakArgs, TYPING_RULE, type SoakSample } from './lib/soakJudge'
import type { PhaseSummary } from './lib/soakTyping'

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
  it('records the scenarios on the synthetic host, never in the gate, with its screencast and switches', () => {
    expect(parseSoakArgs(['--scene', 'scenarios'])).toMatchObject({ scene: 'scenarios', view: 'stream', host: 'synthetic', label: 'synthetic-prod-scenarios', screencast: null, reducedMotion: false, scrolledUp: false })
    expect(parseSoakArgs(['--scene', 'scenarios', '--screencast', '/tmp/cast', '--reduced-motion', '--scrolled-up'])).toMatchObject({ screencast: '/tmp/cast', reducedMotion: true, scrolledUp: true })
    expect(() => parseSoakArgs(['--gate', '--scene', 'scenarios'])).toThrow('never the gate')
    expect(() => parseSoakArgs(['--scene', 'scenarios', '--host', 'box'])).toThrow('synthetic host')
    expect(() => parseSoakArgs(['--scene', 'scenarios', '--view', 'split'])).toThrow('its view is stream')
    expect(() => parseSoakArgs(['--scrolled-up'])).toThrow('belongs to --scene scenarios')
    expect(parseSoakArgs(['--scene', 'scenarios'])).toMatchObject({ heightReport: false })
    expect(parseSoakArgs(['--scene', 'scenarios', '--height-report'])).toMatchObject({ heightReport: true })
    expect(() => parseSoakArgs(['--scene', 'chat', '--height-report'])).toThrow('--height-report belongs to --scene scenarios')
    expect(() => parseSoakArgs(['--gate', '--screencast', '/tmp/cast'])).toThrow('never the gate')
    expect(() => parseSoakArgs(['--scene', 'scenarios', '--screencast'])).toThrow('needs a value')
    expect(() => parseSoakArgs(['--scene', 'scenarios', '--screencast', '/tmp/cast', '--trace', '10'])).toThrow('run separately')
    // Reduced motion reads any scene.
    expect(parseSoakArgs(['--scene', 'chat', '--reduced-motion']).reducedMotion).toBe(true)
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
  it('takes a burst cadence for the chat scene and the reveal report by hand', () => {
    expect(parseSoakArgs(['--gate'])).toMatchObject({ burstMs: null, revealReport: false })
    expect(parseSoakArgs(['--scene', 'chat', '--burst', '250', '--reveal-report'])).toMatchObject({ burstMs: 250, revealReport: true, view: 'stream' })
    expect(() => parseSoakArgs(['--burst', '250'])).toThrow('--scene chat')
    expect(() => parseSoakArgs(['--scene', 'chat', '--burst', '2'])).toThrow('10 to 5000')
    expect(() => parseSoakArgs(['--gate', '--scene', 'chat', '--burst', '250'])).toThrow('never the gate')
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

describe('the typing scene', () => {
  const phase = (name: PhaseSummary['phase'], p95: number | null, over: Partial<PhaseSummary> = {}): PhaseSummary => ({
    phase: name,
    count: 100,
    seconds: 10,
    frame: { n: p95 === null ? 0 : 100, p50: p95 === null ? null : p95 / 2, p95, p99: p95, max: p95 },
    inputDelay: { n: 100, p50: 1, p95: 3, p99: 4, max: 5 },
    events: { over16: 0, p95: null, max: null },
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    frames: { count: 0, worst: [] },
    store: { flushesPerS: 8, metaFlushesPerS: 8, masterMetasPerS: 1, liveEditsPerS: 50 },
    text: { ok: true, firstDifference: null, expected: 100, actual: 100 },
    ...over
  })
  const passing = (): PhaseSummary[] => [phase('idle', 12), phase('busy', 30), phase('fast', 31), phase('burst', 400), phase('paste', null)]

  it('types into the master beside its board, on the gate or by hand, the box included', () => {
    expect(parseSoakArgs(['--gate', '--scene', 'typing'])).toMatchObject({ gate: true, scene: 'typing', view: 'board', host: 'synthetic', label: 'gate-typing', profile: false })
    expect(parseSoakArgs(['--scene', 'typing'])).toMatchObject({ gate: false, scene: 'typing', view: 'board', label: 'synthetic-prod-typing' })
    expect(parseSoakArgs(['--scene', 'typing', '--host', 'box'])).toMatchObject({ host: 'box', scene: 'typing', label: 'box-prod-typing' })
    expect(parseSoakArgs(['--scene', 'typing', '--build', 'dev', '--trace', '5'])).toMatchObject({ build: 'dev', traceS: 5 })
    expect(() => parseSoakArgs(['--gate', '--scene', 'typing', '--host', 'box'])).toThrow('synthetic host only')
    expect(() => parseSoakArgs(['--scene', 'typing', '--view', 'split'])).toThrow('its view is board')
    expect(() => parseSoakArgs(['--scene', 'typing', '--minutes', '5'])).toThrow('runs its own steps')
    expect(() => parseSoakArgs(['--gate', '--scene', 'typing', '--cpu-report-only'])).toThrow('never judges it')
  })

  it('passes when the paced phases are inside their bounds and every text is exact', () => {
    const verdict = judgeTyping(passing())
    expect(verdict.ok).toBe(true)
    expect(verdict.verdicts.map((v) => v.what)).toEqual([
      'idle: keystroke to frame p95, ms',
      'idle: longest long task, ms',
      'idle: characters wrong or missing',
      'busy: keystroke to frame p95, ms',
      'busy: longest long task, ms',
      'busy: characters wrong or missing',
      'fast: keystroke to frame p95, ms',
      'fast: longest long task, ms',
      'fast: characters wrong or missing',
      'burst: characters wrong or missing',
      'paste: characters wrong or missing'
    ])
  })

  it('fails a slow idle or busy keystroke, a long task while typing, or a wrong character in any phase', () => {
    const at = (i: number, p: PhaseSummary): PhaseSummary[] => passing().map((x, k) => (k === i ? p : x))
    expect(judgeTyping(at(0, phase('idle', 16.5))).ok).toBe(false)
    expect(judgeTyping(at(0, phase('idle', 16))).ok).toBe(true)
    expect(judgeTyping(at(1, phase('busy', 34))).ok).toBe(false)
    expect(judgeTyping(at(2, phase('fast', 30, { longTasks: { count: 1, totalMs: 120, maxMs: 120 } }))).ok).toBe(false)
    // The burst's latency and long tasks are the queue's: only its text counts.
    expect(judgeTyping(at(3, phase('burst', 900, { longTasks: { count: 4, totalMs: 900, maxMs: 300 } }))).ok).toBe(true)
    const wrong = judgeTyping(at(4, phase('paste', null, { text: { ok: false, firstDifference: 1_990, expected: 2_000, actual: 1_995 } })))
    expect(wrong.ok).toBe(false)
    expect(wrong.verdicts.find((v) => v.what === 'paste: characters wrong or missing')).toMatchObject({ got: 10, ok: false })
    // A phase with no keystroke reading cannot pass its bound.
    expect(judgeTyping(at(1, phase('busy', null))).ok).toBe(false)
  })

  it('a box run has no idle phase, and nothing judges what it skipped', () => {
    const verdict = judgeTyping(passing().slice(1))
    expect(verdict.ok).toBe(true)
    expect(verdict.verdicts.some((v) => v.what.startsWith('idle'))).toBe(false)
    expect(TYPING_RULE.p95Ms).toEqual({ idle: 16, busy: 33, fast: 33 })
  })
})
