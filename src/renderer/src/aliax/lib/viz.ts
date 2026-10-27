// The words and numbers the Stats page prints; colours are tokens (aliax/charts/palette.ts).

export const compact = (n: number): string => {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** An axis tick: whole numbers past ten of a unit, so ticks stay short ("150k", "2.5M"). */
export const compactTick = (n: number): string => {
  const abs = Math.abs(n)
  const unit = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'k'] : null
  if (!unit) return String(Math.round(n))
  const v = n / (unit[0] as number)
  return `${Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${unit[1]}`
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
