import { useMemo, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import type { PaceSeries, StatsBundle, StatsStatus } from "@shared/aliaxStats";
import { PageSection } from "@renderer/components/page";
import { Empty, EmptyDescription, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { AXIS, BAR, BAR_CURSOR, ChartFrame, GRID, HBAR, LINE, LINE_CURSOR } from "@aliax/charts/chart";
import { ChartLegend } from "@aliax/charts/legend";
import { SERIES, SERVICE_SERIES } from "@aliax/charts/palette";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { TIMEZONE, clip, compact, compactTick, modelLabel, shortDay } from "@aliax/lib/viz";
import { Heatmap } from "./stats/heatmap";

const PROVIDER: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code" };

const windowName = (label: string): string => (label === "week" ? "weekly limit" : `${label.replace("h", "-hour")} limit`);

export const paceTitle = (p: PaceSeries): string => `${PROVIDER[p.service] ?? p.service} ${windowName(p.label)}`;

const hoursLeft = (p: PaceSeries): number => Math.max(0, ((1 - p.nowFrac) * p.periodMs) / 3_600_000);
/** "3 days", "1 hour", "5 hours", "under an hour": rounded first, then the word picked for that number. */
export const timeLeft = (h: number): string => {
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h < 1) return "under an hour";
  const hours = Math.round(h);
  return hours === 1 ? "1 hour" : `${hours} hours`;
};

/** The pace chart's headline in words; running low is amber, never red. */
export function paceLine(p: PaceSeries): { text: string; warning: boolean } {
  if (p.projectedPercent === null) return { text: "No cycle running", warning: false };
  const left = timeLeft(hoursLeft(p));
  if (p.projectedPercent > 100) return { text: `Will run out, ${left} left`, warning: true };
  return { text: `Ends near ${p.projectedPercent}% at this pace, ${left} left`, warning: p.projectedPercent > 85 };
}

/** The headings, in order, while the bundle loads. */
const HEADINGS = ["Pace", "Daily output", "Model mix", "Top projects", "Cache hit rate", "Busiest hours", "Tools used"];

const percent = (v: number): string => `${Math.round(v)}%`;
type TooltipProps = Parameters<typeof ChartTooltipContent>[0];
/** Recharts' hover state handed to the one readout, with the chart's own formatters. */
const tooltip = (props: { active?: boolean; payload?: readonly unknown[]; label?: unknown }, options: Omit<TooltipProps, "active" | "label">) => (
  <ChartTooltipContent active={props.active} payload={props.payload as TooltipProps["payload"]} label={props.label as TooltipProps["label"]} {...options} />
);

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <PageSection title={title} description={description}>
      {children}
    </PageSection>
  );
}

function NoData() {
  return <p className="py-6 text-xs text-muted-foreground">Nothing in the last 30 days</p>;
}

function PaceChart({ series }: { series: PaceSeries }) {
  const weekly = series.periodMs > 86_400_000;
  const data = series.points.map((p) => ({
    hours: Math.round(p.hours * 10) / 10,
    usual: p.p25 !== null && p.p75 !== null ? [p.p25, p.p75] : null,
    median: p.median,
    current: p.current,
  }));
  return (
    <>
      <ChartLegend
        items={[
          { label: "This cycle", color: SERIES[0] },
          { label: "Usual", color: "var(--muted-foreground)" },
        ]}
      />
      <ChartFrame label={paceTitle(series)}>
        <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey="hours" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => (weekly ? `${Math.round(v / 24)}d` : `${v}h`)} minTickGap={24} />
          <YAxis {...AXIS} domain={[0, 100]} width={44} tickFormatter={percent} />
          <ChartTooltip
            cursor={LINE_CURSOR}
            isAnimationActive={false}
            content={(props) =>
              tooltip(props, {
                payload: (props.payload as TooltipProps["payload"])?.filter((e) => e.dataKey !== "usual"),
                labelFormatter: (v) => (weekly ? `Day ${Math.round(Number(v) / 24)}` : `Hour ${v}`),
                valueFormatter: percent,
              })
            }
          />
          <Area dataKey="usual" name="Usual range" stroke="none" fill="var(--foreground)" fillOpacity={0.08} connectNulls isAnimationActive={false} activeDot={false} />
          <Line {...LINE} dataKey="median" name="Usual" stroke="var(--muted-foreground)" strokeWidth={1.5} connectNulls />
          <Line {...LINE} dataKey="current" name="This cycle" stroke={SERIES[0]} connectNulls />
        </ComposedChart>
      </ChartFrame>
    </>
  );
}

