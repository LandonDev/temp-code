/**
 * The pure parts of scripts/measure-renderer-soak.ts: its arguments and the
 * pass rule it judges recorded samples by (scripts/soak-judge.test.ts).
 *
 * Two rules. The gate's (`--gate`, the release gate's renderer-soak step):
 * across a 50 s window, heap after GC grows at most 6 MB, renderer RSS
 * after GC at most 30 MB, the renderer averages at most 12% of one core, no
 * long task passes 200 ms and long tasks take at most 250 ms of any second.
 * A hand run's (the targets of the Performance 1 plan): growth read as the
 * slope over the run and stated per 30 minutes, heap within +50 MB and RSS
 * within +100 MB (+150 MB on a dev build), CPU within the view's figure on
 * a production build, and on a dev build at most 5,000 component re-renders
 * with changed props a minute, 500 of them in the tooltip and button family.
 * The bounds are never raised to make a run pass.
 */

export type SoakHostKind = 'synthetic' | 'box'
export type SoakBuild = 'prod' | 'dev'
export type SoakView = 'board' | 'stream' | 'split'

export interface SoakArgs {
  host: SoakHostKind
  build: SoakBuild
  view: SoakView
  minutes: number
  /** seconds between samples */
  every: number
  label: string
  tree: string | null
  gate: boolean
  port: number
  /** box mode: the master and the thread to show, else picked from what runs */
  master: string | null
  thread: string | null
  /** a 60 s CPU profile at the end (off in gate mode) */
  profile: boolean
}

/** The gate's run: 20 s to launch, pair and open, 10 s to warm up, a 50 s window, then teardown, inside 90 s. */
export const GATE_TIMING = { budgetMs: 90_000, warmMs: 10_000, windowMs: 50_000, everyS: 10 }

export function parseSoakArgs(argv: readonly string[]): SoakArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    if (i < 0) return undefined
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  const gate = argv.includes('--gate')
  const host = (flag('--host') ?? 'synthetic') as SoakHostKind
  const build = (flag('--build') ?? 'prod') as SoakBuild
  const view = (flag('--view') ?? (gate ? 'split' : 'board')) as SoakView
  if (!['synthetic', 'box'].includes(host)) throw new Error('--host is synthetic or box')
  if (!['prod', 'dev'].includes(build)) throw new Error('--build is prod or dev')
  if (!['board', 'stream', 'split'].includes(view)) throw new Error('--view is board, stream or split')
  if (gate && host !== 'synthetic') throw new Error('--gate runs on the synthetic host only: the box is never in the release gate')
  if (gate && build !== 'prod') throw new Error('--gate measures the production build only')
  if (gate && (argv.includes('--minutes') || argv.includes('--every'))) throw new Error('--gate has its own timing (a 50 s window); drop --minutes and --every')
  const minutes = gate ? GATE_TIMING.windowMs / 60_000 : Number(flag('--minutes') ?? '10')
  const every = gate ? GATE_TIMING.everyS : Number(flag('--every') ?? '60')
  if (!(minutes > 0)) throw new Error('--minutes takes a positive number')
  if (!(every >= 1)) throw new Error('--every takes seconds, at least 1')
  if (every > minutes * 60) throw new Error('--every is longer than the run')
  const label = flag('--label') ?? (gate ? 'gate' : `${host}-${build}-${view}`)
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('--label takes letters, digits and dashes')
  const port = Number(flag('--port') ?? '9251')
  if (!Number.isInteger(port) || port < 1024) throw new Error('--port takes a debug port number')
  return {
    host,
    build,
    view,
    minutes,
    every,
    label,
    tree: flag('--tree') ?? null,
    gate,
    port,
    master: flag('--master') ?? null,
    thread: flag('--thread') ?? null,
    profile: !gate && !argv.includes('--no-profile')
  }
}

/** One sample: readings at `t`, and what happened since the sample before it. */
export interface SoakSample {
  /** ms since the window opened */
  t: number
  heapMb: number
  rssMb: number
  /** CPU seconds the renderer used since the previous sample, and the wall seconds between them */
  cpuS: number
  wallS: number
  gpuCpuS?: number
  /** long tasks that started since the previous sample, start in ms on the page's clock */
  longTasks: { start: number; duration: number }[]
  /** dev builds: component re-renders with changed props since the previous sample, all and the tooltip/button family */
  renders?: { total: number; family: number }
}

export interface SoakRule {
  name: string
  /** growth is read across the window (last − first), or with perMinutes as the slope stated per that many minutes */
  perMinutes?: number
  heapGrowthMb: number
  rssGrowthMb: number
  cpuPct?: number
  longTaskMaxMs: number
  longTaskPerSecondMs: number
  rendersPerMin?: number
  familyPerMin?: number
}

