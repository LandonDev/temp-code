import type { PaceSeries, StatsBundle } from '@shared/aliaxStats'
import { EvilAreaChart } from '@aliax/components/evilcharts/charts/recharts-area-chart'
import { EvilBarChart } from '@aliax/components/evilcharts/charts/recharts-bar-chart'
import { EvilLineChart } from '@aliax/components/evilcharts/charts/recharts-line-chart'
import { EvilPieChart } from '@aliax/components/evilcharts/charts/recharts-pie-chart'
import { EvilRadialChart } from '@aliax/components/evilcharts/charts/recharts-radial-chart'
import { EvilSankeyChart } from '@aliax/components/evilcharts/charts/recharts-sankey-chart'
import { Tooltip, TooltipContent, TooltipTrigger } from '@aliax/components/ui/tooltip'
import {
  SEQUENTIAL,
  SERIES,
  STATUS,
  anyConfig,
  clip,
  compact,
  config,
  modelLabel,
  shortDay
} from '@aliax/lib/viz'
import { cn } from '@aliax/lib/utils'
import { Empty } from './panel'

const H = 'h-full w-full p-3'

/* ── Limits and pace ─────────────────────────────────────────────── */

/**
 * The headline. A band of what past cycles did at the same point, with the
 * cycle running now drawn over it — the two only mean anything together, so
 * they share one plot. Composed chart: areas for the band, a line for today.
 */
export function PaceChart({ series }: { series: PaceSeries }) {
  const data = series.points.map((p) => ({
    hours: Math.round(p.hours * 10) / 10,
    p25: p.p25,
    p75: p.p75,
    median: p.median,
    current: p.current
  }))
  // Drawn as lines rather than a shaded band: this library applies stacking
  // chart-wide, so a stacked fill would also stack the median and current
  // lines on top of it and misreport both.
  const cfg = config([
    { key: 'p25', label: 'Usual low', color: SERIES[0] },
    { key: 'p75', label: 'Usual high', color: SERIES[0] },
    { key: 'median', label: 'Typical', color: SERIES[0] },
    { key: 'current', label: 'This cycle', color: SERIES[1] }
  ])
  const weekly = series.periodMs > 86_400_000
  const live = data.some((d) => d.current !== null)
  return (
    <EvilLineChart data={data} config={cfg} className={H} xDataKey="hours">
      <EvilLineChart.Grid />
      <EvilLineChart.XAxis
        dataKey="hours"
        tickFormatter={(v: number) => (weekly ? `${Math.round(v / 24)}d` : `${v}h`)}
        minTickGap={24}
      />
      <EvilLineChart.YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
      <EvilLineChart.Tooltip />
      <EvilLineChart.Legend />
      <EvilLineChart.Line dataKey="p25" strokeVariant="dashed" curveType="monotone" connectNulls />
      <EvilLineChart.Line dataKey="p75" strokeVariant="dashed" curveType="monotone" connectNulls />
      <EvilLineChart.Line dataKey="median" curveType="monotone" connectNulls />
      {live && (
        <EvilLineChart.Line
          dataKey="current"
          strokeWidth={3}
          curveType="monotone"
          connectNulls
          glowing
        />
      )}
    </EvilLineChart>
  )
}

/** Ranked headroom per account — magnitude compared across few items. */
export function RunwayChart({ data }: { data: { name: string; left: number }[] }) {
  if (data.length === 0) return <Empty>No account usage recorded yet.</Empty>
  const cfg = config([{ key: 'left', label: '% left', color: STATUS.good }])
  return (
    <EvilBarChart data={data} config={cfg} className={H} xDataKey="name" layout="horizontal">
      <EvilBarChart.Grid horizontal={false} />
      <EvilBarChart.XAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
      <EvilBarChart.YAxis dataKey="name" width={168} interval={0} tickFormatter={(v: string) => clip(v, 22)} />
      <EvilBarChart.Tooltip />
      <EvilBarChart.Bar dataKey="left" variant="gradient" radius={4} />
    </EvilBarChart>
  )
}

/* ── Attribution ─────────────────────────────────────────────────── */

/** Few parts of one whole — the only job a donut does honestly. */
export function SurfaceChart({ data }: { data: { name: string; value: number }[] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = anyConfig(config(data.map((d, i) => ({ key: d.name, label: d.name, color: SERIES[i] }))))
  const shaped = data.map((d, i) => ({ ...d, fill: SERIES[i % SERIES.length] }))
  return (
    <EvilPieChart data={shaped} config={cfg} className={H} dataKey="value" nameKey="name">
      <EvilPieChart.Tooltip />
      <EvilPieChart.Pie innerRadius={52} paddingAngle={2} cornerRadius={4} />
      <EvilPieChart.Legend />
    </EvilPieChart>
  )
}

/** Ranked magnitude with long names — horizontal bars, sorted. */
export function RankedBars({
  data,
  unit = 'tokens',
  color = SERIES[0]
}: {
  data: { name: string; value: number }[]
  unit?: string
  color?: string
}) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = config([{ key: 'value', label: unit, color }])
  return (
    <EvilBarChart data={data} config={cfg} className={H} xDataKey="name" layout="horizontal">
      <EvilBarChart.Grid horizontal={false} />
      <EvilBarChart.XAxis tickFormatter={compact} />
      <EvilBarChart.YAxis dataKey="name" width={148} interval={0} tickFormatter={(v: string) => clip(v, 20)} />
      <EvilBarChart.Tooltip />
      <EvilBarChart.Bar dataKey="value" variant="gradient" radius={4} />
    </EvilBarChart>
  )
}

