import { useEffect, useSyncExternalStore } from "react";
import {
  approvedLadder,
  DEFAULT_RULES,
  mergeThreadRules,
  modelApproved,
  modelKey,
  sliceLadder,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
} from "@server/shared/rules";
import { OPEN_SETTINGS_EVENT } from "../monaco/debugTab";
import type { Link } from "../connection";
import { scopeKey } from "./workspaces";
import type { ProviderId, ProviderInfo } from "./types";

/**
 * Orchestration rules, global with whole-object per-workspace overrides,
 * over the server's `rules.get` / `rules.set`. Every edit persists at once:
 * these are settings, not a document. The host's catalog rides along so the
 * editor lists every provider and every model it knows, the probed ones
 * included (spawn_agent reaches all of them).
 */

export {
  approvedLadder,
  DEFAULT_RULES,
  mergeThreadRules,
  modelApproved,
  modelKey,
  sliceLadder,
  type ModelPolicy,
  type OrchestrationRules,
  type RoutingRule,
};


export type RulesScope = {
  /** What applies here: override, else global, else the defaults. */
  rules: OrchestrationRules;
  /** Whether this scope holds its own copy. */
  overridden: boolean;
};

/** A host's `catalog.get`: every provider, in the catalog's order. */
export type RulesCatalog = Partial<Record<ProviderId, ProviderInfo>>;

export type RulesState = {
  /** Keyed by workspace id, "" for global; absent until loaded. */
  scopes: ReadonlyMap<string, RulesScope>;
  /** Each host's catalog, by environment id; absent until it answers. */
  catalogs: ReadonlyMap<string, RulesCatalog>;
};

const EMPTY: RulesState = { scopes: new Map(), catalogs: new Map() };

// ── pure helpers ───────────────────────────────────────────────────────

/** Every model policy key the rules name that the catalog has no row for,
 *  under a provider the catalog lists: a saved policy for a model this host
 *  does not serve (a probed row another host has, a retired model), shown
 *  muted so it is never dropped unseen. In the rules' own order. */
export function staleModels(rules: OrchestrationRules, catalog: RulesCatalog): { provider: ProviderId; id: string }[] {
  const out: { provider: ProviderId; id: string }[] = [];
  for (const key of Object.keys(rules.models)) {
    const at = key.indexOf(":");
    const provider = key.slice(0, at) as ProviderId;
    const id = key.slice(at + 1);
    const info = catalog[provider];
    if (info && !info.models.some((m) => m.id === id)) out.push({ provider, id });
  }
  return out;
}

/** A model's policy patched. Off is written as `approved: false`, never
 *  dropped: a probed row the rules lack takes its default
 *  (`withProbedDefaults`), so absence would turn it back on. */