function RankedBars({ label, data, unit }: { label: string; data: { name: string; value: number }[]; unit: string }) {
  const rows = data.slice(0, 8);
  if (rows.length === 0) return <NoData />;
  return (
    <ChartFrame label={label} height={rows.length * 28 + 8}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide />
        <YAxis {...AXIS} type="category" dataKey="name" width={128} tickFormatter={(v: string) => clip(v)} />
        <ChartTooltip cursor={BAR_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { valueFormatter: (v) => `${compact(v)} ${unit}` })} />
        <Bar {...HBAR} dataKey="value" name={unit} fill={SERIES[0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** The skeleton while the bundle loads: each section's heading over a 200px block. */
function StatsSkeleton() {
  return (
    <>
      {HEADINGS.map((h) => (
        <Section key={h} title={h}>
          <Skeleton aria-hidden className="h-[200px] w-full rounded-lg" />
        </Section>
      ))}
    </>
  );
}

/**
 * History from this machine's session logs, one chart per section, each
 * directly under its heading. Data in, sections out: StatsPage loads.
 */
export function StatsView({ data, status }: { data: StatsBundle | null; status: StatsStatus | null }) {
  const modelMix = useMemo(() => {
    if (!data) return { rows: [], models: [] as string[] };
    const models = data.byModel.slice(0, 4).map((m) => m.name);
    const byDay = new Map<string, Record<string, number | string>>();
    for (const r of data.modelDaily) {
      if (!models.includes(r.model)) continue;
      const row = byDay.get(r.day) ?? { day: r.day };
      row[r.model] = ((row[r.model] as number | undefined) ?? 0) + r.value;
      byDay.set(r.day, row);
    }
    const rows = [...byDay.values()]
      .map((row) => {
        for (const m of models) row[m] ??= 0;
        return row;
      })
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));
    return { rows, models };
  }, [data]);

  if (!data) return <StatsSkeleton />;

  if (data.totals.turns === 0 && data.pace.length === 0) {
    return (
      <Empty>
        <EmptyTitle>Nothing to show yet</EmptyTitle>
        <EmptyDescription>
          {status?.indexing ? `Indexing ${status.filesDone.toLocaleString()} of ${status.filesTotal.toLocaleString()} session logs` : "No Claude Code or Codex session logs on this machine."}
        </EmptyDescription>
      </Empty>
    );
  }

  const t = data.totals;
  const cacheDenominator = t.cache_read + t.input + t.cache_write;
  const cacheHit = cacheDenominator > 0 ? Math.round((t.cache_read / cacheDenominator) * 100) : 0;

  return (
    <>
      <Section title="Pace">
        {data.pace.length === 0 ? (
          <Empty>
            <EmptyTitle>Needs three finished cycles</EmptyTitle>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {data.pace.map((p) => {
              const line = paceLine(p);
              return (
                <div key={`${p.service}-${p.label}`} data-slot="pace-series">
                  <p className="mb-2 flex flex-wrap gap-x-2 text-[12px]">
                    <span className="text-foreground">{paceTitle(p)}</span>
                    <span className={line.warning ? "text-warning" : "text-muted-foreground"}>{line.text}</span>
                  </p>
                  <PaceChart series={p} />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Daily output">
        {data.daily.length === 0 ? (
          <NoData />
        ) : (
          <>
            <ChartLegend
              items={[
                { label: "Claude Code", color: SERVICE_SERIES["claude-code"] },
                { label: "Codex", color: SERVICE_SERIES.codex },
              ]}
            />
            <ChartFrame label="Daily output">
              <BarChart data={data.daily} barGap={2} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} minTickGap={24} />
                <YAxis {...AXIS} width={44} tickFormatter={compactTick} />
                <ChartTooltip cursor={BAR_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: compact })} />
                <Bar {...BAR} dataKey="claude" name="Claude Code" fill={SERVICE_SERIES["claude-code"]} />
                <Bar {...BAR} dataKey="codex" name="Codex" fill={SERVICE_SERIES.codex} />
              </BarChart>
            </ChartFrame>
          </>
        )}
      </Section>

      <Section title="Model mix">
        {modelMix.rows.length === 0 ? (
          <NoData />
        ) : (
          <>
            <ChartLegend items={modelMix.models.map((m, i) => ({ label: modelLabel(m), color: SERIES[i] }))} />
            <ChartFrame label="Model mix">
              <AreaChart data={modelMix.rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} minTickGap={24} />
                <YAxis {...AXIS} width={44} tickFormatter={compactTick} />
                <ChartTooltip
                  cursor={LINE_CURSOR}
                  isAnimationActive={false}
                  content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: compact, nameFormatter: modelLabel })}
                />
                {modelMix.models.map((m, i) => (
                  <Area key={m} {...LINE} dataKey={m} name={m} stackId="mix" stroke={SERIES[i]} strokeWidth={1.5} fill={SERIES[i]} fillOpacity={0.2} />
                ))}
              </AreaChart>
            </ChartFrame>
          </>
        )}
      </Section>

      <Section title="Top projects">
        <RankedBars label="Top projects" data={data.byProject} unit="tokens" />
      </Section>

      <Section title="Cache hit rate" description={`${cacheHit}% of input served from cache, 30 days`}>
        {data.cacheDaily.length === 0 ? (
          <NoData />
        ) : (
          <ChartFrame label="Cache hit rate">
            <LineChart data={data.cacheDaily} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} minTickGap={24} />
              <YAxis {...AXIS} domain={[0, 100]} width={44} tickFormatter={percent} />
              <ChartTooltip cursor={LINE_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: percent })} />
              <Line {...LINE} dataKey="hit" name="Hit rate" stroke={SERIES[0]} />
            </LineChart>
          </ChartFrame>
        )}
      </Section>

      <Section title="Busiest hours" description={`Output tokens by weekday and hour, last 60 days, times in ${TIMEZONE}`}>
        {data.heatmap.length === 0 ? <NoData /> : <Heatmap data={data.heatmap} />}
      </Section>

      <Section title="Tools used">
        <RankedBars label="Tools used" data={data.byTool} unit="calls" />
      </Section>
    </>
  );
}