/** Model mix over time: composition that sums to a meaningful total. */
export function ModelMixChart({ data, models }: { data: Record<string, number | string>[]; models: string[] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = anyConfig(config(models.map((m, i) => ({ key: m, label: modelLabel(m), color: SERIES[i] }))))
  return (
    <EvilAreaChart data={data} config={cfg} className={H} xDataKey="day" stackType="stacked">
      <EvilAreaChart.Grid />
      <EvilAreaChart.XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} />
      <EvilAreaChart.YAxis tickFormatter={compact} />
      <EvilAreaChart.Tooltip />
      <EvilAreaChart.Legend />
      {models.map((m) => (
        <EvilAreaChart.Area key={m} dataKey={m} variant="solid" curveType="monotone" />
      ))}
    </EvilAreaChart>
  )
}

/** Where every token flows: surface, then model, then project. */
export function FlowChart({ data }: { data: StatsBundle['flow'] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const names: string[] = []
  const idx = (n: string): number => {
    const i = names.indexOf(n)
    return i === -1 ? names.push(n) - 1 : i
  }
  const links: { source: number; target: number; value: number }[] = []
  const add = (s: string, t: string, v: number): void => {
    const source = idx(s)
    const target = idx(t)
    const found = links.find((l) => l.source === source && l.target === target)
    if (found) found.value += v
    else links.push({ source, target, value: v })
  }
  for (const f of data) {
    add(f.surface, modelLabel(f.model), f.value)
    add(modelLabel(f.model), f.project, f.value)
  }
  const nodes = names.map((name) => ({ name }))
  return (
    <EvilSankeyChart
      data={{ nodes, links }}
      config={anyConfig(config(names.map((n, i) => ({ key: n, label: n, color: SERIES[i % SERIES.length] }))))}
      className={H}
    >
      <EvilSankeyChart.Link />
      <EvilSankeyChart.Node />
      <EvilSankeyChart.NodeLabel />
      <EvilSankeyChart.Tooltip />
    </EvilSankeyChart>
  )
}

/* ── Efficiency ──────────────────────────────────────────────────── */

/** A single rate against its ceiling — a radial gauge, not a bar. */
export function RateGauge({
  percent,
  label,
  color,
  caption
}: {
  percent: number
  label: string
  color: string
  caption?: string
}) {
  const data = [{ name: label, value: Math.max(0, Math.min(100, percent)), fill: color }]
  return (
    <div className="relative h-full w-full">
      <EvilRadialChart
        data={data}
        config={anyConfig(config([{ key: label, label, color }]))}
        className={H}
        nameKey="name"
        max={100}
        innerRadius={62}
        outerRadius={98}
      >
        <EvilRadialChart.RadialBar dataKey="value" cornerRadius={6} showBackground />
      </EvilRadialChart>
      {/* The arc shows proportion; the number is the answer. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums" style={{ color }}>
          {Math.round(percent)}%
        </span>
        {caption && <span className="pt-0.5 text-[11px] text-muted-foreground">{caption}</span>}
      </div>
    </div>
  )
}

/** Change over time of a single rate — a line, with its own axis floor. */
export function CacheTrend({ data }: { data: { day: string; hit: number }[] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = config([{ key: 'hit', label: 'Cache hit rate', color: SERIES[2] }])
  return (
    <EvilLineChart data={data} config={cfg} className={H} xDataKey="day">
      <EvilLineChart.Grid />
      <EvilLineChart.XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} />
      <EvilLineChart.YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
      <EvilLineChart.Tooltip />
      <EvilLineChart.Line dataKey="hit" strokeWidth={2} curveType="monotone" />
    </EvilLineChart>
  )
}

/** Two services, never summed and never on two y-axes: one grouped bar each. */
export function DailySpend({ data }: { data: StatsBundle['daily'] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = config([
    { key: 'claude', label: 'Claude Code', color: SERIES[0] },
    { key: 'codex', label: 'Codex', color: SERIES[1] }
  ])
  return (
    <EvilBarChart data={data} config={cfg} className={H} xDataKey="day">
      <EvilBarChart.Grid />
      <EvilBarChart.XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} />
      <EvilBarChart.YAxis tickFormatter={compact} />
      <EvilBarChart.Tooltip />
      <EvilBarChart.Legend />
      <EvilBarChart.Bar dataKey="claude" variant="duotone" radius={3} />
      <EvilBarChart.Bar dataKey="codex" variant="duotone" radius={3} />
    </EvilBarChart>
  )
}

/** Distribution over ordered buckets — a histogram is a bar chart. */
export function Histogram({
  data,
  color = SERIES[3]
}: {
  data: { bucket: string; value: number }[]
  color?: string
}) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const cfg = config([{ key: 'value', label: 'Sessions', color }])
  return (
    <EvilBarChart data={data} config={cfg} className={H} xDataKey="bucket">
      <EvilBarChart.Grid vertical={false} />
      <EvilBarChart.XAxis dataKey="bucket" />
      <EvilBarChart.YAxis tickFormatter={compact} />
      <EvilBarChart.Tooltip />
      <EvilBarChart.Bar dataKey="value" variant="hatched" radius={4} />
    </EvilBarChart>
  )
}

/** Counts over days — one series, so no legend; the title names it. */
export function DailyCount({ data, color }: { data: { day: string; value: number }[]; color: string }) {
  if (data.length === 0) return <Empty>No events recorded yet.</Empty>
  const cfg = config([{ key: 'value', label: 'Count', color }])
  return (
    <EvilBarChart data={data} config={cfg} className={H} xDataKey="day">
      <EvilBarChart.Grid vertical={false} />
      <EvilBarChart.XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} />
      <EvilBarChart.YAxis allowDecimals={false} />
      <EvilBarChart.Tooltip />
      <EvilBarChart.Bar dataKey="value" variant="default" radius={3} />
    </EvilBarChart>
  )
}

/* ── Rhythm ──────────────────────────────────────────────────────── */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOWFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Two categorical axes with a magnitude at each crossing. No chart library
 * shape fits, so it is a grid of cells on one sequential hue, each with a
 * hover tooltip like any other mark.
 */
export function Heatmap({ data }: { data: StatsBundle['heatmap'] }) {
  if (data.length === 0) return <Empty>Nothing indexed yet.</Empty>
  const max = Math.max(...data.map((d) => d.value), 1)
  const lookup = new Map(data.map((d) => [`${d.dow}:${d.hour}`, d.value]))
  const step = (v: number): string => {
    if (v <= 0) return 'transparent'
    const i = Math.min(SEQUENTIAL.length - 1, Math.floor((v / max) * SEQUENTIAL.length))
    return SEQUENTIAL[i]
  }
  const hour12 = (h: number): string =>
    h === 0 ? '12a' : h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`
  return (
    <div className="px-4 pb-4">
      <div className="flex gap-1.5">
        <div className="w-9 shrink-0" />
        {/* Labels sit in the same 24-column grid as the cells, so each one
            lines up with the hour it names instead of drifting. */}
        <div className="grid min-w-0 flex-1 grid-cols-24 gap-[3px] pb-1">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center text-[9px] leading-none text-muted-foreground">
              {h % 3 === 0 ? hour12(h) : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex w-9 shrink-0 flex-col gap-[3px]">
          {DOW.map((d) => (
            <div key={d} className="h-4 text-[10px] leading-4 text-muted-foreground">
              {d}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {DOW.map((_, dow) => (
            <div key={dow} className="grid grid-cols-24 gap-[3px]">
              {Array.from({ length: 24 }, (_, hour) => {
                const v = lookup.get(`${dow}:${hour}`) ?? 0
                return (
                  <Tooltip key={hour}>
                    <TooltipTrigger asChild>
                      <div
                        className="h-4 rounded-[3px] ring-1 ring-white/5 transition-transform hover:scale-110"
                        style={{ backgroundColor: step(v) }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      {DOWFULL[dow]} · {hour12(hour)} · {compact(v)} output tokens
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-3 text-[10px] text-muted-foreground">
        <span>0</span>
        {SEQUENTIAL.map((c) => (
          <span key={c} className="size-2.5 rounded-[2px]" style={{ backgroundColor: c }} />
        ))}
        <span>{compact(max)} tokens</span>
      </div>
    </div>
  )
}

/** Worst cache sessions: a short ranked table beats a chart at eight rows. */
export function WorstCacheTable({ rows }: { rows: StatsBundle['worstCache'] }) {
  if (rows.length === 0) return <Empty>Not enough large sessions yet.</Empty>
  return (
    <div className="px-4 pb-4">
      <div className="flex items-center gap-3 border-b border-border pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        <span className="min-w-0 flex-1">Project</span>
        <span className="shrink-0">Output</span>
        <span className="w-12 shrink-0 text-right">Cached</span>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((r) => (
          <li key={r.session} className="flex items-center gap-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.project || '—'}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground/70">
              {compact(r.output)} out
            </span>
            <span
              className={cn(
                'w-12 shrink-0 text-right font-medium tabular-nums',
                r.hit < 50 ? 'text-destructive' : r.hit < 80 ? 'text-ax-warning' : 'text-ax-success'
              )}
            >
              {r.hit ?? 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
