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

if (import.meta.main) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('Usage: bun scripts/stalls-summary.ts <stalls.log> [more files]')
    process.exit(1)
  }
  console.log(stallsSummary(files.map((file) => readFileSync(file, 'utf8')).join('\n')))
}
