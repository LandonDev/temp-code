import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChartNoAxesColumn, RefreshCw } from 'lucide-react'
import type { ServiceId, ServiceView, UsageReport } from 'aliax-core/shared/types'
import type { StatsBundle, StatsStatus } from '@shared/aliaxStats'
import { Loader } from '@aliax/components/motion/loader'
import { IconTile } from '@aliax/components/reui/icon-tile'
import { Button } from '@aliax/components/ui/button'
import { SERIES, STATUS, TIMEZONE, compact, localDayTime, modelLabel } from '@aliax/lib/viz'
import { percentLeft, useNow } from '@aliax/lib/accounts'
import {
  CacheTrend,
  DailyCount,
  DailySpend,
  FlowChart,
  Heatmap,
  Histogram,
  ModelMixChart,
  PaceChart,
  RankedBars,
  RateGauge,
  RunwayChart,
  SurfaceChart,
  WorstCacheTable
} from './stats/charts'
import { Empty, Panel, Stat } from './stats/panel'
import { Subscriptions } from './stats/subscriptions'

const hoursLeft = (p: { nowFrac: number; periodMs: number }): number =>
  Math.max(0, ((1 - p.nowFrac) * p.periodMs) / 3_600_000)

const fmtLeft = (h: number): string =>
  h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} hours` : 'under an hour'

const PROVIDER: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' }

const windowName = (label: string): string =>
  label === 'week' ? 'weekly limit' : `${label.replace('h', '-hour')} limit`

export function StatsView({
  usage,
  services
}: {
  usage: Partial<Record<ServiceId, UsageReport[]>>
  services: ServiceView[]
}) {
  const fullViews = services
  const [data, setData] = useState<StatsBundle | null>(null)
  const [status, setStatus] = useState<StatsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow(60_000)

  const load = useCallback(async () => {
    const [b, s] = await Promise.all([window.aliax.stats(), window.aliax.statsStatus()])
    setData(b)
    setStatus(s)
  }, [])

  useEffect(() => {
    load()
    // The first index pass walks thousands of files; poll until it settles.
    const t = setInterval(async () => {
      const s = await window.aliax.statsStatus()
      setStatus(s)
      if (!s.indexing) {
        setData(await window.aliax.stats())
        clearInterval(t)
      }
    }, 2500)
    return () => clearInterval(t)
  }, [load])

  const reindex = async () => {
    setBusy(true)
    await window.aliax.statsReindex()
    await load()
    setBusy(false)
  }

  /** Runway per account, from live usage: the scarcest window is the real limit. */
  const runway = useMemo(() => {
    const out: { name: string; left: number }[] = []
    for (const s of services) {
      for (const r of usage[s.id] ?? []) {
        if (r.windows.length === 0) continue
        const worst = Math.min(...r.windows.map(percentLeft))
        const p = s.profiles.find((x) => x.name === r.profileName)
        out.push({ name: `${p?.nickname ?? r.profileName.split('@')[0]} · ${s.name}`, left: Math.round(worst) })
      }
    }
    return out.sort((a, b) => b.left - a.left).slice(0, 8)
  }, [usage, services])

  /** Real per-day, per-model output — never an inferred share of a total. */
  const modelMix = useMemo(() => {
    if (!data) return { rows: [], models: [] as string[] }
    const models = data.byModel.slice(0, 4).map((m) => m.name)
    const byDay = new Map<string, Record<string, number | string>>()
    for (const r of data.modelDaily) {
      if (!models.includes(r.model)) continue
      const row = byDay.get(r.day) ?? { day: r.day }
      row[r.model] = ((row[r.model] as number) ?? 0) + r.value
      byDay.set(r.day, row)
    }
    const rows = [...byDay.values()]
      .map((row) => {
        for (const m of models) if (row[m] === undefined) row[m] = 0
        return row
      })
      .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    return { rows, models }
  }, [data])

  const cacheHit = useMemo(() => {
    if (!data) return 0
    const t = data.totals
    const denom = t.cache_read + t.input + t.cache_write
    return denom > 0 ? Math.round((t.cache_read / denom) * 1000) / 10 : 0
  }, [data])

  const toolRatio = useMemo(() => {
    if (!data) return 0
    const tool = data.stopReasons.find((s) => s.name === 'tool_use')?.value ?? 0
    const all = data.stopReasons.reduce((a, s) => a + s.value, 0) || 1
    return Math.round((tool / all) * 100)
  }, [data])

  const ephTotal = (data?.totals.eph_1h ?? 0) + (data?.totals.eph_5m ?? 0)

  /** The account closest to running out, named — the one worth acting on. */
  const tightest = runway.length > 0 ? runway[runway.length - 1] : null
  /** Prefer a window with a cycle actually running; otherwise the first. */
  const headline = data?.pace.find((p) => p.projectedPercent !== null) ?? data?.pace[0] ?? null

  if (!data) {
    return (
      <section className="panel flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <Loader variant="spinner" size={22} className="text-muted-foreground" />
        <p className="pt-4 text-sm text-muted-foreground">Reading your session logs…</p>
      </section>
    )
  }

  if (data.totals.turns === 0 && data.pace.length === 0) {
    return (
      <section className="panel flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <IconTile variant="frame" size="xl" className="text-muted-foreground">
          <ChartNoAxesColumn />
        </IconTile>
        <h2 className="pt-5 text-base font-semibold tracking-tight">Nothing to show yet</h2>
        <p className="max-w-sm pt-1.5 text-sm text-muted-foreground">
          {status?.indexing
            ? `Indexing ${status.filesDone} of ${status.filesTotal} session logs.`
            : 'No Claude Code or Codex session logs were found on this machine.'}
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-4 pb-2">
      {/* Headline: each number names the provider or account it describes —
          with several accounts across several providers, an unlabelled
          projection means nothing. */}
      <div className="grid grid-cols-4 gap-3">
        {tightest ? (
          <Stat
            label="Least headroom"
            value={`${tightest.left}% left`}
            sub={tightest.name}
            tone={tightest.left <= 10 ? 'critical' : tightest.left <= 30 ? 'warning' : 'good'}
          />
        ) : (
          <Stat label="Least headroom" value="—" sub="no live usage yet" />
        )}
        {headline ? (
          <Stat
            label={`${PROVIDER[headline.service] ?? headline.service} ${windowName(headline.label)}`}
            value={
              headline.projectedPercent === null
                ? `${headline.nowPercent}% used`
                : headline.projectedPercent > 100
                  ? 'will run out'
                  : `ends near ${headline.projectedPercent}%`
            }
            sub={
              headline.projectedPercent === null
                ? 'no cycle running now'
                : `${fmtLeft(hoursLeft(headline))} left · at this pace`
            }
            tone={
              headline.projectedPercent === null
                ? undefined
                : headline.projectedPercent > 100
                  ? 'critical'
                  : headline.projectedPercent > 85
                    ? 'warning'
                    : 'good'
            }
          />
        ) : (
          <Stat label="Pace" value="—" sub="needs a few finished cycles" />
        )}
        <Stat
          label="Cache served"
          value={`${cacheHit}%`}
          sub="of input tokens, all providers"
          tone="good"
        />
        <Stat
          label="Output, last 30 days"
          value={compact(data.totals.output)}
          sub={`across ${compact(data.totals.turns)} turns`}
        />
      </div>

      <Subscriptions views={fullViews} usage={usage} now={now} />

      {/* Limits and pace */}
      <div className="grid grid-cols-2 gap-4">
        {data.pace.map((p) => (
          <Panel
            key={`${p.service}-${p.label}`}
            title={`${PROVIDER[p.service] ?? p.service} ${windowName(p.label)}`}
            hint={`This cycle against ${p.cycles} past ones on this machine, at the same point through the window`}
            className="h-72"
          >
            {p.projectedPercent === null ? (
              <Empty>
                No {PROVIDER[p.service] ?? p.service} cycle running. Dashed lines show your usual
                pace; yours appears once you start.
              </Empty>
            ) : (
              <PaceChart series={p} />
            )}
          </Panel>
        ))}
        {data.pace.length === 0 && (
          <Panel title="Pace against your usual" className="h-72">
            <Empty>
              Needs three finished cycles. Codex history comes from its logs; Claude records from
              now on.
            </Empty>
          </Panel>
        )}
        <Panel
          title="Headroom by account"
          hint="Percent left in each account's tightest window"
          className="h-72"
        >
          <RunwayChart data={runway} />
        </Panel>
      </div>

      {/* Attribution */}
      <div className="grid grid-cols-3 gap-4">
        <Panel
          title="Where usage comes from"
          hint="Claude entrypoint, by tokens"
          className="h-72"
        >
          <SurfaceChart data={data.bySurface.map((s) => ({ ...s, name: s.name }))} />
        </Panel>
        <Panel title="Top projects" hint="Output tokens, 30 days" className="h-72">
          <RankedBars data={data.byProject} />
        </Panel>
        <Panel title="Top branches" hint="Output tokens, 30 days" className="h-72">
          <RankedBars data={data.byBranch} color={SERIES[3]} />
        </Panel>
      </div>

      <Panel
        title="Where every token goes"
        hint="Surface, then model, then project"
        className="h-96"
      >
        <FlowChart data={data.flow} />
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Model mix over time" hint="Share of daily output" className="h-72">
          <ModelMixChart data={modelMix.rows} models={modelMix.models} />
        </Panel>
        <Panel title="Output by model" hint="30 days" className="h-72">
          <RankedBars
            data={data.byModel.map((m) => ({ name: modelLabel(m.name), value: m.value }))}
            color={SERIES[1]}
          />
        </Panel>
      </div>

      {/* Efficiency */}
      <div className="grid grid-cols-3 gap-4">
        <Panel
          title="Cache hit rate"
          hint="Input served from cache, not re-read"
          className="h-64"
        >
          <RateGauge percent={cacheHit} label="Cache" color={STATUS.good} caption="served from cache" />
        </Panel>
        <Panel title="Cache trend" hint="Daily hit rate" className="h-64">
          <CacheTrend data={data.cacheDaily} />
        </Panel>
        <Panel
          title="Weakest cache sessions"
          hint="Big sessions that re-read most"
          className="h-64"
          bodyClassName="overflow-y-auto"
        >
          <WorstCacheTable rows={data.worstCache} />
        </Panel>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat
          label="Tool-call turns"
          value={`${toolRatio}%`}
          sub="of assistant turns re-send context"
          tone={toolRatio > 90 ? 'warning' : 'good'}
        />
        <Stat
          label="Compactions"
          value={String(data.events.find((e) => e.kind === 'compaction')?.value ?? 0)}
          sub="context rebuilt, 30 days"
        />
        <Stat
          label="Aborted turns"
          value={String(data.events.find((e) => e.kind === 'aborted')?.value ?? 0)}
          sub="work paid for, discarded"
        />
        <Stat
          label="1-hour cache writes"
          value={ephTotal > 0 ? `${Math.round((data.totals.eph_1h / ephTotal) * 100)}%` : '—'}
          sub="of cache writes use the long tier"
        />
      </div>

      {/* Rhythm */}
      <Panel
        title="When you burn limit"
        hint={`Output tokens by weekday and hour, last 60 days · times in ${TIMEZONE}`}
        className="h-auto"
      >
        <Heatmap data={data.heatmap} />
      </Panel>

      <div className="grid grid-cols-3 gap-4">
        <Panel title="Daily spend by service" hint="Output tokens" className="h-64">
          <DailySpend data={data.daily} />
        </Panel>
        <Panel title="Session lengths" hint="How long a session runs" className="h-64">
          <Histogram data={data.sessionLengths} />
        </Panel>
        <Panel title="Account switches" hint="Per day" className="h-64">
          <DailyCount data={data.switchesDaily} color={SERIES[5]} />
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Panel title="Tools used" hint="Calls, 30 days" className="h-72">
          <RankedBars data={data.byTool} unit="calls" color={SERIES[2]} />
        </Panel>
        <Panel title="Reasoning effort" hint="Turns by effort level" className="h-72">
          <RankedBars data={data.byEffort} unit="turns" color={SERIES[4]} />
        </Panel>
        <Panel
          title="Subscription utilisation"
          hint="Peak percent per window, 30 days"
          className="h-72"
        >
          <RankedBars
            data={data.utilisation.map((u) => ({
              name: `${u.account.split('@')[0]} ${u.label}`,
              value: u.peak
            }))}
            unit="peak %"
            color={STATUS.warning}
          />
        </Panel>
      </div>

      <div className="flex items-center justify-between px-1 pb-1 text-xs text-muted-foreground/70">
        <span>
          {status?.indexing
            ? `Indexing ${status.filesDone} of ${status.filesTotal}…`
            : `From your local session logs · ${compact(data.totals.turns)} turns · updated ${localDayTime(data.generatedAt)}`}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={reindex}
        >
          <RefreshCw className={busy ? 'animate-spin' : ''} />
          Reindex
        </Button>
      </div>
    </div>
  )
}
