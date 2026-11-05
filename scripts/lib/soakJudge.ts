/**
 * The pure parts of scripts/measure-renderer-soak.ts: its arguments and the
 * pass rule it judges recorded samples by (scripts/soak-judge.test.ts).
 *
 * Two rules. The gate's (`--gate`, the release gate's two renderer-soak
 * steps, one per scene): across a 50 s window, heap after GC grows at most
 * 6 MB, renderer RSS after GC at most 30 MB, no long task passes 200 ms,
 * long tasks take at most 250 ms of any second, and the renderer's CPU stays
 * under its scene's bound (GATE_CPU_PCT): the master's board beside a
 * streaming child (`--scene board`) and one plain chat streaming (`--scene
 * chat`). Each bound is the scene's figure on the Mac at a 144 Hz screen
 * plus a margin, a guard against regression, not a target (docs/release-gate.md
 * "The renderer soak"); `--cpu-report-only` reads CPU without failing, for
 * a hand run.
 * A hand run's (the targets of the Performance 1 plan): growth read as the
 * slope over the run and stated per 30 minutes, heap within +50 MB and RSS
 * within +100 MB (+150 MB on a dev build), CPU within the view's figure on
 * a production build, and on a dev build at most 5,000 component re-renders
 * with changed props a minute, 500 of them in the tooltip and button family.
 * The typing scene's (`--scene typing`, TYPING_RULE, with or without
 * `--gate`): a keystroke reaches its frame within 16 ms at p95 with the
 * load paused and 33 ms under it, paced or fast, every phase's text is
 * exact, and no long task passes 100 ms while typing paced or fast; CPU
 * and memory are reported, not judged.
 * The bounds are never raised to make a run pass.
 */
import type { PhaseSummary, TypingPhaseName } from './soakTyping'
import type { SwitchSummary } from './soakSwitch'

