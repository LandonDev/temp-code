/**
 * The computer bench runner's pure parts (scripts/e2e-computer-bench.ts):
 * its flags, its three lanes and their task order, and what a run's thread
 * rows and the rig's host calls say about it (the calls with their host and
 * row times, think time, the tools off the route, the cards, the tokens).
 */
import type { EventRow } from '../../src/shared/events'
import { bareToolName, stepsOf, toolKind, type BenchCall, type BenchProvider } from './computerBench'

// ── flags ───────────────────────────────────────────────────────────────

export interface BenchArgs {
  mode: 'gate' | 'report-only' | 'hand' | 'reference'
  models: string[] | null
  tasks: string[] | null
  /** exactly n runs per task, no rerun rule */
  runs: number | null
  /** include the session-tier tasks; the tier admitted only while the Mac is idle */
  session: boolean
  rebaseline: boolean
  /** re-judge a saved report; runs nothing */
  judge: string | null
}

export const BENCH_USAGE =
  'usage: bun run script:e2e-computer-bench -- [--gate | --report-only | --reference codex | --judge <report.json>] [--models a,b] [--tasks a,b] [--runs n] [--session] [--rebaseline]'

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const out: BenchArgs = { mode: 'hand', models: null, tasks: null, runs: null, session: false, rebaseline: false, judge: null }
  const modes = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    const list = (): string[] => value().split(',').map((s) => s.trim()).filter(Boolean)
    if (a === '--gate') modes.add((out.mode = 'gate'))
    else if (a === '--report-only') modes.add((out.mode = 'report-only'))
    else if (a === '--reference') {
      const what = value()
      if (what !== 'codex') throw new Error(`--reference takes codex (got ${what})`)
      modes.add((out.mode = 'reference'))
    } else if (a === '--judge') out.judge = value()
    else if (a === '--models') out.models = list()
    else if (a === '--tasks') out.tasks = list()
    else if (a === '--runs') {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('--runs takes a whole number from 1 to 10')
      out.runs = n
    } else if (a === '--session') out.session = true
    else if (a === '--rebaseline') out.rebaseline = true
    else throw new Error(`unknown argument ${a}\n${BENCH_USAGE}`)
  }
  if (modes.size > 1) throw new Error(`--gate, --report-only and --reference go alone (got ${[...modes].join(', ')})`)
  const judged = out.mode === 'gate' || out.mode === 'report-only'
  if (judged && out.runs !== null) throw new Error(`--runs is for a hand run; ${out.mode === 'gate' ? '--gate' : '--report-only'} runs each task once and reruns a breach`)
  if (judged && out.session) throw new Error('--session never runs in the gate: the session tier takes the person’s Mac')
  if (out.mode === 'reference' && out.rebaseline) throw new Error('--reference never writes the baseline')
  if (out.mode === 'report-only' && out.rebaseline) throw new Error('--report-only never writes the baseline')
  return out
}

// ── lanes ───────────────────────────────────────────────────────────────

export interface BenchModel {
  model: string
  provider: BenchProvider
  effort: 'medium'
}

/** The three models, side by side, one lane each. */
export const BENCH_MODELS: readonly BenchModel[] = [
  { model: 'claude-opus-5-5', provider: 'claude', effort: 'medium' },
  { model: 'gpt-6.1-sol', provider: 'codex', effort: 'medium' },
  { model: 'muse-wonder-1.0', provider: 'muse', effort: 'medium' }
]

/** A lane's task order: the list turned by twice its index, so the lanes rarely reach a shared task at once. */
export function laneOrder<T>(tasks: readonly T[], laneIndex: number): T[] {
  if (!tasks.length) return []
  const k = (laneIndex * 2) % tasks.length
  return [...tasks.slice(k), ...tasks.slice(0, k)]
}

// ── what a run's rows say ───────────────────────────────────────────────

/** One computer call as the rig's wrapper saw it. */
export interface HostCall {
  tool: string
  args: unknown
  startedAt: number
  hostMs: number
  steps: string[]
  shots: number
  isError: boolean
}

export interface RowFacts {
  calls: BenchCall[]
  otherTools: string[]
  /** wall time less the time any tool call was open */
  thinkMs: number
  wallMs: number
  cards: { kind: string | null; title: string }[]
  tokens?: { input: number; output: number }
}

const SHOT_ACTIONS: readonly string[] = ['screenshot', 'zoom']

