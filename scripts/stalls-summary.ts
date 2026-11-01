import { readFileSync } from 'node:fs'

const mean = (values: number[]): number => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
const max = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), 0)
const percentile = (values: number[], q: number): number =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? 0

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => rows.reduce((width, row) => Math.max(width, row[i].length), 0))
  return rows.map((row) => row.map((cell, i) => i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join('  ').trimEnd()).join('\n')
}

export function stallsSummary(text: string): string {
  const means: number[] = [], maxima: number[] = [], depths: number[] = []
  const pushes = { meta: [] as number[], event: [] as number[] }
  const slow = new Map<string, number[]>()
  const timed = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const loop = line.match(/^\S+ loop max=([\d.]+)ms mean=([\d.]+)ms(?:\s|$)/)
    if (loop) {
      maxima.push(Number(loop[1]))
      means.push(Number(loop[2]))
      const inflight = line.match(/\binflight=(\S+)/)?.[1]
      depths.push(!inflight || inflight === '-' ? 0 : inflight.split(',').length)
      const counts = line.match(/\bpushes=meta:(\d+),event:(\d+)/)
      pushes.meta.push(Number(counts?.[1] ?? 0))
      pushes.event.push(Number(counts?.[2] ?? 0))
    }
    const request = line.match(/^\S+ slow-request (\S+) ([\d.]+)ms(?:\s|$)/)
    if (request) {
      const times = slow.get(request[1]) ?? []
      times.push(Number(request[2]))
      slow.set(request[1], times)
    }
    const section = line.match(/^\S+ timed (\S+) ([\d.]+)ms(?:\s|$)/)
    if (section) timed.set(section[1], (timed.get(section[1]) ?? 0) + 1)
  }
  const byCount = <T extends { length: number }>(a: [string, T], b: [string, T]): number =>
    b[1].length - a[1].length || a[0].localeCompare(b[0])
  return [
    'Loop samples (logged stall seconds only)',
    table([['count', 'mean of means ms', 'max of max ms'], [String(means.length), mean(means).toFixed(2), String(max(maxima))]]),
    'Slow requests (nearest-rank percentiles)',
    table([['method', 'count', 'p50 ms', 'p90 ms', 'max ms'], ...[...slow].sort(byCount).map(([method, times]) =>
      [method, String(times.length), String(percentile(times, 0.5)), String(percentile(times, 0.9)), String(max(times))])]),
    'Pushes per second (logged loop samples)',
    table([['kind', 'mean /s', 'seconds > 1000', 'max /s'], ...Object.entries(pushes).map(([kind, counts]) =>
      [kind, mean(counts).toFixed(2), String(counts.filter((count) => count > 1000).length), String(max(counts))])]),
    'In-flight depth (logged loop samples; log caps entries at 12)',
    table([['max', 'p90'], [String(max(depths)), String(percentile(depths, 0.9))]]),
    'Timed sections',
    table([['label', 'count'], ...[...timed].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => [label, String(count)])])
  ].join('\n')
}

const PHASES = ['accepted', 'prepared', 'handle', 'delivered', 'init', 'first-message', 'model', 'first-content'] as const
type Phase = (typeof PHASES)[number]
/** The gaps the --sends table reports, each from one phase to the next one reached. */
const GAPS: [string, Phase[], Phase][] = [
  ['handle', ['accepted'], 'handle'],
  ['deliver', ['handle'], 'delivered'],
  ['init', ['delivered'], 'init'],
  ['model', ['init', 'delivered'], 'model'],
  ['content', ['model', 'init', 'delivered'], 'first-content'],
  ['total', ['accepted'], 'first-content']
]
const CACHE_GAP_MIN_MS = 5 * 60_000
const CACHE_GAP_MAX_MS = 60 * 60_000

interface Span {
  at: number
  session: string
  ms: Partial<Record<Phase, number>>
  note: Partial<Record<Phase, string>>
}

function parseSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^(\S+) send session=(\S+) /)
    if (!head) continue
    const span: Span = { at: Date.parse(head[1]), session: head[2], ms: {}, note: {} }
    for (const m of line.matchAll(/\b([a-z-]+)=(-|\d+)(?:\(([^)]*)\))?/g)) {
      const phase = m[1] as Phase
      if (!PHASES.includes(phase)) continue
      if (m[2] !== '-') span.ms[phase] = Number(m[2])
      if (m[3]) span.note[phase] = m[3]
    }
    spans.push(span)
  }
  return spans
}

const kindOf = (span: Span): string => span.note.handle ?? (span.ms.handle !== undefined ? 'other' : 'none')
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(0)}%` : '-')

/**
 * The send spans (sendSpans.ts) as one table: p50 and p90 of each phase gap
 * per handle kind, the warm share of new threads, and the prompt cache's
 * miss rate overall and after a 5 to 60 minute gap on the same thread.
 */
export function sendsSummary(text: string): string {
  const spans = parseSpans(text)
  const kinds = [...new Set(spans.map(kindOf))].sort((a, b) => ['live', 'warm', 'cold'].indexOf(a) - ['live', 'warm', 'cold'].indexOf(b) || a.localeCompare(b))
  const header = ['handle', 'sends', ...GAPS.flatMap(([name]) => [`${name} p50`, `${name} p90`])]
  const rows = kinds.map((kind) => {
    const of = spans.filter((s) => kindOf(s) === kind)
    const cells = GAPS.flatMap(([, from, to]) => {
      const gaps = of.flatMap((s) => {
        const start = from.map((f) => s.ms[f]).find((v) => v !== undefined)
        const end = s.ms[to]
        return start !== undefined && end !== undefined ? [end - start] : []
      })
      return gaps.length ? [String(percentile(gaps, 0.5)), String(percentile(gaps, 0.9))] : ['-', '-']
    })
    return [kind, String(of.length), ...cells]
  })
  const warm = spans.filter((s) => s.note.handle === 'warm').length
  const cold = spans.filter((s) => s.note.handle === 'cold').length
  // The cache: a model note says hit or miss; the gap is from the thread's previous send.
  const last = new Map<string, number>()
  let noted = 0, missed = 0, gapNoted = 0, gapMissed = 0
  for (const s of [...spans].sort((a, b) => a.at - b.at)) {
    const prev = last.get(s.session)
    last.set(s.session, s.at)
    const note = s.note.model
    if (!note) continue
    const miss = note.startsWith('miss')
    noted++
    if (miss) missed++
    if (prev !== undefined && s.at - prev >= CACHE_GAP_MIN_MS && s.at - prev < CACHE_GAP_MAX_MS) {
      gapNoted++
      if (miss) gapMissed++
    }
  }
  return [
    'Send spans: ms per phase gap (nearest-rank percentiles)',
    table([header, ...rows]),
    'New threads',
    table([['warm', 'cold', 'warm share'], [String(warm), String(cold), pct(warm, warm + cold)]]),
    'Prompt cache (model note)',
    table([['sends', 'miss rate', 'after 5-60 min', 'miss rate'], [String(noted), pct(missed, noted), String(gapNoted), pct(gapMissed, gapNoted)]])
  ].join('\n')
}

if (import.meta.main) {
  const sends = process.argv.includes('--sends')
  const files = process.argv.slice(2).filter((a) => a !== '--sends')
  if (!files.length) {
    console.error('Usage: bun scripts/stalls-summary.ts [--sends] <stalls.log> [more files]')
    process.exit(1)
  }
  const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  console.log(sends ? sendsSummary(text) : stallsSummary(text))
}
