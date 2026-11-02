/**
 * The soak's frame attribution (scripts/measure-renderer-soak.ts --trace):
 * a Chromium trace of the soak's window read into who asked for each
 * main-thread frame and what it did. Pure, so scripts/soak-trace.test.ts
 * reads hand-made traces.
 *
 * What it answers: main-thread frames a second (`ProxyMain::BeginMainFrame`)
 * and what each held (an animation-frame callback, a style update, a
 * layout, a paint, or nothing: a frame Blink asked for to tick an animation
 * it runs itself); the animation-frame and timer callbacks by function; the
 * busy time of each renderer thread (the main thread against the
 * compositor's); and every animation the trace saw start, by name and
 * target, with Chromium's compositing failure mask (0 is "runs on the
 * compositor").
 */

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'cc',
  'blink.animations',
  'disabled-by-default-blink.animations',
  'toplevel'
].join(',')

export interface TraceEvent {
  name: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  tdur?: number
  id?: string | number
  id2?: { local?: string; global?: string }
  args?: Record<string, unknown>
}

export interface Tally {
  count: number
  ms: number
}

export interface TraceSummary {
  seconds: number
  rendererPid: number
  mainTid: number
  perSecond: Record<string, number>
  /** main-thread frames by what they held; `idle` held none of the four */
  frames: { total: number; raf: number; style: number; layout: number; paint: number; idle: number }
  rafCallbacks: [string, Tally][]
  timerCallbacks: [string, Tally][]
  /** busy ms a second by renderer thread name (top-level slices' thread time) */
  threads: [string, number][]
  /** animations started inside the trace: `<name> <target>` → failure mask → count */
  animations: [string, Record<string, number>][]
}

const COUNTED = ['ProxyMain::BeginMainFrame', 'FireAnimationFrame', 'TimerFire', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'FunctionCall', 'ResizeObserverController::DeliverObservations']

/** `name file:line` for a FunctionCall slice. */
function functionOf(e: TraceEvent): string {
  const d = (e.args?.data ?? {}) as { functionName?: string; url?: string; lineNumber?: number }
  const file = d.url ? d.url.split('/').pop()!.replace(/\?.*$/, '') : ''
  return `${d.functionName || '(anonymous)'}${file ? ` ${file}:${d.lineNumber ?? '?'}` : ''}`
}

function add(map: Map<string, Tally>, key: string, ms: number): void {
  const t = map.get(key) ?? { count: 0, ms: 0 }
  t.count += 1
  t.ms += ms
  map.set(key, t)
}

const sorted = (map: Map<string, Tally>): [string, Tally][] => [...map].sort((a, b) => b[1].ms - a[1].ms).map(([k, t]) => [k, { count: t.count, ms: Math.round(t.ms * 10) / 10 }])

/** Complete slices of one thread with each one's children, outermost first. */
function nest(events: TraceEvent[]): { e: TraceEvent; kids: TraceEvent[]; top: boolean }[] {
  const xs = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts || b.dur! - a.dur!)
  const out: { e: TraceEvent; kids: TraceEvent[]; top: boolean }[] = []
  const open: { e: TraceEvent; kids: TraceEvent[]; top: boolean }[] = []
  for (const e of xs) {
    while (open.length && open[open.length - 1]!.e.ts + open[open.length - 1]!.e.dur! <= e.ts) open.pop()
    const node = { e, kids: [] as TraceEvent[], top: open.length === 0 }
    for (const o of open) o.kids.push(e)
    open.push(node)
    out.push(node)
  }
  return out
}