export function patchModelPolicy(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  patch: Partial<ModelPolicy>,
): OrchestrationRules {
  const key = modelKey(provider, modelId);
  const prev: ModelPolicy = rules.models[key] ?? { approved: false };
  const next: ModelPolicy = { ...prev, ...patch };
  if (!next.minReasoning) delete next.minReasoning;
  if (!next.maxReasoning) delete next.maxReasoning;
  return { ...rules, models: { ...rules.models, [key]: next } };
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

/** Move the rule at `from` to `to` (both clamped to the list); the others keep their order. */
export function moveRoutingRule(rules: OrchestrationRules, from: number, to: number): OrchestrationRules {
  const last = rules.routing.length - 1;
  const target = Math.max(0, Math.min(to, last));
  if (from < 0 || from > last || from === target) return rules;
  const routing = [...rules.routing];
  const [rule] = routing.splice(from, 1);
  routing.splice(target, 0, rule);
  return { ...rules, routing };
}

export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── store ──────────────────────────────────────────────────────────────

class RulesStore {
  private state: RulesState = EMPTY;
  private listeners = new Set<() => void>();
  private links = new Map<string, Link>();
  private offRegistry: (() => void) | null = null;
  private inflight = new Map<string, Promise<RulesScope>>();
  private catalogInflight = new Map<string, Promise<RulesCatalog>>();

  /** Follow the registry: rules and the spawn catalog are per environment. */
  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): void {
    this.offRegistry?.();
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  attach(link: Link): void {
    this.links.set(link.environmentId, link);
  }

  detach(environmentId: string): void {
    this.links.delete(environmentId);
    const scopes = new Map([...this.state.scopes].filter(([key]) => !key.startsWith(`${environmentId}|`)));
    const catalogs = new Map(this.state.catalogs);
    catalogs.delete(environmentId);
    this.set({ scopes, catalogs });
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    this.links.clear();
    this.catalogInflight.clear();
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

  scope(environmentId: string, workspaceId: string | null): RulesScope | undefined {
    return this.state.scopes.get(scopeKey(environmentId, workspaceId));
  }

  /** Read a scope from its host once; later reads come from the cache. */
  load(environmentId: string, workspaceId: string | null): Promise<RulesScope> {
    const key = scopeKey(environmentId, workspaceId);
    const cached = this.state.scopes.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const link = this.links.get(environmentId);
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

  /** One environment's catalog, once; `fresh` asks again (the rules editor
   *  at each mount: the probed rows land after boot, Muse Code's once it is
   *  signed in) while the last answer stays on screen. Concurrent asks share
   *  one request. */
  loadCatalog(environmentId: string, fresh = false): Promise<RulesCatalog> {
    const cached = this.state.catalogs.get(environmentId);
    if (cached && !fresh) return Promise.resolve(cached);
    const pending = this.catalogInflight.get(environmentId);
    if (pending) return pending;
    const link = this.links.get(environmentId);
    if (!link) return Promise.resolve(this.state.catalogs.get(environmentId) ?? {});
    const request = link
      .request<RulesCatalog>("catalog.get")
      .then((catalog) => {
        const catalogs = new Map(this.state.catalogs);
        catalogs.set(environmentId, catalog);
        this.set({ ...this.state, catalogs });
        return catalog;
      })
      .finally(() => this.catalogInflight.delete(environmentId));
    this.catalogInflight.set(environmentId, request);
    return request;
  }

  /** Persist a scope's rules; the cache updates first so the editor never waits. */
  save(environmentId: string, workspaceId: string | null, rules: OrchestrationRules): Promise<void> {
    const key = scopeKey(environmentId, workspaceId);
    this.setScope(key, { rules, overridden: true });
    if (workspaceId === null) this.dropInherited(environmentId);
    return (
      this.links.get(environmentId)?.request("rules.set", { workspaceId, rules }).then(() => undefined) ??
      Promise.resolve()
    );
  }

  /** Clear a scope: global goes back to the defaults, an override goes away. */
  async clear(environmentId: string, workspaceId: string | null): Promise<RulesScope> {
    const key = scopeKey(environmentId, workspaceId);
    await this.links.get(environmentId)?.request("rules.set", { workspaceId, rules: null });
    const scopes = new Map(this.state.scopes);
    scopes.delete(key);
    this.set({ ...this.state, scopes });
    if (workspaceId === null) this.dropInherited(environmentId);
    return this.load(environmentId, workspaceId);
  }

  /** Workspaces without an override mirror their host's global rules;
   *  forget them so the next read picks the new global copy up. */
  private dropInherited(environmentId: string): void {
    const globalKey = scopeKey(environmentId, null);
    const scopes = new Map(this.state.scopes);
    for (const [key, scope] of scopes)
      if (key !== globalKey && key.startsWith(`${environmentId}|`) && !scope.overridden) scopes.delete(key);
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

/** The scope's rules and its host's catalog, loading both on first use;
 *  `freshCatalog` asks the host's catalog again at mount. */
export function useRulesScope(
  environmentId: string,
  workspaceId: string | null,
  freshCatalog = false,
): {
  scope: RulesScope | undefined;
  catalog: RulesCatalog | null;
} {
  const state = useRulesState();
  useEffect(() => {
    void rulesStore.load(environmentId, workspaceId);
    void rulesStore.loadCatalog(environmentId, freshCatalog);
  }, [environmentId, workspaceId, freshCatalog]);
  return {
    scope: state.scopes.get(scopeKey(environmentId, workspaceId)),
    catalog: state.catalogs.get(environmentId) ?? null,
  };
}

// ── deep link from the workspace menu ─────────────────────────────────

let requestedFocus = false;

/** Open Settings on the global rules, or on a workspace's page with its
 *  orchestration sections in view. */
export function openOrchestrationSettings(workspaceId: string | null): void {
  requestedFocus = workspaceId !== null;
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, { detail: workspaceId === null ? "orchestration" : `ws:${workspaceId}` }),
  );
}

/** Whether a deep link asked for a workspace's orchestration sections, consumed once. */
export function takeRequestedRulesFocus(): boolean {
  const focus = requestedFocus;
  requestedFocus = false;
  return focus;
}
