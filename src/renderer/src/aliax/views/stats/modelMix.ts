import type { StatsBundle } from "@shared/aliaxStats";
import { MODEL_SLOTS, OTHER_SERIES, serviceOfModel } from "@aliax/charts/palette";

/** The series Model mix stacks: its data key, its legend name and its colour. */
export type MixSeries = { key: string; name: string; color: string };

/** The key the models past the chart's slots fold into. */
export const OTHER_KEY = "__other";

/**
 * Model mix's series and daily rows. Colour follows the entity: a Claude
 * model takes a Claude slot (chart-1, then chart-3) and a Codex model a
 * Codex one (chart-2, then chart-4), in output order within its provider,
 * never by its rank across both. A model past its provider's two slots
 * folds into Other, so the stack's height is always the day's real total.
 */
export function modelMix(data: Pick<StatsBundle, "byModel" | "modelDaily">): { series: MixSeries[]; rows: Record<string, number | string>[] } {
  const used = { "claude-code": 0, codex: 0 };
  const color = new Map<string, string>();
  for (const m of data.byModel) {
    const service = serviceOfModel(m.name);
    const slot = MODEL_SLOTS[service][used[service]];
    if (slot === undefined) continue;
    used[service] += 1;
    color.set(m.name, slot);
  }
  const shown = data.byModel.filter((m) => color.has(m.name)).map((m) => m.name);
  const other = data.modelDaily.some((r) => !color.has(r.model) && r.value > 0);
  const series: MixSeries[] = shown.map((m) => ({ key: m, name: m, color: color.get(m)! }));
  if (other) series.push({ key: OTHER_KEY, name: "Other", color: OTHER_SERIES });

  const byDay = new Map<string, Record<string, number | string>>();
  for (const r of data.modelDaily) {
    const key = color.has(r.model) ? r.model : OTHER_KEY;
    const row = byDay.get(r.day) ?? { day: r.day };
    row[key] = ((row[key] as number | undefined) ?? 0) + r.value;
    byDay.set(r.day, row);
  }
  const rows = [...byDay.values()]
    .map((row) => {
      for (const s of series) row[s.key] ??= 0;
      return row;
    })
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { series, rows };
}