export type SoakHostKind = 'synthetic' | 'box'
export type SoakBuild = 'prod' | 'dev'
export type SoakView = 'board' | 'stream' | 'split'
export type SoakScene = 'board' | 'chat' | 'typing' | 'switch' | 'send' | 'scenarios'

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
  /** the synthetic host's scene: the master's batch, or one plain chat (shown as a stream) */
  scene: SoakScene
  /** --cpu-report-only: the gate's CPU bound is read and shown, never failed (a hand run) */
  cpuReportOnly: boolean
  /** --trace <s>: after the window, a trace that long read into who asks for each frame (scripts/lib/soakTrace.ts) */
  traceS: number
  /** --eval <js>: an experiment run in the page once the view is open, before the warm-up */
  evalJs: string | null
  /** --burst <ms>: the chat scene's deltas leave in bursts about this far apart (soakLoad.ts BurstCadence) */
  burstMs: number | null
  /** --reveal-report: the streaming reveal's steps over the window (scripts/lib/revealReport.ts) */
  revealReport: boolean
  /** --screencast <dir>: every frame the window paints while the scenarios play, as <ms>.png with an index.json */
  screencast: string | null
  /** --reduced-motion: the page under prefers-reduced-motion: reduce */
  reducedMotion: boolean
  /** --scrolled-up: the scenarios play with the reader scrolled up into the history */
  scrolledUp: boolean
  /** --height-report: the scenarios' tool tables and code blocks watched for a height jump (scripts/lib/heightReport.ts) */
  heightReport: boolean
  /** --scene switch: the clicks, alternating between the two workspaces --workspaces names (the box's temp-code and CosmicClient by default) */
  clicks: number
  workspaces: [string, string]
  /** --scene send: the master's history in rows, and the messages sent into it */
  history: number
  sends: number
  /** --load-all: the window pages the whole history in before the first send */
  loadAll: boolean
  /** --peer-delay <ms>: the synthetic host holds every request the window makes this long (TEMP_CODE_PEER_DELAY_MS), as a far host would */
  peerDelayMs: number
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
  const scene = (flag('--scene') ?? 'board') as SoakScene
  if (!['board', 'chat', 'typing', 'switch', 'send', 'scenarios'].includes(scene)) throw new Error('--scene is board, chat, typing, switch, send or scenarios')
  // The send scene sends: never into the box's own threads.
  if ((scene === 'chat' || scene === 'scenarios' || scene === 'send') && host !== 'synthetic') throw new Error(`--scene ${scene} is a synthetic host`)
  if (scene === 'scenarios' && gate) throw new Error('--scene scenarios is a recording, never the gate')
  const view = (flag('--view') ?? (scene === 'board' ? (gate ? 'split' : 'board') : scene === 'typing' || scene === 'switch' || scene === 'send' ? 'board' : 'stream')) as SoakView
  if (scene === 'typing' && view !== 'board') throw new Error("--scene typing types into the master's composer beside its board: its view is board")
  if ((scene === 'chat' || scene === 'scenarios') && view !== 'stream') throw new Error(`--scene ${scene} has one thread: its view is stream`)
  if ((scene === 'typing' || scene === 'switch' || scene === 'send') && (argv.includes('--minutes') || argv.includes('--every'))) throw new Error(`--scene ${scene} runs its own steps, not a window: drop --minutes and --every`)
  if (scene === 'switch' && argv.includes('--view')) throw new Error('--scene switch clicks the rail: it opens no view of its own')
  if (scene !== 'switch' && (argv.includes('--clicks') || argv.includes('--workspaces'))) throw new Error('--clicks and --workspaces belong to --scene switch')
  const clicks = Number(flag('--clicks') ?? (gate ? '12' : '20'))
  if (!Number.isInteger(clicks) || clicks < 2) throw new Error('--clicks takes a whole number, at least 2')
  const named = (flag('--workspaces') ?? (host === 'box' ? 'temp-code,CosmicClient' : 'soak,client')).split(',').map((w) => w.trim())
  if (named.length !== 2 || !named.every(Boolean)) throw new Error('--workspaces takes two names: a,b')
  const workspaces = named as [string, string]
  if (scene !== 'send' && (argv.includes('--history') || argv.includes('--sends') || argv.includes('--load-all'))) throw new Error('--history, --sends and --load-all belong to --scene send')
  const history = Number(flag('--history') ?? '5000')
  const sends = Number(flag('--sends') ?? (gate ? '10' : '16'))
  if (!Number.isInteger(history) || history < 0) throw new Error('--history takes a row count')
  if (!Number.isInteger(sends) || sends < 1) throw new Error('--sends takes a whole number')
  const peerDelayMs = Number(flag('--peer-delay') ?? '0')
  if (!(peerDelayMs >= 0 && peerDelayMs <= 5_000)) throw new Error('--peer-delay takes ms, 0 to 5000')
  if (peerDelayMs && (host !== 'synthetic' || gate)) throw new Error('--peer-delay slows the synthetic host on a hand run')
  if ((scene === 'typing' || scene === 'switch' || scene === 'send') && argv.includes('--cpu-report-only')) throw new Error(`--scene ${scene} reports CPU and never judges it: drop --cpu-report-only`)
  const screencast = flag('--screencast') ?? null
  const scrolledUp = argv.includes('--scrolled-up')
  if (scrolledUp && scene !== 'scenarios') throw new Error('--scrolled-up belongs to --scene scenarios')
  const heightReport = argv.includes('--height-report')
  if (heightReport && scene !== 'scenarios') throw new Error('--height-report belongs to --scene scenarios')
  if (screencast && gate) throw new Error('--screencast is for a hand run, never the gate')
  if (!['synthetic', 'box'].includes(host)) throw new Error('--host is synthetic or box')
  if (!['prod', 'dev'].includes(build)) throw new Error('--build is prod or dev')
  if (!['board', 'stream', 'split'].includes(view)) throw new Error('--view is board, stream or split')
  if (gate && host !== 'synthetic') throw new Error('--gate runs on the synthetic host only: the box is never in the release gate')
  if (gate && build !== 'prod') throw new Error('--gate measures the production build only')
  if (argv.includes('--cpu-fails')) throw new Error('--cpu-fails is gone: the gate fails on CPU by default (--cpu-report-only reads it without failing)')
  if (!gate && argv.includes('--cpu-report-only')) throw new Error('--cpu-report-only belongs to --gate')
  if (gate && (argv.includes('--minutes') || argv.includes('--every'))) throw new Error('--gate has its own timing (a 50 s window); drop --minutes and --every')
  const minutes = gate ? GATE_TIMING.windowMs / 60_000 : Number(flag('--minutes') ?? '10')
  const every = gate ? GATE_TIMING.everyS : Number(flag('--every') ?? '60')
  if (!(minutes > 0)) throw new Error('--minutes takes a positive number')
  if (!(every >= 1)) throw new Error('--every takes seconds, at least 1')
  if (every > minutes * 60) throw new Error('--every is longer than the run')
  const label = flag('--label') ?? (gate ? (scene === 'board' ? 'gate' : `gate-${scene}`) : `${host}-${build}-${scene === 'board' ? view : scene}`)
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('--label takes letters, digits and dashes')
  const traceS = Number(flag('--trace') ?? '0')
  if (!(traceS >= 0 && traceS <= 30)) throw new Error('--trace takes seconds, 0 to 30')
  const burst = flag('--burst')
  const burstMs = burst === undefined ? null : Number(burst)
  if (burstMs !== null && !(burstMs >= 10 && burstMs <= 5000)) throw new Error('--burst takes ms between bursts, 10 to 5000')
  if (burstMs !== null && scene !== 'chat') throw new Error('--burst shapes the chat scene\'s stream: add --scene chat')
  if (burstMs !== null && gate) throw new Error('--burst is a hand run, never the gate\'s load')
  if (traceS && screencast) throw new Error('--trace and --screencast run separately: ending a trace stops the screencast')
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
    profile: !gate && !argv.includes('--no-profile'),
    scene,
    cpuReportOnly: argv.includes('--cpu-report-only'),
    traceS,
    evalJs: flag('--eval') ?? null,
    burstMs,
    revealReport: argv.includes('--reveal-report'),
    screencast,
    reducedMotion: argv.includes('--reduced-motion'),
    scrolledUp,
    heightReport,
    clicks,
    workspaces,
    history,
    sends,
    loadAll: argv.includes('--load-all'),
    peerDelayMs
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
  /** The CPU verdict is shown against its limit but never fails the run. */
  cpuReportOnly?: boolean
  longTaskMaxMs: number
  longTaskPerSecondMs: number
  rendersPerMin?: number
  familyPerMin?: number
}

