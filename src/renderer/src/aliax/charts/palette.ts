/**
 * Chart colours are tokens (index.css `--chart-1..4`, light and dark), taken
 * in fixed order and never cycled. Colour follows the entity: a provider
 * keeps its slot on every chart.
 */
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"] as const;

export const SERVICE_SERIES = { "claude-code": SERIES[0], codex: SERIES[1] } as const;

/** The provider a model name belongs to: Claude's families, else Codex. */
export const serviceOfModel = (name: string): "claude-code" | "codex" => (/claude|opus|sonnet|haiku|fable/i.test(name) ? "claude-code" : "codex");

/** Each provider's two model slots: its own colour first, then its second. */
export const MODEL_SLOTS = { "claude-code": [SERIES[0], SERIES[2]], codex: [SERIES[1], SERIES[3]] } as const;

/** Everything past the slots, folded into one series. */
export const OTHER_SERIES = "var(--muted-foreground)";

/** Steps of the heatmap's one-hue ramp. */
export const RAMP_STEPS = 5;

/** Step `step` (1..steps) of the ramp from the page background to `--chart-1`; 0 is empty. */
export function ramp(step: number, steps = RAMP_STEPS): string {
  if (step <= 0) return "transparent";
  const share = Math.round((Math.min(step, steps) / steps) * 100);
  return `color-mix(in oklab, var(--chart-1) ${share}%, var(--background))`;
}
