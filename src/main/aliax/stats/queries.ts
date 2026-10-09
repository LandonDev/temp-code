import type { StatsBundle, PaceSeries } from '@shared/aliaxStats'
import { open } from './store'

const DAY = 86_400_000
const rows = <T>(sql: string, ...args: (string | number | null)[]): T[] =>
  open().prepare(sql).all(...args) as T[]

/** Milliseconds a window label covers, used to place a sample inside its cycle. */
const periodOf = (label: string): number => {
  if (label === 'week') return 7 * DAY
  const h = label.match(/^(\d+)h$/)
  return h ? Number(h[1]) * 3_600_000 : 5 * 3_600_000
}

/**
 * Burn curves, normalised so cycles can be compared.
 *
 * Cycle boundaries are detected from the data, not from the reset timestamp:
 * these windows roll, so `resets_at` drifts with every sample and grouping by
 * it invents thousands of one-sample "cycles". A refill is instead a sizeable
 * DROP in used percent (or a gap longer than the window). Within a cycle each
 * sample sits at its elapsed fraction, so cycles of any wall-clock start line
 * up on one axis.
 */
function pace(service: string, label: string, buckets = 24): PaceSeries | null {
  const period = periodOf(label)
  const since = Date.now() - 120 * DAY
  const bucket = Math.max(60_000, Math.round(period / 120))
  const samples = rows<{ ts: number; used_percent: number }>(
    `SELECT MIN(ts) ts, MAX(used_percent) used_percent FROM usage_samples
     WHERE service = ? AND label = ? AND ts > ?
     GROUP BY ts / ${bucket} ORDER BY ts`,
    service,
    label,
    since
  )
  if (samples.length < 40) return null

  const cycles: { start: number; points: { frac: number; pct: number }[] }[] = []
  let cur: { start: number; points: { frac: number; pct: number }[] } | null = null
  let prevPct = -1
  let prevTs = 0
  for (const s of samples) {
    const refilled = prevPct >= 0 && s.used_percent < prevPct - 12
    const stale = prevTs > 0 && s.ts - prevTs > period
    if (!cur || refilled || stale) {
      cur = { start: s.ts, points: [] }
      cycles.push(cur)
    }
    const frac = (s.ts - cur.start) / period
    if (frac >= 0 && frac <= 1) cur.points.push({ frac, pct: s.used_percent })
    prevPct = s.used_percent
    prevTs = s.ts
  }

  // A cycle only informs the band if it actually covers some of the window.
  const usable = cycles.filter((c) => c.points.length >= 4 && Math.max(...c.points.map((p) => p.frac)) > 0.25)
  if (usable.length < 4) return null

  const last = cycles[cycles.length - 1]
  const isLive = Date.now() - samples[samples.length - 1].ts < 6 * 3_600_000
  const current = isLive ? last : null
  const history = usable.filter((c) => c !== current)

  const at = (points: { frac: number; pct: number }[], f: number): number | null => {
    let best: { frac: number; pct: number } | null = null
    for (const p of points) if (p.frac <= f && (!best || p.frac > best.frac)) best = p
    return best ? best.pct : null
  }
  const quantile = (xs: number[], q: number): number => {
    const srt = [...xs].sort((a, b) => a - b)
    return srt[Math.min(srt.length - 1, Math.floor(q * srt.length))]
  }

  const points: PaceSeries['points'] = []
  for (let i = 0; i <= buckets; i++) {
    const f = i / buckets
    const past = history.map((c) => at(c.points, f)).filter((v): v is number => v !== null)
    points.push({
      frac: f,
      hours: (f * period) / 3_600_000,
      p25: past.length >= 3 ? Math.round(quantile(past, 0.25)) : null,
      median: past.length >= 3 ? Math.round(quantile(past, 0.5)) : null,
      p75: past.length >= 3 ? Math.round(quantile(past, 0.75)) : null,
      current: current ? at(current.points, f) : null
    })
  }

  const nowFrac = current ? Math.max(...current.points.map((p) => p.frac), 0) : 0
  const nowPct = current ? (at(current.points, nowFrac) ?? 0) : 0
  const normal = points.find((p) => p.frac >= nowFrac)?.median ?? null
  // Straight-line projection from the burn so far. Honest and legible; a fancier
  // fit would imply precision this data does not carry.
  const projected = current && nowFrac > 0.05 ? Math.min(400, Math.round(nowPct / nowFrac)) : null

  return {
    service,
    label,
    cycles: history.length,
    nowFrac,
    nowPercent: Math.round(nowPct),
    normalPercent: normal,
    projectedPercent: projected,
    exhaustsAtFrac: projected && projected > 100 && nowPct > 0 ? Math.min(1, nowFrac * (100 / nowPct)) : null,
    periodMs: period,
    points
  }
}