/**
 * Each scene's CPU bound, % of one core: its highest figure on the Mac (M4
 * Max, 144 Hz) plus a margin. The same code reads up to 1.4 times higher on
 * a quiet Mac than on a busy one (the board 29% against 20-22%). The board:
 * one compositor animation per streamed phrase asks for about 57 more
 * main-thread frames a second, and Blink samples every turning spinner on
 * each of them. The chat reads 15% on a busy Mac, about 21% quiet by the
 * board's ratio (docs/box.md "The soak's two scenes"). Never raised to make
 * a run pass.
 */
/** The scenes the gate judges by its window's rule; `typing` has TYPING_RULE, `switch` SWITCH_RULE, and `scenarios` is a recording, judged by eye. */
export type GateScene = Exclude<SoakScene, 'scenarios' | 'typing' | 'switch' | 'send'>

export const GATE_CPU_PCT: Record<GateScene, number> = { board: 33, chat: 22 }

export const GATE_RULE: SoakRule = {
  name: 'gate',
  heapGrowthMb: 6,
  rssGrowthMb: 30,
  cpuPct: GATE_CPU_PCT.board,
  longTaskMaxMs: 200,
  longTaskPerSecondMs: 250
}

/** The gate's rule for a scene; `reportOnly` (`--cpu-report-only`) shows the CPU bound without failing on it. */
export function gateRule(scene: GateScene, reportOnly = false): SoakRule {
  return { ...GATE_RULE, name: `gate ${scene}`, cpuPct: GATE_CPU_PCT[scene], ...(reportOnly ? { cpuReportOnly: true } : {}) }
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
  /** Shown against its limit; the run passes whatever it reads. */
  reportOnly?: boolean
}

/**
 * The typing scene's bounds (Performance 3's targets, judged on the Mac at
 * 144 Hz; on the box under xvfb at 60 Hz the wait for the next frame alone
 * can reach 16 ms, so its idle figure is read, not trusted): keystroke to
 * frame at p95 per paced or fast phase, the longest task while typing in
 * them, and the text of every phase exact. The burst's latency is the
 * queue's and the paste has no keystrokes: only their text is judged.
 */
export const TYPING_RULE: { name: string; p95Ms: Partial<Record<TypingPhaseName, number>>; longTaskMaxMs: number; longTaskPhases: TypingPhaseName[] } = {
  name: 'typing',
  p95Ms: { idle: 16, busy: 33, fast: 33 },
  longTaskMaxMs: 100,
  longTaskPhases: ['idle', 'busy', 'fast']
}

/**
 * The switch scene's bound (the user's target, on the box): a click on a
 * workspace reaches the first frame of its column and strip within 100 ms at
 * p95, and every click gets there. The pane's rows are reported, not judged.
 */
export const SWITCH_RULE = { name: 'switch', readyP95Ms: 100 }

