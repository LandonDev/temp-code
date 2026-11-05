import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOAD_DEADLINE_MS, NO_ANSWER } from "../connection/openRead";
import { scopeKey } from "./workspaces";
import type { Link } from "./store";
import type { ProviderInfo, ServerPush } from "./types";
import {
  DEFAULT_RULES,
  moveRoutingRule,
  patchModelPolicy,
  removeRoutingRule,
  rulesStore,
  staleModels,
  upsertRoutingRule,
  type OrchestrationRules,
  type RoutingRule,
  type RulesScope,
} from "./rules";

const rule = (over: Partial<RoutingRule> = {}): RoutingRule => ({
  id: "r1",
  task: "Bulk work",
  provider: "codex",
  model: "",
  reasoning: "medium",
  enabled: true,
  ...over,
});

const provider = (id: string): ProviderInfo =>
  ({ id, label: id, models: [], defaultModel: "", agentTypes: [] }) as unknown as ProviderInfo;

describe("pure helpers", () => {
  it("names the policies the catalog has no row for, under providers it lists", () => {
    const catalog = {
      claude: { ...provider("claude"), models: [{ id: "opus", label: "Opus", reasoning: [] }] },
      muse: provider("muse"),
    };
    const rules: OrchestrationRules = {
      ...DEFAULT_RULES,
      models: {
        "claude:opus": { approved: true },
        "claude:gone": { approved: true },
        "muse:muse-wonder-1.0": { approved: "orchestrators" },
        "nobody:x": { approved: true },
      },
    };
    expect(staleModels(rules, catalog)).toEqual([
      { provider: "claude", id: "gone" },
      { provider: "muse", id: "muse-wonder-1.0" },
    ]);
  });

  it("keeps Off as a decision and drops bounds back at the ladder's ends", () => {
    const denied = patchModelPolicy(DEFAULT_RULES, "claude", "claude-opus-5", { approved: false });
    // Off is written out: a probed row the rules lack would take its default.
    expect(denied.models["claude:claude-opus-5"]).toEqual({ approved: false });
    const bounded = patchModelPolicy(denied, "claude", "claude-opus-5", {
      approved: true,
      maxReasoning: "high",
    });
    expect(bounded.models["claude:claude-opus-5"]).toEqual({ approved: true, maxReasoning: "high" });
    const back = patchModelPolicy(bounded, "claude", "claude-opus-5", { maxReasoning: undefined });
    expect(back.models["claude:claude-opus-5"]).toEqual({ approved: true });
    // Orchestrators only is not the default: the record stays.
    const orchestrators = patchModelPolicy(DEFAULT_RULES, "claude", "claude-opus-5", { approved: "orchestrators" });
    expect(orchestrators.models["claude:claude-opus-5"]).toEqual({ approved: "orchestrators" });
    expect(patchModelPolicy(orchestrators, "claude", "claude-opus-5", { approved: true }).models["claude:claude-opus-5"]).toEqual({ approved: true });
    // The defaults list every catalog model, Fable orchestrators-only; Off is a row.
    expect(DEFAULT_RULES.models["claude:claude-fable-5-1"]).toEqual({ approved: "orchestrators" });
    expect(DEFAULT_RULES.models["claude:claude-sonnet-5-5"]).toEqual({ approved: true });
    expect(patchModelPolicy(DEFAULT_RULES, "claude", "claude-fable-5-1", { approved: false }).models["claude:claude-fable-5-1"]).toEqual({ approved: false });
  });

  it("upserts, removes and reorders routing rules without touching the input", () => {
    const base: OrchestrationRules = { ...DEFAULT_RULES, routing: [rule(), rule({ id: "r2" })] };
    const added = upsertRoutingRule(base, rule({ id: "r3", task: "Reviews" }));
    expect(added.routing.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const edited = upsertRoutingRule(added, rule({ id: "r2", task: "Edited" }));
    expect(edited.routing[1].task).toBe("Edited");
    expect(moveRoutingRule(edited, 2, 1).routing.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
    expect(moveRoutingRule(edited, 0, 2).routing.map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
    expect(moveRoutingRule(edited, 2, 0).routing.map((r) => r.id)).toEqual(["r3", "r1", "r2"]);
    expect(moveRoutingRule(edited, 1, 9).routing.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
    expect(moveRoutingRule(edited, 1, 1)).toBe(edited);
    expect(moveRoutingRule(edited, 5, 0)).toBe(edited);
    expect(removeRoutingRule(edited, "r1").routing.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(base.routing).toHaveLength(2);
  });
});

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  stored = new Map<string, OrchestrationRules>();
  /** rules.set refuses with this, as a host whose box is out of reach does. */
  refuse: string | null = null;
  home: RulesScope["home"] = undefined;
  /** The next rules.get is read now and answered once this resolves. */
  hold: Promise<void> | null = null;
  pushes = new Set<(push: ServerPush) => void>();
  /** Holds rules.get unanswered: the late answer is `release()`. */
  hang = false;
  release: () => void = () => {};
  /** Refuses rules.set, as the box does while it is offline. */
  refuseSet: string | null = null;
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const p = params as { workspaceId: string | null; rules?: OrchestrationRules | null };
    if (method === "rules.get" && this.hang) {
      return new Promise<T>((resolve) => (this.release = () => resolve({ rules: DEFAULT_RULES, overridden: false } as T)));
    }
    if (method === "rules.set" && this.refuseSet) return Promise.reject(new Error(this.refuseSet));
    if (method === "rules.get") {
      const own = this.stored.get(p.workspaceId ?? "");
      const scope: RulesScope = {
        rules: own ?? (p.workspaceId ? this.stored.get("") : undefined) ?? DEFAULT_RULES,
        overridden: own !== undefined,
        ...(this.home !== undefined ? { home: this.home } : {}),
      };
      const held = this.hold;
      this.hold = null;
      if (held) await held;
      return scope as T;
    }
    if (method === "rules.set" && this.refuse) throw new Error(this.refuse);
    if (method === "rules.set") {
      if (p.rules) this.stored.set(p.workspaceId ?? "", p.rules);
      else this.stored.delete(p.workspaceId ?? "");
      return Promise.resolve(null as T);
    }
    if (method === "catalog.get") {
      return Promise.resolve({ claude: provider("claude"), muse: provider("muse") } as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void) {
    this.pushes.add(l);
    return () => void this.pushes.delete(l);
  }
  push(push: ServerPush) {
    for (const l of this.pushes) l(push);
  }
  onOpen(_l: () => void) {
    return () => {};
  }
  onClose() {
    return () => {};
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

describe("rulesStore", () => {
  let link: FakeLink;
  beforeEach(() => {
    link = new FakeLink();
    rulesStore.reset();
    rulesStore.attach(link);
  });
  afterEach(() => rulesStore.reset());

  it("loads a scope once and caches it", async () => {
    const [a, b] = await Promise.all([rulesStore.load("local", null), rulesStore.load("local", null)]);
    expect(a).toBe(b);
    expect(link.of("rules.get")).toHaveLength(1);
    expect(rulesStore.scope("local", null)?.overridden).toBe(false);
    await rulesStore.load("local", null);
    expect(link.of("rules.get")).toHaveLength(1);
  });

  it("says the host did not answer past the deadline, and a late answer still lands", async () => {
    vi.useFakeTimers();
    try {
      link.hang = true;
      const load = rulesStore.load("local", null).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS);
      expect(await load).toBe(NO_ANSWER);
      expect(rulesStore.getSnapshot().errors.get(scopeKey("local", null))).toBe(NO_ANSWER);
      expect(rulesStore.scope("local", null)).toBeUndefined();
      // Retry shares the read in flight under a fresh deadline and clears the error meanwhile.
      void rulesStore.load("local", null).catch(() => {});
      expect(rulesStore.getSnapshot().errors.size).toBe(0);
      expect(link.of("rules.get")).toHaveLength(1);
      link.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(rulesStore.scope("local", null)?.overridden).toBe(false);
      expect(rulesStore.getSnapshot().errors.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves through and marks the scope overridden before the reply", async () => {
    await rulesStore.load("local", "w1");
    const next = { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, delegation: "free" as const } };
    const done = rulesStore.save("local", "w1", next);
    expect(rulesStore.scope("local", "w1")).toEqual({ rules: next, overridden: true });
    await done;
    expect(link.stored.get("w1")?.conduct.delegation).toBe("free");
  });

  it("a global save invalidates workspaces that inherit, not overrides", async () => {
    link.stored.set("w2", { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel: 2 } });
    await Promise.all([rulesStore.load("local", "w1"), rulesStore.load("local", "w2")]);
    await rulesStore.save("local", null, { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel: 8 } });
    expect(rulesStore.scope("local", "w1")).toBeUndefined();
    expect(rulesStore.scope("local", "w2")?.rules.conduct.maxParallel).toBe(2);
    expect((await rulesStore.load("local", "w1")).rules.conduct.maxParallel).toBe(8);
  });

  it("clear sends null and re-reads what applies", async () => {
    await rulesStore.save("local", "w1", DEFAULT_RULES);
    const scope = await rulesStore.clear("local", "w1");
    const sets = link.of("rules.set");
    expect(sets[sets.length - 1]?.params).toEqual({ workspaceId: "w1", rules: null });
    expect(scope.overridden).toBe(false);
    expect(rulesStore.scope("local", "w1")?.overridden).toBe(false);
  });

  it("a refused save puts back what stood, rejects with the host's reason and reads the home again", async () => {
    const before = await rulesStore.load("local", null);
    link.refuse = "refused: orchestration rules and thread defaults live on box; it is offline";
    link.home = { name: "box", online: false };
    const next = { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, selfEdit: true } };
    const done = rulesStore.save("local", null, next);
    expect(rulesStore.scope("local", null)?.rules).toBe(next);
    await expect(done).rejects.toThrow("live on box");
    expect(rulesStore.scope("local", null)?.rules).toBe(before.rules);
    await new Promise((r) => setTimeout(r, 0));
    expect(rulesStore.scope("local", null)?.home).toEqual({ name: "box", online: false });
  });

  it("a read sent before a write never lands over it", async () => {
    await rulesStore.load("local", null);
    let release!: () => void;
    link.hold = new Promise<void>((r) => (release = r));
    const stale = rulesStore.load("local", null, true);
    const next = { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel: 16 } };
    await rulesStore.save("local", null, next);
    release();
    await stale;
    expect(rulesStore.scope("local", null)?.rules.conduct.maxParallel).toBe(16);
  });

  it("a workspaces push from the host reads every loaded scope again", async () => {
    await Promise.all([rulesStore.load("local", null), rulesStore.load("local", "w1")]);
    link.stored.set("", { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, escalate: false } });
    link.push({ push: "workspaces", workspaces: [] } as unknown as ServerPush);
    await new Promise((r) => setTimeout(r, 0));
    expect(link.of("rules.get")).toHaveLength(4);
    expect(rulesStore.scope("local", null)?.rules.conduct.escalate).toBe(false);
    expect(rulesStore.scope("local", "w1")?.rules.conduct.escalate).toBe(false);
  });

  it("keeps every provider of the catalog, asks again only when fresh, and shares one request in flight", async () => {
    const catalog = await rulesStore.loadCatalog("local");
    expect(Object.keys(catalog)).toEqual(["claude", "muse"]);
    expect(rulesStore.getSnapshot().catalogs.get("local")).toBe(catalog);
    await rulesStore.loadCatalog("local");
    expect(link.of("catalog.get")).toHaveLength(1);
    await Promise.all([rulesStore.loadCatalog("local", true), rulesStore.loadCatalog("local", true)]);
    expect(link.of("catalog.get")).toHaveLength(2);
  });
});
