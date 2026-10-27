import type { HarnessId } from "../session";
import { HARNESSES } from "../session";
import { setHarnessModels, type AgentModel, type ModelSetting } from "../models";
import { registry } from "../connection";
import type { ModelInfo, ProviderId, ProviderInfo } from "./types";
import { supportsContext1m } from "@server/shared/catalog";

/**
 * The server's capability catalog and provider health, fanned into
 * MonoCode's model picker and availability gate. One `catalog.get` feeds
 * every harness; one `doctor.get` (cached 30 s) answers "is it installed".
 */

export type DoctorRow = {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
};
export type Doctor = Partial<Record<string, DoctorRow>>;

const CONTEXT_OPTIONS = [
  { value: "200k", label: "200k" },
  { value: "1m", label: "1M" },
];

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function effortSetting(model: ModelInfo): ModelSetting | null {
  if (model.reasoning.length === 0) return null;
  return {
    id: "effort",
    label: "Effort",
    kind: "select",
    value: model.defaultReasoning ?? model.reasoning[0],
    options: model.reasoning.map((value) => ({
      value,
      label: EFFORT_LABELS[value] ?? value[0].toUpperCase() + value.slice(1),
    })),
  };
}

/** The names the CLIs give their speed tiers. A tier id not here is not offered. */
export const TIER_NAMES: Record<string, string> = {
  priority: "Fast",
  ultrafast: "Ultrafast",
  fast: "Fast",
};

const TOGGLE_OPTIONS = [
  { value: "true", label: "On" },
  { value: "false", label: "Off" },
];

function tierToggle(id: "fast" | "ultrafast", tier: string): ModelSetting {
  return { id, label: TIER_NAMES[tier], kind: "toggle", value: "false", options: TOGGLE_OPTIONS };
}

/** Speed settings exist only for the tiers the serving CLI lists
 *  (`speedTiers`): codex's `priority` is the `fast` toggle and `ultrafast`
 *  its own; claude's `fast` is the `fast` toggle. No tiers, no settings. */
function speedSettings(harness: HarnessId, model: ModelInfo): ModelSetting[] {
  const tiers = model.speedTiers ?? [];
  if (harness === "claude") return tiers.includes("fast") ? [tierToggle("fast", "fast")] : [];
  if (harness !== "codex") return [];
  const out: ModelSetting[] = [];
  if (tiers.includes("priority")) out.push(tierToggle("fast", "priority"));
  if (tiers.includes("ultrafast")) out.push(tierToggle("ultrafast", "ultrafast"));
  return out;
}

/** `claude-…` models that offer 1M get the context select (session.tune). */
function claudeSettings(model: ModelInfo): ModelSetting[] {
  if (!supportsContext1m("claude", model.id)) return [];
  return [{ id: "context", label: "Context", kind: "select", value: "200k", options: CONTEXT_OPTIONS }];
}

export function agentModelsFor(provider: ProviderInfo): AgentModel[] {
  const harness = provider.id as HarnessId;
  return provider.models.map((model) => {
    const settings = [
      ...(effortSetting(model) ? [effortSetting(model)!] : []),
      ...(harness === "claude" ? claudeSettings(model) : []),
      ...speedSettings(harness, model),
    ];
    return {
      id: `${harness}:${model.id}`,
      harness,
      name: model.label,
      nativeId: model.id,
      ...(model.context ? { contextWindow: model.context } : {}),
      ...(settings.length > 0 ? { settings } : {}),
    };
  });
}

const catalogInflight = new Map<string, Promise<void>>();

/** Pull one environment's catalog once and overlay every provider's models for it. */
export function refreshCatalog(environmentId: string): Promise<void> {
  const inflight = catalogInflight.get(environmentId);
  if (inflight) return inflight;
  const run = registry
    .linkOf(environmentId)
    .request<Record<ProviderId, ProviderInfo>>("catalog.get")
    .then((catalog) => {
      for (const provider of Object.values(catalog)) {
        if (!(HARNESSES as string[]).includes(provider.id)) continue;
        setHarnessModels(provider.id as HarnessId, agentModelsFor(provider), provider.defaultModel, environmentId);
      }
    })
    .finally(() => {
      catalogInflight.delete(environmentId);
    });
  catalogInflight.set(environmentId, run);
  return run;
}

const DOCTOR_TTL_MS = 30_000;
type DoctorProbe = { at: number; inflight: Promise<Doctor> | null; last: Doctor };
const doctors = new Map<string, DoctorProbe>();
const doctorOf = (environmentId: string): DoctorProbe => {
  let probe = doctors.get(environmentId);
  if (!probe) {
    probe = { at: 0, inflight: null, last: {} };
    doctors.set(environmentId, probe);
  }
  return probe;
};

/** One host's provider health, cached briefly; `force` bypasses the cache. */
export function probeDoctor(
  environmentId: string,
  options?: { force?: boolean },
): Promise<Doctor> {
  const probe = doctorOf(environmentId);
  if (probe.inflight) return probe.inflight;
  if (!options?.force && probe.at > 0 && Date.now() - probe.at < DOCTOR_TTL_MS) {
    return Promise.resolve(probe.last);
  }
  probe.inflight = registry
    .linkOf(environmentId)
    .request<Doctor>("doctor.get")
    .then((doctor) => {
      probe.last = doctor;
      return doctor;
    })
    .finally(() => {
      probe.at = Date.now();
      probe.inflight = null;
    });
  return probe.inflight;
}

/** Test seam. */
export function resetCatalogProbes(): void {
  doctors.clear();
  catalogInflight.clear();
}

export function availabilityFromDoctor(doctor: Doctor): Record<HarnessId, boolean> {
  const out = {} as Record<HarnessId, boolean>;
  for (const id of HARNESSES) out[id] = doctor[id]?.found === true;
  return out;
}
