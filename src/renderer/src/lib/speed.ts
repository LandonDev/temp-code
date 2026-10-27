import type { ModelSetting } from "./models";

/** The Speed row of the model menu: Standard, then each tier the model's
 *  settings carry (the catalog adds the `fast` and `ultrafast` toggles only
 *  for the tiers the serving CLI lists, under its names). */
export type Speed = "standard" | "fast" | "ultrafast";
export type SpeedChoice = { value: Speed; label: string };

const TIERS = ["fast", "ultrafast"] as const;

/** Standard plus each tier present; empty when the model has none. */
export function speedChoices(settings: readonly ModelSetting[]): SpeedChoice[] {
  const tiers = TIERS.flatMap((id) => {
    const setting = settings.find((s) => s.id === id && s.kind === "toggle");
    return setting ? [{ value: id, label: setting.label }] : [];
  });
  return tiers.length ? [{ value: "standard", label: "Standard" }, ...tiers] : [];
}

/** The tier the stored values ask for; Ultrafast wins a stale pair. */
export function speedOf(values: Record<string, string>): Speed {
  if (values.ultrafast === "true") return "ultrafast";
  if (values.fast === "true") return "fast";
  return "standard";
}

/** The values with one tier on and the others off: the two are exclusive.
 *  Only the tiers the choices offer are written. */
export function withSpeed(values: Record<string, string>, speed: Speed, choices: readonly SpeedChoice[]): Record<string, string> {
  const next = { ...values };
  for (const id of TIERS) {
    if (choices.some((c) => c.value === id)) next[id] = speed === id ? "true" : "false";
  }
  return next;
}
