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

function effortSetting(model: ModelInfo): ModelSetting | null {
  if (model.reasoning.length === 0) return null;
  return {
    id: "effort",
    label: "Reasoning",
    kind: "select",
    value: model.defaultReasoning ?? model.reasoning[0],
    options: model.reasoning.map((value) => ({
      value,
      label: value === "xhigh" ? "Extra High" : value[0].toUpperCase() + value.slice(1),
    })),
  };
}

const FAST_OPTIONS = [
  { value: "true", label: "On" },
  { value: "false", label: "Off" },
];

const FAST_MODE: ModelSetting = {
  id: "fast",
  label: "Fast",
  kind: "toggle",
  value: "false",
  description: "Fast mode",
  options: FAST_OPTIONS,
};

/** Codex's Fast is priority processing (`service_tier: priority`); same
 *  `fast` id so session.tune and the queue treat both alike. */
const PRIORITY_MODE: ModelSetting = {
  ...FAST_MODE,
  description: "Fast (priority processing)",
};

/** Codex's `ultrafast` service tier: offered only when the installed CLI
 *  lists it for the model on the logged-in account (speedTiers, probed by
 *  the server). Exclusive with Fast; the same toggle shape. */
const ULTRAFAST_MODE: ModelSetting = {
  id: "ultrafast",
  label: "Ultrafast",
  kind: "toggle",
  value: "false",
  description: "Ultrafast (fastest service tier)",
  options: FAST_OPTIONS,
};

function codexSettings(model: ModelInfo): ModelSetting[] {
  const tiers = model.speedTiers;
  if (tiers?.includes("ultrafast")) return [PRIORITY_MODE, ULTRAFAST_MODE];
  if (tiers) {
    return [{ ...PRIORITY_MODE, description: `${PRIORITY_MODE.description} · Ultrafast is not on this account` }];
  }
  return [PRIORITY_MODE];
}

/** `claude-…` models get the fast + context toggles (session.tune). */
function claudeSettings(model: ModelInfo): ModelSetting[] {
  const settings: ModelSetting[] = [];
  if (supportsContext1m("claude", model.id)) {
    settings.push({
      id: "context",
      label: "Context",
      kind: "select",
      value: "200k",
      options: CONTEXT_OPTIONS,
    });
  }
  if (!model.id.includes("sonnet")) settings.push(FAST_MODE);
  return settings;
}

export function agentModelsFor(provider: ProviderInfo): AgentModel[] {
  const harness = provider.id as HarnessId;
  return provider.models.map((model) => {
    const settings = [
      ...(effortSetting(model) ? [effortSetting(model)!] : []),
      ...(harness === "claude" ? claudeSettings(model) : []),
      ...(harness === "codex" ? codexSettings(model) : []),
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
