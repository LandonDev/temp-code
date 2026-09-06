import { useEffect, useSyncExternalStore } from "react";
import {
  approvedLadder,
  DEFAULT_RULES,
  mergeThreadRules,
  modelApproved,
  modelKey,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
} from "@server/shared/rules";
import { OPEN_SETTINGS_EVENT } from "../monaco/debugTab";
import { client } from "./client";
import type { Link } from "./store";
import type { ProviderId, ProviderInfo } from "./types";

/**
 * Orchestration rules, global with whole-object per-workspace overrides,
 * over the server's `rules.get` / `rules.set`. Every edit persists at once:
 * these are settings, not a document. The spawn catalog rides along so the
 * editor can list the models a rule may approve.
 */

export {
  approvedLadder,
  DEFAULT_RULES,
  mergeThreadRules,
  modelApproved,
  modelKey,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
};

/** Providers a subagent can be spawned on. The probed five stay out. */
export const SPAWN_PROVIDERS: ProviderId[] = ["claude", "codex", "cursor"];
export type SpawnProviderId = "claude" | "codex" | "cursor";

export type RulesScope = {
  /** What applies here: override, else global, else the defaults. */
  rules: OrchestrationRules;
  /** Whether this scope holds its own copy. */
  overridden: boolean;
};

export type RulesCatalog = Partial<Record<SpawnProviderId, ProviderInfo>>;

export type RulesState = {
  /** Keyed by workspace id, "" for global; absent until loaded. */
  scopes: ReadonlyMap<string, RulesScope>;
  catalog: RulesCatalog | null;
};

const GLOBAL = "";
const EMPTY: RulesState = { scopes: new Map(), catalog: null };

// ── pure helpers ───────────────────────────────────────────────────────

/** The spawn providers present in a server catalog, in fixed order. */
export function spawnCatalog(catalog: Partial<Record<string, ProviderInfo>>): RulesCatalog {
  const out: RulesCatalog = {};
  for (const id of SPAWN_PROVIDERS) {
    const info = catalog[id];
    if (info) out[id as SpawnProviderId] = info;
  }
  return out;
}

/** A policy back at its default (approved, unbounded) leaves the record. */
export function patchModelPolicy(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  patch: Partial<ModelPolicy>,
): OrchestrationRules {
  const key = modelKey(provider, modelId);
  const prev: ModelPolicy = rules.models[key] ?? { approved: true };
  const next: ModelPolicy = { ...prev, ...patch };
  const models = { ...rules.models };
  if (next.approved && !next.minReasoning && !next.maxReasoning) delete models[key];
  else models[key] = next;
  return { ...rules, models };
}

export function upsertRoutingRule(rules: OrchestrationRules, rule: RoutingRule): OrchestrationRules {
  const exists = rules.routing.some((r) => r.id === rule.id);
  return {
    ...rules,
    routing: exists ? rules.routing.map((r) => (r.id === rule.id ? rule : r)) : [...rules.routing, rule],
  };
}

export function removeRoutingRule(rules: OrchestrationRules, id: string): OrchestrationRules {
  return { ...rules, routing: rules.routing.filter((r) => r.id !== id) };
}

/** Swap a rule with the one above it; the first rule stays put. */
export function moveRoutingRuleUp(rules: OrchestrationRules, index: number): OrchestrationRules {
  if (index <= 0 || index >= rules.routing.length) return rules;
  const routing = [...rules.routing];
  [routing[index - 1], routing[index]] = [routing[index], routing[index - 1]];
  return { ...rules, routing };
}

export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── store ──────────────────────────────────────────────────────────────

class RulesStore {
  private state: RulesState = EMPTY;
  private listeners = new Set<() => void>();
  private link: Link | null = null;
  private inflight = new Map<string, Promise<RulesScope>>();

  connect(link: Link = client): void {
    this.link = link;
  }

  /** Test seam. */
  reset(): void {
    this.link = null;
    this.inflight.clear();
    this.set(EMPTY);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RulesState => this.state;

  scope(workspaceId: string | null): RulesScope | undefined {
    return this.state.scopes.get(workspaceId ?? GLOBAL);
  }

  /** Read a scope from the server once; later reads come from the cache. */
  load(workspaceId: string | null): Promise<RulesScope> {
    const key = workspaceId ?? GLOBAL;
    const cached = this.state.scopes.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const link = this.link;
    if (!link) return Promise.resolve({ rules: DEFAULT_RULES, overridden: false });
    const request = link
      .request<RulesScope>("rules.get", { workspaceId })
      .then((scope) => {
        this.setScope(key, scope);
        return scope;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  loadCatalog(): Promise<RulesCatalog> {
    if (this.state.catalog) return Promise.resolve(this.state.catalog);
    const link = this.link;
    if (!link) return Promise.resolve({});
    return link.request<Record<string, ProviderInfo>>("catalog.get").then((raw) => {
      const catalog = spawnCatalog(raw);
      this.set({ ...this.state, catalog });
      return catalog;
    });
  }

  /** Persist a scope's rules; the cache updates first so the editor never waits. */
  save(workspaceId: string | null, rules: OrchestrationRules): Promise<void> {
    const key = workspaceId ?? GLOBAL;
    this.setScope(key, { rules, overridden: true });
    if (workspaceId === null) this.dropInherited();
    return this.link?.request("rules.set", { workspaceId, rules }).then(() => undefined) ?? Promise.resolve();
  }

  /** Clear a scope: global goes back to the defaults, an override goes away. */
  async clear(workspaceId: string | null): Promise<RulesScope> {
    const key = workspaceId ?? GLOBAL;
    await this.link?.request("rules.set", { workspaceId, rules: null });
    const scopes = new Map(this.state.scopes);
    scopes.delete(key);
    this.set({ ...this.state, scopes });
    if (workspaceId === null) this.dropInherited();
    return this.load(workspaceId);
  }

  /** Workspaces without an override mirror the global rules; forget them
   *  so the next read picks the new global copy up. */
  private dropInherited(): void {
    const scopes = new Map(this.state.scopes);
    for (const [key, scope] of scopes) if (key !== GLOBAL && !scope.overridden) scopes.delete(key);
    this.set({ ...this.state, scopes });
  }

  private setScope(key: string, scope: RulesScope): void {
    const scopes = new Map(this.state.scopes);
    scopes.set(key, scope);
    this.set({ ...this.state, scopes });
  }

  private set(next: RulesState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

export const rulesStore = new RulesStore();

export function useRulesState(): RulesState {
  return useSyncExternalStore(rulesStore.subscribe, rulesStore.getSnapshot);
}

/** The scope's rules and the spawn catalog, loading both on first use. */
export function useRulesScope(workspaceId: string | null): {
  scope: RulesScope | undefined;
  catalog: RulesCatalog | null;
} {
  const state = useRulesState();
  useEffect(() => {
    void rulesStore.load(workspaceId);
    void rulesStore.loadCatalog();
  }, [workspaceId]);
  return { scope: state.scopes.get(workspaceId ?? GLOBAL), catalog: state.catalog };
}

// ── deep link from the workspace menu ─────────────────────────────────

let requestedScope: string | null | undefined;

/** Open Settings on the Orchestration page with this workspace's override selected. */
export function openOrchestrationSettings(workspaceId: string | null): void {
  requestedScope = workspaceId;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "orchestration" }));
}

/** The scope a deep link asked for, consumed once. */
export function takeRequestedScope(): string | null | undefined {
  const scope = requestedScope;
  requestedScope = undefined;
  return scope;
}