/** Picks the renderer whose main thread ran the most frames: the soak's window. */
export function summarizeTrace(events: readonly TraceEvent[]): TraceSummary {
  const names = new Map<string, string>()
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, String((e.args as { name?: string })?.name ?? ''))
  const frames = new Map<string, number>()
  for (const e of events) {
    if (e.name !== 'ProxyMain::BeginMainFrame' || names.get(`${e.pid}:${e.tid}`) !== 'CrRendererMain') continue
    frames.set(`${e.pid}:${e.tid}`, (frames.get(`${e.pid}:${e.tid}`) ?? 0) + 1)
  }
  const main = [...frames].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!main) throw new Error('the trace has no main-thread frame on any renderer')
  const [pid, tid] = main.split(':').map(Number) as [number, number]

  const timed = events.filter((e) => e.pid === pid && e.ts > 0 && (e.ph === 'X' || e.ph === 'B' || e.ph === 'I' || e.ph === 'i'))
  const t0 = Math.min(...timed.map((e) => e.ts))
  const t1 = Math.max(...timed.map((e) => e.ts + (e.dur ?? 0)))
  const seconds = Math.max(0.001, (t1 - t0) / 1e6)

  const mainEvents = events.filter((e) => e.pid === pid && e.tid === tid)
  const counts: Record<string, number> = {}
  for (const name of COUNTED) counts[name] = 0
  for (const e of mainEvents) if (e.ph === 'X' && e.name in counts) counts[e.name]! += 1
  const perSecond = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.round((n / seconds) * 10) / 10]))

  const tree = nest(mainEvents)
  const frameTally = { total: 0, raf: 0, style: 0, layout: 0, paint: 0, idle: 0 }
  const raf = new Map<string, Tally>()
  const timers = new Map<string, Tally>()
  for (const { e, kids } of tree) {
    if (e.name === 'ProxyMain::BeginMainFrame') {
      frameTally.total += 1
      const has = (n: string): boolean => kids.some((k) => k.name === n)
      const r = has('FireAnimationFrame')
      const s = has('UpdateLayoutTree')
      const l = has('Layout')
      const p = has('Paint')
      if (r) frameTally.raf += 1
      if (s) frameTally.style += 1
      if (l) frameTally.layout += 1
      if (p) frameTally.paint += 1
      if (!r && !s && !l && !p) frameTally.idle += 1
    }
    if (e.name === 'FireAnimationFrame' || e.name === 'TimerFire') {
      const calls = kids.filter((k) => k.name === 'FunctionCall')
      const outer = calls.filter((c) => !calls.some((o) => o !== c && o.ts <= c.ts && o.ts + o.dur! >= c.ts + c.dur!))
      const into = e.name === 'FireAnimationFrame' ? raf : timers
      if (!outer.length) add(into, '(no script)', e.dur! / 1000)
      for (const c of outer) add(into, functionOf(c), c.dur! / 1000)
    }
  }

  const busy = new Map<string, number>()
  const byThread = new Map<number, TraceEvent[]>()
  for (const e of events) if (e.pid === pid && e.ph === 'X') byThread.set(e.tid, [...(byThread.get(e.tid) ?? []), e])
  for (const [t, list] of byThread) {
    const name = names.get(`${pid}:${t}`) ?? `thread ${t}`
    let ms = 0
    for (const n of nest(list)) if (n.top) ms += (n.e.tdur ?? n.e.dur!) / 1000
    busy.set(name, (busy.get(name) ?? 0) + ms)
  }

  // The target rides the animation's begin event; the verdict a later instant of the same id.
  const animId = (e: TraceEvent): string => String(e.id2?.local ?? e.id2?.global ?? e.id ?? '')
  const targets = new Map<string, string>()
  const anims = new Map<string, Record<string, number>>()
  for (const e of events) {
    if (e.pid !== pid || e.name !== 'Animation') continue
    const d = (e.args?.data ?? {}) as { displayName?: string; name?: string; compositeFailed?: number; nodeName?: string }
    if (e.ph === 'b') targets.set(animId(e), `${d.displayName || d.name || '(web animation)'}${d.nodeName ? ` ${d.nodeName}` : ''}`)
    if (d.compositeFailed === undefined) continue
    const key = targets.get(animId(e)) ?? '(web animation)'
    const row = anims.get(key) ?? {}
    row[String(d.compositeFailed)] = (row[String(d.compositeFailed)] ?? 0) + 1
    anims.set(key, row)
  }

  return {
    seconds: Math.round(seconds * 100) / 100,
    rendererPid: pid,
    mainTid: tid,
    perSecond,
    frames: frameTally,
    rafCallbacks: sorted(raf),
    timerCallbacks: sorted(timers),
    threads: [...busy].map(([k, ms]) => [k, Math.round((ms / seconds) * 10) / 10] as [string, number]).sort((a, b) => b[1] - a[1]),
    animations: [...anims].sort((a, b) => a[0].localeCompare(b[0]))
  }
}

/** The summary as markdown lines for the soak's report. */
export function traceMarkdown(s: TraceSummary): string[] {
  const per = (n: number): string => (n / s.seconds).toFixed(1)
  return [
    `Trace: ${s.seconds} s of renderer ${s.rendererPid}.`,
    '',
    `Main-thread frames: ${per(s.frames.total)} a second; with an animation-frame callback ${per(s.frames.raf)}, a style update ${per(s.frames.style)}, a layout ${per(s.frames.layout)}, a paint ${per(s.frames.paint)}, none of these ${per(s.frames.idle)}.`,
    '',
    '| event | a second |',
    '|---|---|',
    ...Object.entries(s.perSecond).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| renderer thread | busy ms a second |',
    '|---|---|',
    ...s.threads.slice(0, 8).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '| animation-frame callback | calls | ms |',
    '|---|---|---|',
    ...s.rafCallbacks.slice(0, 15).map(([k, t]) => `| ${k} | ${t.count} | ${t.ms} |`),
    '',
    '| timer callback | calls | ms |',
    '|---|---|---|',
    ...s.timerCallbacks.slice(0, 15).map(([k, t]) => `| ${k} | ${t.count} | ${t.ms} |`),
    '',
    '| animation started (target) | compositing failure mask: count |',
    '|---|---|',
    ...s.animations.map(([k, m]) => `| ${k} | ${Object.entries(m).map(([f, n]) => `${f}: ${n}`).join(', ')} |`)
  ]
}