const askedShot = (tool: string, args: unknown): boolean => {
  const a = (args ?? {}) as { screenshot?: unknown; action?: unknown; actions?: { action?: unknown }[] }
  if (a.screenshot === true) return true
  if (SHOT_ACTIONS.includes(String(a.action)) || SHOT_ACTIONS.some((s) => bareToolName(tool) === `computer_${s}`)) return true
  return Array.isArray(a.actions) && a.actions.some((x) => SHOT_ACTIONS.includes(String(x?.action)))
}

/** Total length of the union of [start, end] spans. */
export function unionMs(spans: readonly [number, number][]): number {
  const sorted = [...spans].filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0])
  let total = 0
  let curS = -Infinity
  let curE = -Infinity
  for (const [s, e] of sorted) {
    if (s > curE) {
      if (curE > curS) total += curE - curS
      curS = s
      curE = e
    } else curE = Math.max(curE, e)
  }
  if (curE > curS) total += curE - curS
  return total
}

/**
 * A run's facts from its thread's rows between `from` and `to` (its first
 * `running` and its last settle) and the rig's host calls for the thread.
 * The rows decide the calls (a call refused before the host still counts);
 * each takes the next host call of the same tool, in order, for its host
 * time, its step lines and its shots.
 */
export function readRun(
  rows: readonly EventRow[],
  host: readonly HostCall[],
  from: number,
  to: number,
  /** the reference pass counts Codex's own `cua_repl` as the computer tool */
  isComputer: (name: string) => boolean = (name) => toolKind(name) === 'computer'
): RowFacts {
  const inWindow = rows.filter((r) => r.ts >= from && r.ts <= to)
  // A call's row may come twice (a partial preview, then the whole input): the last whole one is the call.
  const callRows = new Map<string, EventRow & { event: { type: 'tool-call' } }>()
  const resultTs = new Map<string, number>()
  for (const r of inWindow) {
    if (r.event.type === 'tool-call' && !r.event.partial && !r.event.parentCallId) callRows.set(r.event.callId, r as EventRow & { event: { type: 'tool-call' } })
    else if (r.event.type === 'tool-result' && !r.event.parentCallId && !resultTs.has(r.event.callId)) resultTs.set(r.event.callId, r.ts)
  }
  const ordered = [...callRows.values()].sort((a, b) => a.seq - b.seq)
  const unused = [...host]
  const calls: BenchCall[] = []
  const otherTools: string[] = []
  const spans: [number, number][] = []
  for (const row of ordered) {
    const { name, callId, input } = row.event
    const done = resultTs.get(callId)
    spans.push([row.ts, done ?? to])
    if (!isComputer(name)) {
      if (toolKind(name) !== 'allowed') otherTools.push(name)
      continue
    }
    const at = unused.findIndex((h) => bareToolName(h.tool) === bareToolName(name))
    const h = at >= 0 ? unused.splice(at, 1)[0] : null
    calls.push({
      tool: bareToolName(name),
      hostMs: h ? h.hostMs : null,
      rowMs: done === undefined ? null : done - row.ts,
      steps: h ? stepsOf(h.steps) : [],
      screenshotAsked: askedShot(name, input),
      shots: h?.shots ?? 0,
      isError: h?.isError ?? false
    })
  }
  const cards = inWindow.flatMap((r) =>
    r.event.type === 'approval-request'
      ? [{ kind: ((r.event.input as { confirm?: { kind?: string } } | null)?.confirm?.kind as string | undefined) ?? null, title: r.event.title ?? r.event.toolName }]
      : []
  )
  const wallMs = Math.max(0, to - from)
  return { calls, otherTools, thinkMs: Math.max(0, wallMs - unionMs(spans)), wallMs, cards, ...tokensOf(inWindow) }
}

/** The turns' own totals where the harness reports them, else the last running snapshot. */
function tokensOf(rows: readonly EventRow[]): { tokens?: { input: number; output: number } } {
  const ends = rows.flatMap((r) => (r.event.type === 'turn-complete' && (r.event.inputTokens !== undefined || r.event.outputTokens !== undefined) ? [r.event] : []))
  if (ends.length) return { tokens: { input: ends.reduce((n, e) => n + (e.inputTokens ?? 0), 0), output: ends.reduce((n, e) => n + (e.outputTokens ?? 0), 0) } }
  const last = rows.filter((r) => r.event.type === 'usage').at(-1)?.event
  return last?.type === 'usage' ? { tokens: { input: last.inputTokens ?? 0, output: last.outputTokens ?? 0 } } : {}
}
