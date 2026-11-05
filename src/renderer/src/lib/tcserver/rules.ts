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
import type { SettingsHome } from "../settingsHome";

/**
 * Orchestration rules, global with whole-object per-workspace overrides,
 * over the server's `rules.get` / `rules.set`. Every edit persists at once:
 * these are settings, not a document. The host's catalog rides along so the
 * editor lists every provider and every model it knows, the probed ones
 * included (spawn_agent reaches all of them).
 *
 * A shared scope's one copy lives on the box (remote/rulesSync.ts): the
 * answer names that host (`home`), a write the host refuses (the box out of
 * reach) rolls back to what stood, and a `workspaces` push from the host
 * (the box's edit followed here) reads every loaded scope again.
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
  /** Where the one copy lives when another host holds it; absent when it is this host's own. */
  home?: SettingsHome | null;
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
  private offPush = new Map<string, () => void>();
  /** Writes started per scope: a read sent before one never lands over it. */
  private writes = new Map<string, number>();

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
    this.offPush.get(link.environmentId)?.();
    // The host re-sends its workspaces when a rule or default changes there.
    const off = link.onPush?.((push) => {
      if (push.push === "workspaces") this.reload(link.environmentId);
    });
    if (off) this.offPush.set(link.environmentId, off);
  }

  detach(environmentId: string): void {
    this.links.delete(environmentId);
    this.offPush.get(environmentId)?.();
    this.offPush.delete(environmentId);
    const scopes = new Map([...this.state.scopes].filter(([key]) => !key.startsWith(`${environmentId}|`)));
    const catalogs = new Map(this.state.catalogs);
    catalogs.delete(environmentId);
    this.set({ scopes, catalogs });
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const off of this.offPush.values()) off();
    this.offPush.clear();
    this.writes.clear();
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

  /** Read a scope from its host once; later reads come from the cache.
   *  `fresh` asks again (the editor at each mount and when a host's link
   *  changes) while the last answer stays on screen. */
  load(environmentId: string, workspaceId: string | null, fresh = false): Promise<RulesScope> {
    const key = scopeKey(environmentId, workspaceId);
    const cached = this.state.scopes.get(key);
    if (cached && !fresh) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const link = this.links.get(environmentId);
    if (!link) return Promise.resolve(cached ?? { rules: DEFAULT_RULES, overridden: false });
    const before = this.writes.get(key) ?? 0;
    const request = link
      .request<RulesScope>("rules.get", { workspaceId })
      .then((scope) => {
        // A write went out after this read: its answer is older than the write.
        if ((this.writes.get(key) ?? 0) !== before) return this.state.scopes.get(key) ?? scope;
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

  /** Persist a scope's rules; the cache updates first so the editor never
   *  waits. A write the host refuses puts back what stood and rejects with
   *  the host's reason. */
  async save(environmentId: string, workspaceId: string | null, rules: OrchestrationRules): Promise<void> {
    const key = scopeKey(environmentId, workspaceId);
    const prev = this.state.scopes.get(key);
    const next: RulesScope = { rules, overridden: true, home: prev?.home };
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    this.setScope(key, next);
    const link = this.links.get(environmentId);
    if (!link) return;
    try {
      await link.request("rules.set", { workspaceId, rules });
    } catch (err) {
      if (this.state.scopes.get(key) === next) {
        const scopes = new Map(this.state.scopes);
        if (prev) scopes.set(key, prev);
        else scopes.delete(key);
        this.set({ ...this.state, scopes });
      }
      // The answer says where the copy lives and whether it answers now.
      void this.load(environmentId, workspaceId, true).catch(() => undefined);
      throw err;
    }
    if (workspaceId === null) this.dropInherited(environmentId);
  }

  /** Every loaded scope of a host, read again (its rules changed there). */
  private reload(environmentId: string): void {
    for (const key of this.state.scopes.keys()) {
      if (!key.startsWith(`${environmentId}|`)) continue;
      const workspaceId = key.slice(environmentId.length + 1) || null;
      void this.load(environmentId, workspaceId, true).catch(() => undefined);
    }
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
    void rulesStore.load(environmentId, workspaceId, freshCatalog).catch(() => undefined);
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
