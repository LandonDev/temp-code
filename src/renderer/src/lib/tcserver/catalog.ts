import type { HarnessId } from "../session";
import { HARNESSES } from "../session";
import { setHarnessModels, type AgentModel, type ModelSetting } from "../models";
import { client } from "./client";
import type { Link } from "./store";
import type { ModelInfo, ProviderId, ProviderInfo } from "./types";

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

/** `claude-…` models get the fast + context toggles (session.tune). */
function claudeSettings(model: ModelInfo): ModelSetting[] {
  const settings: ModelSetting[] = [];
  if (model.context && model.context >= 1_000_000) {
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
      ...(harness === "codex" ? [PRIORITY_MODE] : []),
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

let catalogInflight: Promise<void> | null = null;

/** Pull the catalog once and overlay every provider's models. */
export function refreshCatalog(link: Link = client): Promise<void> {
  if (catalogInflight) return catalogInflight;
  catalogInflight = link
    .request<Record<ProviderId, ProviderInfo>>("catalog.get")
    .then((catalog) => {
      for (const provider of Object.values(catalog)) {
        if (!(HARNESSES as string[]).includes(provider.id)) continue;
        setHarnessModels(provider.id as HarnessId, agentModelsFor(provider), provider.defaultModel);
      }
    })
    .finally(() => {
      catalogInflight = null;
    });
  return catalogInflight;
}

const DOCTOR_TTL_MS = 30_000;
let doctorAt = 0;
let doctorInflight: Promise<Doctor> | null = null;
let lastDoctor: Doctor = {};

/** Provider health, cached briefly; `force` bypasses the cache. */
export function probeDoctor(
  options?: { force?: boolean },
  link: Link = client,
): Promise<Doctor> {
  if (doctorInflight) return doctorInflight;
  if (!options?.force && doctorAt > 0 && Date.now() - doctorAt < DOCTOR_TTL_MS) {
    return Promise.resolve(lastDoctor);
  }
  doctorInflight = link
    .request<Doctor>("doctor.get")
    .then((doctor) => {
      lastDoctor = doctor;
      return doctor;
    })
    .finally(() => {
      doctorAt = Date.now();
      doctorInflight = null;
    });
  return doctorInflight;
}

/** Test seam. */
export function resetCatalogProbes(): void {
  doctorAt = 0;
  doctorInflight = null;
  lastDoctor = {};
  catalogInflight = null;
}

export function availabilityFromDoctor(doctor: Doctor): Record<HarnessId, boolean> {
  const out = {} as Record<HarnessId, boolean>;
  for (const id of HARNESSES) out[id] = doctor[id]?.found === true;
  return out;
}
