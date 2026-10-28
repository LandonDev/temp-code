import type { PaceSeries, StatsBundle } from "@shared/aliaxStats";

const HOUR = 3_600_000;

/** A cycle of `periodMs`, `now` of the way through, at `percent` and heading for `projected`. */
function pace(service: string, label: string, periodMs: number, now: number, percent: number, projected: number): PaceSeries {
  const points = Array.from({ length: 21 }, (_, i) => {
    const frac = i / 20;
    const usual = Math.round(frac * 70);
    return {
      frac,
      hours: (frac * periodMs) / HOUR,
      p25: Math.max(0, usual - 10),
      median: usual,
      p75: Math.min(100, usual + 12),
      current: frac <= now ? Math.round((frac / now) * percent) : null,
    };
  });
  return { service, label, cycles: 6, nowFrac: now, nowPercent: percent, normalPercent: 50, projectedPercent: projected, exhaustsAtFrac: null, periodMs, points };
}

const days = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

export const STATS: StatsBundle = {
  generatedAt: 0,
  totals: { turns: 840, input: 4_200_000, output: 1_900_000, cache_read: 38_000_000, cache_write: 2_100_000, eph_1h: 0, eph_5m: 0 },
  pace: [pace("codex", "5h", 5 * HOUR, 0.4, 30, 72), pace("codex", "week", 7 * 24 * HOUR, 0.6, 70, 112)],
  bySurface: [],
  byModel: [
    { name: "claude-opus-5-5", value: 900_000, turns: 400 },
    { name: "gpt-6.1-sol", value: 600_000, turns: 300 },
  ],
  byProject: [
    { name: "temp-code", value: 1_200_000, turns: 600 },
    { name: "cosmic", value: 400_000, turns: 200 },
  ],
  byBranch: [],
  byTool: [
    { name: "Bash", value: 1200, kind: "builtin" },
    { name: "Edit", value: 800, kind: "builtin" },
  ],
  byEffort: [],
  stopReasons: [],
  daily: days.map((day, i) => ({ day, claude: 40_000 + (i % 7) * 9_000, codex: 20_000 + (i % 5) * 7_000 })),
  cacheDaily: days.map((day, i) => ({ day, hit: 80 + (i % 9) })),
  worstCache: [],
  heatmap: Array.from({ length: 7 * 24 }, (_, i) => ({ dow: Math.floor(i / 24), hour: i % 24, value: (i * 37) % 100 })),
  sessionLengths: [],
  events: [],
  switchesDaily: [],
  utilisation: [],
  modelDaily: days.flatMap((day, i) => [
    { day, model: "claude-opus-5-5", value: 30_000 + (i % 4) * 5_000 },
    { day, model: "gpt-6.1-sol", value: 20_000 + (i % 3) * 4_000 },
  ]),
  flow: [],
};

export default [
  { name: "Two pace series, one running low", props: { data: STATS, status: null } },
  { name: "Pace with no finished cycles", props: { data: { ...STATS, pace: [] }, status: null } },
];
