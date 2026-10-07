import { DEFAULT_THREAD_DEFAULTS } from "@server/shared/defaults";
import { HARNESSES, HARNESS_TITLE, type HarnessId, type RuntimeMode } from "../session";
import { modelsFor, resolveModel, type AgentModel } from "../models";
import { modeForPolicy } from "./access";
import type { ThreadDefaults, ThreadType } from "./types";

/**
 * Thread defaults: what a NEW thread starts with when nobody picks
 * otherwise. The server keeps a global set plus whole-object workspace
 * overrides and answers `defaults.get` with `{defaults, overridden}` —
 * the effective set for that scope and whether the scope stores its own.
 * These helpers parse that wrapper, keep the effort valid for the picked
 * model, and turn a set into the shape a draft session is built from.
 */

export type Reasoning = ThreadDefaults["reasoning"];
export type Permission = ThreadDefaults["permission"];

export type DefaultsScope = {
  /** The set in force at this scope (its own, else inherited). */
  defaults: ThreadDefaults;
  /** Whether this scope stores its own set. For the global scope: whether
   *  the user changed it from the built-in. */
  overridden: boolean;
};

export const REASONING_LEVELS: readonly Reasoning[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const EFFORT_LABELS: Record<Reasoning, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  safe: "Ask first",
  edits: "Auto-edits",
  auto: "Full access",
};

export const PERMISSION_HINTS: Record<Permission, string> = {
  safe: "Every tool call asks before running.",
  edits: "File edits run freely; commands still ask.",
  auto: "Everything runs without asking.",
};

export const BUILT_IN_SCOPE: DefaultsScope = { defaults: DEFAULT_THREAD_DEFAULTS, overridden: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One field at a time, so a stale or partial payload still yields a usable set. */
export function coerceDefaults(raw: unknown): ThreadDefaults {
  const r = isRecord(raw) ? raw : {};
  const provider = (HARNESSES as readonly string[]).includes(String(r.provider))
    ? (r.provider as ThreadDefaults["provider"])
    : DEFAULT_THREAD_DEFAULTS.provider;
  const reasoning = REASONING_LEVELS.includes(r.reasoning as Reasoning)
    ? (r.reasoning as Reasoning)
    : DEFAULT_THREAD_DEFAULTS.reasoning;
  const permission = ["safe", "edits", "auto"].includes(String(r.permission))
    ? (r.permission as Permission)
    : DEFAULT_THREAD_DEFAULTS.permission;
  return { provider, model: typeof r.model === "string" ? r.model : "", reasoning, permission };
}

/**
 * The `defaults.get` payload. Accepts the `{defaults, overridden}` wrapper
 * the server sends, a bare set (an older server — treated as stored at
 * this scope), and null (nothing set anywhere: the built-in set).
 */
export function parseDefaultsScope(raw: unknown): DefaultsScope {
  if (raw == null) return BUILT_IN_SCOPE;
  if (isRecord(raw) && "defaults" in raw) {
    return { defaults: coerceDefaults(raw.defaults), overridden: raw.overridden === true };
  }
  return { defaults: coerceDefaults(raw), overridden: true };
}

export const sameDefaults = (a: ThreadDefaults, b: ThreadDefaults): boolean =>
  a.provider === b.provider && a.model === b.model && a.reasoning === b.reasoning && a.permission === b.permission;

/** The catalog model a set names: its own, else the provider's default. */
export function modelForDefaults(d: Pick<ThreadDefaults, "provider" | "model">): AgentModel {
  return resolveModel(d.provider as HarnessId, d.model || undefined);
}

/** The model's effort ladder from the live catalog; empty when it has none. */
export function effortLadder(model: AgentModel): Reasoning[] {
  const effort = model.settings?.find((s) => s.id === "effort");
  if (!effort) return [];
  return effort.options.map((o) => o.value).filter((v): v is Reasoning => REASONING_LEVELS.includes(v as Reasoning));
}

/** The effort to use when the wanted one is off the ladder: the model's own default. */
export function clampReasoning(model: AgentModel, reasoning: Reasoning): Reasoning {
  const ladder = effortLadder(model);
  if (ladder.length === 0 || ladder.includes(reasoning)) return reasoning;
  const effort = model.settings?.find((s) => s.id === "effort");
  return REASONING_LEVELS.includes(effort?.value as Reasoning) ? (effort!.value as Reasoning) : ladder[0];
}

/** A set with its effort kept valid for the model it names. */
export function normalizeDefaults(d: ThreadDefaults): ThreadDefaults {
  const reasoning = clampReasoning(modelForDefaults(d), d.reasoning);
  return reasoning === d.reasoning ? d : { ...d, reasoning };
}

export const providerOptions = (): { value: HarnessId; label: string }[] =>
  HARNESSES.map((id) => ({ value: id, label: HARNESS_TITLE[id] }));

/** Catalog models for the provider, keyed by the native id the server stores. */
export const modelOptions = (provider: string): { value: string; label: string }[] =>
  modelsFor(provider as HarnessId).map((m) => ({ value: m.nativeId ?? m.id, label: m.name }));

/** The native id of the model a set names, '' when it is the provider default. */
export function storedModelId(d: ThreadDefaults): string {
  if (!d.model) return "";
  const m = modelForDefaults(d);
  return m.nativeId ?? m.id;
}

export type DraftSeed = {
  harness: HarnessId;
  /** picker id of the model, undefined = the provider default */
  model: string | undefined;
  runtimeMode: RuntimeMode;
  modelSettings: Record<string, string>;
};

/** What a draft session is built from: harness, picker model id, access mode, effort.
 *  A research thread runs on claude whatever the default provider: it has
 *  both a search and a fetch tool, and its web tools run free under
 *  Auto-edits (codex has no fetch, and its Auto-edits sandbox has no network). */
export function draftFromDefaults(d: ThreadDefaults, threadType?: ThreadType | null): DraftSeed {
  const seed = threadType === "research" && d.provider !== "claude" ? { ...d, provider: "claude" as const, model: "" } : d;
  const harness = seed.provider as HarnessId;
  const model = modelForDefaults(seed);
  return {
    harness,
    model: seed.model ? model.id : undefined,
    runtimeMode: modeForPolicy(seed.permission),
    modelSettings: { effort: clampReasoning(model, seed.reasoning) },
  };
}
