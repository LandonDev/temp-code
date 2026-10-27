/**
 * Chart colours are tokens (index.css `--chart-1..4`, light and dark), taken
 * in fixed order and never cycled. Colour follows the entity: a provider
 * keeps its slot on every chart.
 */
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"] as const;

export const SERVICE_SERIES = { "claude-code": SERIES[0], codex: SERIES[1] } as const;

/** Steps of the heatmap's one-hue ramp. */
export const RAMP_STEPS = 5;

/** Step `step` (1..steps) of the ramp from the page background to `--chart-1`; 0 is empty. */
export function ramp(step: number, steps = RAMP_STEPS): string {
  if (step <= 0) return "transparent";
  const share = Math.round((Math.min(step, steps) / steps) * 100);
  return `color-mix(in oklab, var(--chart-1) ${share}%, var(--background))`;
}
