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

/**
 * Which of its provider's two slots a model's family always takes, so a
 * model keeps its colour however the period's output ranks it. The families
 * met together most often sit apart: Opus beside Fable or Sonnet, Sol beside
 * the other Codex lines. Two shown models of one slot: the second folds into
 * Other.
 */
const FAMILY_SLOT: Record<keyof typeof MODEL_SLOTS, { family: RegExp; slot: 0 | 1 }[]> = {
  "claude-code": [
    { family: /opus|haiku/i, slot: 0 },
    { family: /fable|sonnet/i, slot: 1 },
  ],
  codex: [{ family: /sol\b/i, slot: 0 }],
};

/** A model's fixed colour slot, by its family. */
export function modelSlot(name: string): { service: keyof typeof MODEL_SLOTS; slot: 0 | 1 } {
  const service = serviceOfModel(name);
  const fixed = FAMILY_SLOT[service].find((f) => f.family.test(name));
  return { service, slot: fixed ? fixed.slot : service === "codex" ? 1 : 0 };
}

/** Everything past the slots, folded into one series. */
export const OTHER_SERIES = "var(--muted-foreground)";

/** How much of the foreground the neutral series takes over the page. */
const NEUTRAL_SHARE = 60;

/**
 * One series that counts both providers (Top projects, Tools used, Cache hit
 * rate, Busiest hours): no provider's colour, so it never reads as Claude's
 * alone. The foreground mixed into the page, a gray step apart from Other.
 */
export const NEUTRAL_SERIES = `color-mix(in oklab, var(--foreground) ${NEUTRAL_SHARE}%, var(--background))`;

/** Steps of the heatmap's one-hue ramp. */
export const RAMP_STEPS = 5;

/** Step `step` (1..steps) of the ramp from the page background to the neutral series; 0 is empty. */
export function ramp(step: number, steps = RAMP_STEPS): string {
  if (step <= 0) return "transparent";
  const share = Math.round((Math.min(step, steps) / steps) * NEUTRAL_SHARE);
  return `color-mix(in oklab, var(--foreground) ${share}%, var(--background))`;
}