export const GATE_RULE: SoakRule = {
  name: 'gate',
  heapGrowthMb: 6,
  rssGrowthMb: 30,
  cpuPct: 12,
  longTaskMaxMs: 200,
  longTaskPerSecondMs: 250
}

/** The figures the plan set for a production build on the box, by view (xvfb, software paint). */
export const VIEW_CPU_PCT: Record<SoakView, number> = { board: 6, stream: 8, split: 8 }

export function handRule(build: SoakBuild, view: SoakView): SoakRule {
  return {
    name: `${build} ${view}, per 30 minutes`,
    perMinutes: 30,
    heapGrowthMb: 50,
    rssGrowthMb: build === 'dev' ? 150 : 100,
    // A dev build's CPU is read against its production figure at the same load, by hand.
    cpuPct: build === 'prod' ? VIEW_CPU_PCT[view] : undefined,
    longTaskMaxMs: 200,
    longTaskPerSecondMs: 250,
    rendersPerMin: build === 'dev' ? 5_000 : undefined,
    familyPerMin: build === 'dev' ? 500 : undefined
  }
}

export interface Verdict {
  what: string
  got: number
  limit: number
  ok: boolean
}

/** Least-squares slope of y over t, per minute. */
function slopePerMinute(points: { t: number; y: number }[]): number {
  const n = points.length
  if (n < 2) return 0
  const mt = points.reduce((s, p) => s + p.t, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - mt) * (p.y - my)
    den += (p.t - mt) ** 2
  }
  return den ? (num / den) * 60_000 : 0
}

function growth(samples: SoakSample[], read: (s: SoakSample) => number, perMinutes?: number): number {
  if (samples.length < 2) return 0
  if (perMinutes) return slopePerMinute(samples.map((s) => ({ t: s.t, y: read(s) }))) * perMinutes
  return read(samples[samples.length - 1]!) - read(samples[0]!)
}

const round = (n: number): number => Math.round(n * 10) / 10

/** Every reading against the rule; the run passes when every verdict is ok. */
export function judgeSoak(samples: SoakSample[], rule: SoakRule): { ok: boolean; verdicts: Verdict[] } {
  const verdicts: Verdict[] = []
  const check = (what: string, got: number, limit: number | undefined): void => {
    if (limit === undefined) return
    verdicts.push({ what, got: round(got), limit, ok: got <= limit })
  }
  check('heap after GC growth, MB', growth(samples, (s) => s.heapMb, rule.perMinutes), rule.heapGrowthMb)
  check('renderer RSS after GC growth, MB', growth(samples, (s) => s.rssMb, rule.perMinutes), rule.rssGrowthMb)
  // The first sample opens the window; its CPU reading covers the time before it.
  const window = samples.slice(1)
  const wall = window.reduce((s, x) => s + x.wallS, 0)
  check('renderer CPU, % of one core', wall ? (window.reduce((s, x) => s + x.cpuS, 0) / wall) * 100 : 0, rule.cpuPct)
  const tasks = window.flatMap((s) => s.longTasks)
  check('longest long task, ms', tasks.reduce((m, x) => Math.max(m, x.duration), 0), rule.longTaskMaxMs)
  const perSecond = new Map<number, number>()
  for (const task of tasks) {
    const second = Math.floor(task.start / 1000)
    perSecond.set(second, (perSecond.get(second) ?? 0) + task.duration)
  }
  check('long tasks in one second, ms', Math.max(0, ...perSecond.values()), rule.longTaskPerSecondMs)
  if (rule.rendersPerMin !== undefined || rule.familyPerMin !== undefined) {
    const minutes = wall / 60
    const renders = window.reduce((s, x) => s + (x.renders?.total ?? 0), 0)
    const family = window.reduce((s, x) => s + (x.renders?.family ?? 0), 0)
    check('changed-props re-renders a minute', minutes ? renders / minutes : 0, rule.rendersPerMin)
    check('tooltip and button re-renders a minute', minutes ? family / minutes : 0, rule.familyPerMin)
  }
  return { ok: verdicts.every((v) => v.ok), verdicts }
}

/** React's component track names its measures with a zero-width space and the component's name. */
export const REACT_MEASURE_PREFIX = '​'
/** The family the plan bounds at 500 a minute: Base UI's tooltip tree and the buttons under it. */
export const FAMILY = /^(?:Tooltip\w*|Tip|Button|HoverAction)$/