let cached: { at: number; value: StatsBundle } | null = null
const CACHE_MS = 60_000

export function invalidate(): void {
  cached = null
}

export function bundle(): StatsBundle {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = computeBundle()
  cached = { at: Date.now(), value }
  return value
}

function computeBundle(): StatsBundle {
  const since30 = Date.now() - 30 * DAY

  const totals = rows<{
    turns: number
    input: number
    output: number
    cache_read: number
    cache_write: number
    eph_1h: number
    eph_5m: number
  }>(
    `SELECT COUNT(*) turns, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read,
            SUM(cache_write) cache_write, SUM(eph_1h) eph_1h, SUM(eph_5m) eph_5m
     FROM turns WHERE ts > ?`,
    since30
  )[0]

  const bySurface = rows<{ name: string; value: number }>(
    `SELECT COALESCE(surface,'unknown') name, SUM(output + input) value FROM turns
     WHERE service='claude-code' AND ts > ? GROUP BY name ORDER BY value DESC`,
    since30
  )

  const byModel = rows<{ name: string; value: number; turns: number }>(
    `SELECT COALESCE(model,'unknown') name, SUM(output) value, COUNT(*) turns FROM turns
     WHERE ts > ? AND model IS NOT NULL GROUP BY name ORDER BY value DESC LIMIT 8`,
    since30
  )

  const byProject = rows<{ name: string; value: number; turns: number }>(
    `SELECT project name, SUM(output) value, COUNT(*) turns FROM turns
     WHERE ts > ? AND project != '' GROUP BY name ORDER BY value DESC LIMIT 10`,
    since30
  )

  const byBranch = rows<{ name: string; value: number }>(
    `SELECT branch name, SUM(output) value FROM turns
     WHERE ts > ? AND branch IS NOT NULL AND branch != '' GROUP BY name ORDER BY value DESC LIMIT 8`,
    since30
  )

  const byTool = rows<{ name: string; value: number; kind: string }>(
    `SELECT name, COUNT(*) value, kind FROM tool_calls WHERE ts > ? GROUP BY name, kind
     ORDER BY value DESC LIMIT 12`,
    since30
  )

  const byEffort = rows<{ name: string; value: number }>(
    `SELECT COALESCE(effort,'default') name, COUNT(*) value FROM turns
     WHERE ts > ? GROUP BY name ORDER BY value DESC`,
    since30
  )

  const stopReasons = rows<{ name: string; value: number }>(
    `SELECT COALESCE(stop_reason,'none') name, COUNT(*) value FROM turns
     WHERE ts > ? AND service='claude-code' GROUP BY name ORDER BY value DESC`,
    since30
  )

  // Daily spend, split by service so the two are comparable but never summed.
  const daily = rows<{ day: string; claude: number; codex: number }>(
    `SELECT date(ts/1000,'unixepoch','localtime') day,
            SUM(CASE WHEN service='claude-code' THEN output ELSE 0 END) claude,
            SUM(CASE WHEN service='codex' THEN output ELSE 0 END) codex
     FROM turns WHERE ts > ? GROUP BY day ORDER BY day`,
    since30
  )

  // Cache health per day: the share of input tokens served from cache.
  const cacheDaily = rows<{ day: string; hit: number }>(
    `SELECT date(ts/1000,'unixepoch','localtime') day,
            ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(cache_read + input + cache_write),0), 1) hit
     FROM turns WHERE ts > ? GROUP BY day ORDER BY day`,
    since30
  )

  const worstCache = rows<{ session: string; project: string; hit: number; output: number }>(
    `SELECT session, project,
            ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(cache_read + input + cache_write),0), 1) hit,
            SUM(output) output
     FROM turns WHERE ts > ? AND service='claude-code' GROUP BY session
     HAVING SUM(output) > 20000 ORDER BY hit ASC LIMIT 8`,
    since30
  )

  // When work happens: weekday (0=Sun) x hour, by output tokens.
  const heatmap = rows<{ dow: number; hour: number; value: number }>(
    `SELECT CAST(strftime('%w', ts/1000,'unixepoch','localtime') AS INTEGER) dow,
            CAST(strftime('%H', ts/1000,'unixepoch','localtime') AS INTEGER) hour,
            SUM(output) value
     FROM turns WHERE ts > ? GROUP BY dow, hour`,
    Date.now() - 60 * DAY
  )

  const sessionLengths = rows<{ bucket: string; value: number }>(
    `SELECT CASE
       WHEN mins < 5 THEN '<5m' WHEN mins < 15 THEN '5-15m' WHEN mins < 30 THEN '15-30m'
       WHEN mins < 60 THEN '30-60m' WHEN mins < 120 THEN '1-2h' ELSE '2h+' END bucket,
       COUNT(*) value,
       CASE WHEN mins < 5 THEN 1 WHEN mins < 15 THEN 2 WHEN mins < 30 THEN 3
            WHEN mins < 60 THEN 4 WHEN mins < 120 THEN 5 ELSE 6 END ord
     FROM (SELECT session, (MAX(ts)-MIN(ts))/60000.0 mins FROM turns
           WHERE ts > ? AND session IS NOT NULL GROUP BY session)
     GROUP BY bucket ORDER BY ord`,
    since30
  )

  const events = rows<{ kind: string; value: number }>(
    `SELECT kind, COUNT(*) value FROM session_events WHERE ts > ? GROUP BY kind`,
    since30
  )

  const switchesDaily = rows<{ day: string; value: number }>(
    `SELECT date(ts/1000,'unixepoch','localtime') day, COUNT(*) value FROM app_events
     WHERE ts > ? AND kind='switch' GROUP BY day ORDER BY day`,
    since30
  )

  const utilisation = rows<{ account: string; label: string; peak: number; avg: number }>(
    `SELECT COALESCE(account,'unknown') account, label, ROUND(MAX(used_percent)) peak,
            ROUND(AVG(used_percent)) avg
     FROM usage_samples WHERE ts > ? GROUP BY account, label ORDER BY peak DESC`,
    since30
  )

  const modelDaily = rows<{ day: string; model: string; value: number }>(
    `SELECT date(ts/1000,'unixepoch','localtime') day, model, SUM(output) value
     FROM turns WHERE ts > ? AND model IS NOT NULL GROUP BY day, model ORDER BY day`,
    since30
  )

  // Sankey: surface -> model -> project, the whole flow of where tokens go.
  const flow = rows<{ surface: string; model: string; project: string; value: number }>(
    `SELECT COALESCE(surface,'unknown') surface, COALESCE(model,'unknown') model,
            CASE WHEN project = '' THEN 'other' ELSE project END project, SUM(output) value
     FROM turns WHERE ts > ? AND service='claude-code' AND output > 0
     GROUP BY surface, model, project ORDER BY value DESC LIMIT 60`,
    since30
  )

  return {
    generatedAt: Date.now(),
    totals: totals ?? {
      turns: 0,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      eph_1h: 0,
      eph_5m: 0
    },
    pace: [pace('codex', '5h'), pace('codex', 'week')].filter((p): p is PaceSeries => p !== null),
    bySurface,
    byModel,
    byProject,
    byBranch,
    byTool,
    byEffort,
    stopReasons,
    daily,
    cacheDaily,
    worstCache,
    heatmap,
    sessionLengths,
    events,
    switchesDaily,
    utilisation,
    modelDaily,
    flow
  }
}
