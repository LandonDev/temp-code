import { useMemo, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import type { PaceSeries, StatsBundle, StatsStatus } from "@shared/aliaxStats";
import { PageEmpty, PageSection } from "@renderer/components/page";
import { Empty, EmptyDescription, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { AXIS, BAR, BAR_CURSOR, CHART_HEIGHT, ChartFrame, GRID, HBAR, LINE, LINE_CURSOR } from "@aliax/charts/chart";
import { ChartLegend } from "@aliax/charts/legend";
import { SERIES, SERVICE_SERIES } from "@aliax/charts/palette";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { TIMEZONE, clip, compact, compactTick, modelLabel, shortDay } from "@aliax/lib/viz";
import { HEATMAP_HEIGHT, Heatmap } from "./stats/heatmap";
import { modelMix, OTHER_KEY } from "./stats/modelMix";

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
const HEADINGS = ["Pace", "Daily output", "Model mix", "Top projects", "Cache hit rate", "Busiest hours", "Tools used"] as const;

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

/** A section with no data in the 30 days its query reads. A section whose
 *  description already names its window (Cache hit rate, Busiest hours'
 *  60 days) says Nothing yet, so the window is said once. */
function NoData({ named = false }: { named?: boolean }) {
  return <PageEmpty>{named ? "Nothing yet" : "Nothing in the last 30 days"}</PageEmpty>;
}

function PaceChart({ series }: { series: PaceSeries }) {
  // The cycle is drawn in its provider's colour, as on every other chart.
  const color = SERVICE_SERIES[series.service as keyof typeof SERVICE_SERIES] ?? SERIES[0];
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
          { label: "This cycle", color },
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
          <Line {...LINE} dataKey="current" name="This cycle" stroke={color} connectNulls />
        </ComposedChart>
      </ChartFrame>
    </>
  );
}

/** A ranked list shows at most this many rows, each 28px, with 8px under the last. */
const RANKED_ROWS = 8;
const rankedHeight = (rows: number): number => rows * 28 + 8;

function RankedBars({ label, data, unit }: { label: string; data: { name: string; value: number }[]; unit: string }) {
  const rows = data.slice(0, RANKED_ROWS);
  if (rows.length === 0) return <NoData />;
  return (
    <ChartFrame label={label} height={rankedHeight(rows.length)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide />
        <YAxis {...AXIS} type="category" dataKey="name" width={128} tickFormatter={(v: string) => clip(v)} />
        <ChartTooltip cursor={BAR_CURSOR} isAnimationActive={false} content={(props) => tooltip(props, { valueFormatter: (v) => `${compact(v)} ${unit}` })} />
        <Bar {...HBAR} dataKey="value" name={unit} fill={SERIES[0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** A legend's line: 16px of 12px text and its 8px to the plot. */
const LEGEND_PX = 24;
/** A pace series' headline above its legend, the same 16px line and 8px. */
const HEADLINE_PX = 24;

/**
 * What each section holds once loaded, so the skeleton takes its shape and
 * the page does not jump when the bundle lands: the plot's height, a legend
 * where the chart draws one, the ranked lists at their eight rows, and the
 * description lines Cache hit rate and Busiest hours carry.
 */
export const SECTION_SKELETON: Record<(typeof HEADINGS)[number], { height: number; description?: boolean }> = {
  Pace: { height: HEADLINE_PX + LEGEND_PX + CHART_HEIGHT },
  "Daily output": { height: LEGEND_PX + CHART_HEIGHT },
  "Model mix": { height: LEGEND_PX + CHART_HEIGHT },
  "Top projects": { height: rankedHeight(RANKED_ROWS) },
  "Cache hit rate": { height: CHART_HEIGHT, description: true },
  "Busiest hours": { height: HEATMAP_HEIGHT, description: true },
  "Tools used": { height: rankedHeight(RANKED_ROWS) },
};

/** The skeleton while the bundle loads or a first index runs: each section's heading over the shape it will hold. */
function StatsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="contents">
      {HEADINGS.map((h) => {
        const shape = SECTION_SKELETON[h];
        return (
          <Section
            key={h}
            title={h}
            // A line of the description's 16px, the bar at its text's height (a span: the description is a paragraph).
            description={shape.description ? <span aria-hidden data-slot="skeleton" className="inline-block h-3 w-56 rounded-md bg-muted align-middle" /> : undefined}
          >
            <Skeleton aria-hidden data-section-skeleton={h} className="w-full rounded-lg" style={{ height: shape.height }} />
          </Section>
        );
      })}
    </div>
  );
}

/**
 * History from this machine's session logs, one chart per section, each
 * directly under its heading. Data in, sections out: StatsPage loads.
 */
export function StatsView({ data, status }: { data: StatsBundle | null; status: StatsStatus | null }) {
  const mix = useMemo(() => (data ? modelMix(data) : { series: [], rows: [] }), [data]);

  const nothing = data !== null && data.totals.turns === 0 && data.pace.length === 0;
  // A first index is a load: the page's line says how far it has got.
  if (!data || (nothing && status?.indexing)) return <StatsSkeleton />;
  // A worker that is gone is the page's red line; its empty bundle states nothing.
  if (nothing && data.unavailable) return null;
  if (nothing) {
    return (
      <Empty>
        <EmptyTitle>Nothing to show yet</EmptyTitle>
        <EmptyDescription>No Claude Code or Codex session logs on this machine.</EmptyDescription>
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
          <PageEmpty>Needs three finished cycles</PageEmpty>
        ) : (
          <div className="flex flex-col gap-4">
            {data.pace.map((p) => {
              const line = paceLine(p);
              return (
                <div key={`${p.service}-${p.label}`} data-slot="pace-series">
                  <p className="mb-2 flex flex-wrap gap-x-1 text-xs">
                    <span className="font-medium text-foreground">{paceTitle(p)}</span>
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
        {mix.rows.length === 0 ? (
          <NoData />
        ) : (
          <>
            <ChartLegend items={mix.series.map((m) => ({ label: m.key === OTHER_KEY ? m.name : modelLabel(m.name), color: m.color }))} />
            <ChartFrame label="Model mix">
              <AreaChart data={mix.rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis {...AXIS} dataKey="day" tickFormatter={shortDay} minTickGap={24} />
                <YAxis {...AXIS} width={44} tickFormatter={compactTick} />
                <ChartTooltip
                  cursor={LINE_CURSOR}
                  isAnimationActive={false}
                  content={(props) => tooltip(props, { labelFormatter: (v) => shortDay(String(v)), valueFormatter: compact, nameFormatter: (n) => (n === "Other" ? n : modelLabel(n)) })}
                />
                {mix.series.map((m) => (
                  <Area key={m.key} {...LINE} dataKey={m.key} name={m.name} stackId="mix" stroke={m.color} strokeWidth={1.5} fill={m.color} fillOpacity={0.2} />
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
          <NoData named />
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
        {data.heatmap.length === 0 ? <NoData named /> : <Heatmap data={data.heatmap} />}
      </Section>

      <Section title="Tools used">
        <RankedBars label="Tools used" data={data.byTool} unit="calls" />
      </Section>
    </>
  );
}
