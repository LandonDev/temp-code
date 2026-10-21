import { useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_PLAN_SETTINGS,
  PlanSettingsSchema,
  type PlanSettings,
} from "@server/shared/plans";
import { registry } from "../connection";
import { bridgeNewThread } from "../macBridge";
import { sessionStore } from "./store";
import type { PermissionPolicy, SessionMeta, ThreadRules, WireSessionMeta } from "./types";

/**
 * Plan settings (plans.ts on the server): what happens when a plan is
 * complete. One global set per host plus whole-object per-project
 * overrides, resolved server-side; this store mirrors the scopes the UI
 * has asked for so Settings and the project dialog read one answer.
 */

export type PlanScope = { settings: PlanSettings; overridden: boolean };
export const BUILT_IN_PLAN_SCOPE: PlanScope = { settings: DEFAULT_PLAN_SETTINGS, overridden: false };

const scopes = new Map<string, PlanScope>();
const listeners = new Set<() => void>();
const loading = new Set<string>();
let version = 0;

const key = (environmentId: string, projectId: string | null): string => `${environmentId}|${projectId ?? ""}`;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function coerce(raw: unknown): PlanScope {
  const r = (raw ?? {}) as { settings?: unknown; overridden?: unknown };
  const parsed = PlanSettingsSchema.safeParse(r.settings);
  return { settings: parsed.success ? parsed.data : DEFAULT_PLAN_SETTINGS, overridden: r.overridden === true };
}

export async function loadPlanSettings(environmentId: string, projectId: string | null): Promise<PlanScope> {
  const k = key(environmentId, projectId);
  if (loading.has(k)) return scopes.get(k) ?? BUILT_IN_PLAN_SCOPE;
  loading.add(k);
  try {
    const raw = await registry.linkOf(environmentId).request("plans.get", { projectId });
    const scope = coerce(raw);
    scopes.set(k, scope);
    emit();
    return scope;
  } finally {
    loading.delete(k);
  }
}

/** Store a set at the scope, or null to clear it: a project falls back to
 *  the global set, the global set to the built-in one. */
export async function savePlanSettings(
  environmentId: string,
  projectId: string | null,
  settings: PlanSettings | null,
): Promise<void> {
  await registry.linkOf(environmentId).request("plans.set", { projectId, settings });
  const globalKey = key(environmentId, null);
  if (projectId) {
    const inherited = scopes.get(globalKey)?.settings ?? DEFAULT_PLAN_SETTINGS;
    scopes.set(key(environmentId, projectId), settings ? { settings, overridden: true } : { settings: inherited, overridden: false });
  } else {
    scopes.set(globalKey, settings ? { settings, overridden: true } : BUILT_IN_PLAN_SCOPE);
    for (const [k, scope] of scopes) {
      if (k !== globalKey && k.startsWith(`${environmentId}|`) && !scope.overridden) {
        scopes.set(k, { settings: settings ?? DEFAULT_PLAN_SETTINGS, overridden: false });
      }
    }
  }
  emit();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** A scope's plan settings on one host, loaded the first time they are asked for. */
export function usePlanSettings(environmentId: string | undefined, projectId: string | null): PlanScope | undefined {
  useSyncExternalStore(subscribe, () => version);
  const scope = environmentId ? scopes.get(key(environmentId, projectId)) : undefined;
  useEffect(() => {
    if (environmentId && !scope) void loadPlanSettings(environmentId, projectId).catch(() => {});
  }, [scope, environmentId, projectId]);
  return scope;
}

export const samePlanSettings = (a: PlanSettings, b: PlanSettings): boolean =>
  a.autoImplement === b.autoImplement &&
  a.archiveAfterStart === b.archiveAfterStart &&
  a.implementModel === b.implementModel &&
  a.implementReasoning === b.implementReasoning &&
  a.implementContext === b.implementContext;

/** Test seam. */
export function resetPlanSettingsForTests(): void {
  scopes.clear();
  loading.clear();
}

export type ImplementPlanParams = {
  provider?: string;
  model?: string;
  reasoning?: string;
  context1m?: boolean;
  permission?: PermissionPolicy;
  threadType?: "implementation" | "orchestration";
  goal?: string;
  threadRules?: ThreadRules;
};

/** Start the implementation thread from a finished plan — the same server
 *  function the auto-start runs (plan.implement). The new thread is
 *  adopted here so it gets a tab at once. */
export async function implementPlan(
  environmentId: string,
  planId: string,
  params: ImplementPlanParams = {},
): Promise<SessionMeta> {
  const link = registry.linkOf(environmentId);
  const wire = await link.request<WireSessionMeta>("plan.implement", { sessionId: planId, ...params });
  const meta: SessionMeta = { ...wire, environmentId };
  sessionStore.adopt(meta);
  await bridgeNewThread(environmentId, meta.id);
  return meta;
}