export function judgeSwitch(summary: SwitchSummary, rule = SWITCH_RULE): { ok: boolean; verdicts: Verdict[] } {
  const got = summary.ready.p95 ?? Number.POSITIVE_INFINITY
  const verdicts: Verdict[] = [
    { what: 'click to column and strip p95, ms', got, limit: rule.readyP95Ms, ok: got <= rule.readyP95Ms },
    { what: 'clicks that never showed their workspace', got: summary.missed, limit: 0, ok: summary.missed === 0 }
  ]
  return { ok: verdicts.every((v) => v.ok), verdicts }
}

/**
 * The send scene's bound (the user's target, on the box): Send to the
 * person's row painted within 50 ms at p95 on a thread of 5,000 rows, every
 * send's row painted, and the host's answer off the paint's path (reported).
 */
export const SEND_RULE = { name: 'send', rowP95Ms: 50 }

export function judgeSend(summary: { row: { p95: number | null }; missed: number }, rule = SEND_RULE): { ok: boolean; verdicts: Verdict[] } {
  const got = summary.row.p95 ?? Number.POSITIVE_INFINITY
  const verdicts: Verdict[] = [
    { what: "send to the person's row p95, ms", got, limit: rule.rowP95Ms, ok: got <= rule.rowP95Ms },
    { what: 'sends whose row never painted', got: summary.missed, limit: 0, ok: summary.missed === 0 }
  ]
  return { ok: verdicts.every((v) => v.ok), verdicts }
}

/** Every phase against TYPING_RULE; a phase the run skipped (idle against the box) is not judged. */
export function judgeTyping(phases: readonly PhaseSummary[], rule = TYPING_RULE): { ok: boolean; verdicts: Verdict[] } {
  const verdicts: Verdict[] = []
  for (const p of phases) {
    const p95 = rule.p95Ms[p.phase]
    if (p95 !== undefined) {
      const got = p.frame.p95 ?? Number.POSITIVE_INFINITY
      verdicts.push({ what: `${p.phase}: keystroke to frame p95, ms`, got, limit: p95, ok: got <= p95 })
    }
    if (rule.longTaskPhases.includes(p.phase)) {
      verdicts.push({ what: `${p.phase}: longest long task, ms`, got: p.longTasks.maxMs, limit: rule.longTaskMaxMs, ok: p.longTasks.maxMs <= rule.longTaskMaxMs })
    }
    // The text check: 0 when exact, else the count of characters past the first difference.
    const off = p.text.ok ? 0 : Math.max(p.text.expected, p.text.actual) - (p.text.firstDifference ?? 0)
    verdicts.push({ what: `${p.phase}: characters wrong or missing`, got: off, limit: 0, ok: p.text.ok })
  }
  return { ok: verdicts.every((v) => v.ok), verdicts }
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
  const check = (what: string, got: number, limit: number | undefined, reportOnly = false): void => {
    if (limit === undefined) return
    verdicts.push({ what, got: round(got), limit, ok: got <= limit, ...(reportOnly ? { reportOnly } : {}) })
  }
  check('heap after GC growth, MB', growth(samples, (s) => s.heapMb, rule.perMinutes), rule.heapGrowthMb)
  check('renderer RSS after GC growth, MB', growth(samples, (s) => s.rssMb, rule.perMinutes), rule.rssGrowthMb)
  // The first sample opens the window; its CPU reading covers the time before it.
  const window = samples.slice(1)
  const wall = window.reduce((s, x) => s + x.wallS, 0)
  check('renderer CPU, % of one core', wall ? (window.reduce((s, x) => s + x.cpuS, 0) / wall) * 100 : 0, rule.cpuPct, rule.cpuReportOnly)
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
  return { ok: verdicts.every((v) => v.ok || v.reportOnly), verdicts }
}

/** React's component track names its measures with a zero-width space and the component's name. */
export const REACT_MEASURE_PREFIX = '​'
/** The family the plan bounds at 500 a minute: Base UI's tooltip tree and the buttons under it. */
export const FAMILY = /^(?:Tooltip\w*|Tip|Button|HoverAction)$/

/** What out/bundle-map.json says it was built from (electron.vite.config.ts buildHead). */
export type BuildStamp = { sha: string | null; clean: boolean } | null

/** True when out/ is HEAD's own build: stamped with HEAD's commit from a clean tree, and the tree still clean. */
export function buildIsCurrent(stamp: BuildStamp, head: string, treeClean: boolean): boolean {
  return !!stamp && stamp.clean && stamp.sha === head && treeClean
}
