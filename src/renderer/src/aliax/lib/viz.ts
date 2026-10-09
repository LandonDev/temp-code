import type { ChartConfig } from '@aliax/components/evilcharts/ui/recharts-chart'

/**
 * Categorical slots, assigned in fixed order and never cycled. These exact
 * steps pass all six palette checks against this app's card surface (#2b2b2b):
 * lightness band, chroma floor, colour-vision separation, normal-vision floor
 * and contrast. Do not substitute brighter hues without re-validating.
 */
export const SERIES = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#9085e9',
  '#c98500',
  '#d55181'
] as const

/** Magnitude, not identity: one hue, light to dark. */
export const SEQUENTIAL = [
  '#0d366b',
  '#184f95',
  '#1c5cab',
  '#256abf',
  '#2a78d6',
  '#3987e5',
  '#5598e7',
  '#6da7ec'
] as const

/** Reserved for state; never used as a series colour. */
export const STATUS = {
  good: '#199e70',
  warning: '#c98500',
  serious: '#d95926',
  critical: '#e34948'
} as const

/**
 * Build an EvilCharts config, taking colours in fixed slot order.
 *
 * The return type keeps each entry's literal key so the charts' own
 * config-vs-data key check still applies; a dynamic `string[]` of series
 * necessarily widens to a plain ChartConfig.
 */
export function config<const E extends readonly { key: string; label: string; color?: string }[]>(
  entries: E
): { [K in E[number]['key']]: { label: string; colors: { light: string[]; dark: string[] } } } {
  const out: Record<string, { label: string; colors: { light: string[]; dark: string[] } }> = {}
  entries.forEach((e, i) => {
    const c = e.color ?? SERIES[i % SERIES.length]
    out[e.key] = { label: e.label, colors: { light: [c], dark: [c] } }
  })
  return out as never
}

/** Widen a config for charts whose series come from data rather than literals. */
export const anyConfig = (c: unknown): ChartConfig => c as ChartConfig

export const compact = (n: number): string => {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Day labels are built from a local-midnight date, so they never slip a day. */
export const shortDay = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** Local clock time, e.g. "5:30 PM". */
export const localTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Local date and time, e.g. "Fri 5:30 PM". */
export const localDayTime = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** The viewer's timezone, named once so every clock label is unambiguous. */
export const TIMEZONE =
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value ?? 'local'

/** Keep an axis label readable without dropping the row it belongs to. */
export const clip = (s: string, max = 18): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s

/** Trim a model id to something readable on an axis. */
export const modelLabel = (m: string): string =>
  m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '')
