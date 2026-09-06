import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Link } from "./store";
import type { ProviderInfo, ServerPush } from "./types";
import {
  DEFAULT_RULES,
  moveRoutingRuleUp,
  patchModelPolicy,
  removeRoutingRule,
  rulesStore,
  spawnCatalog,
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
  it("keeps only the spawn providers, in order", () => {
    const catalog = spawnCatalog({
      grok: provider("grok"),
      cursor: provider("cursor"),
      claude: provider("claude"),
    });
    expect(Object.keys(catalog)).toEqual(["claude", "cursor"]);
  });

  it("drops a model policy once it is back at its default", () => {
    const denied = patchModelPolicy(DEFAULT_RULES, "claude", "claude-opus-5", { approved: false });
    expect(denied.models["claude:claude-opus-5"]).toEqual({ approved: false });
    const bounded = patchModelPolicy(denied, "claude", "claude-opus-5", {
      approved: true,
      maxReasoning: "high",
    });
    expect(bounded.models["claude:claude-opus-5"]).toEqual({ approved: true, maxReasoning: "high" });
    const back = patchModelPolicy(bounded, "claude", "claude-opus-5", { maxReasoning: undefined });
    expect(back.models).toEqual({});
    expect(DEFAULT_RULES.models).toEqual({});
  });

  it("upserts, removes and reorders routing rules without touching the input", () => {
    const base: OrchestrationRules = { ...DEFAULT_RULES, routing: [rule(), rule({ id: "r2" })] };
    const added = upsertRoutingRule(base, rule({ id: "r3", task: "Reviews" }));
    expect(added.routing.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const edited = upsertRoutingRule(added, rule({ id: "r2", task: "Edited" }));
    expect(edited.routing[1].task).toBe("Edited");
    expect(moveRoutingRuleUp(edited, 2).routing.map((r) => r.id)).toEqual(["r1", "r3", "r2"]);
    expect(moveRoutingRuleUp(edited, 0)).toBe(edited);
    expect(removeRoutingRule(edited, "r1").routing.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(base.routing).toHaveLength(2);
  });
});

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  stored = new Map<string, OrchestrationRules>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const p = params as { workspaceId: string | null; rules?: OrchestrationRules | null };
    if (method === "rules.get") {
      const own = this.stored.get(p.workspaceId ?? "");
      const scope: RulesScope = {
        rules: own ?? (p.workspaceId ? this.stored.get("") : undefined) ?? DEFAULT_RULES,
        overridden: own !== undefined,
      };
      return Promise.resolve(scope as T);
    }
    if (method === "rules.set") {
      if (p.rules) this.stored.set(p.workspaceId ?? "", p.rules);
      else this.stored.delete(p.workspaceId ?? "");
      return Promise.resolve(null as T);
    }
    if (method === "catalog.get") {
      return Promise.resolve({ claude: provider("claude"), pi: provider("pi") } as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  onOpen(_l: () => void) {
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
    rulesStore.connect(link);
  });
  afterEach(() => rulesStore.reset());

  it("loads a scope once and caches it", async () => {
    const [a, b] = await Promise.all([rulesStore.load(null), rulesStore.load(null)]);
    expect(a).toBe(b);
    expect(link.of("rules.get")).toHaveLength(1);
    expect(rulesStore.scope(null)?.overridden).toBe(false);
    await rulesStore.load(null);
    expect(link.of("rules.get")).toHaveLength(1);
  });

  it("saves through and marks the scope overridden before the reply", async () => {
    await rulesStore.load("w1");
    const next = { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, delegation: "free" as const } };
    const done = rulesStore.save("w1", next);
    expect(rulesStore.scope("w1")).toEqual({ rules: next, overridden: true });
    await done;
    expect(link.stored.get("w1")?.conduct.delegation).toBe("free");
  });

  it("a global save invalidates workspaces that inherit, not overrides", async () => {
    link.stored.set("w2", { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel: 2 } });
    await Promise.all([rulesStore.load("w1"), rulesStore.load("w2")]);
    await rulesStore.save(null, { ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel: 8 } });
    expect(rulesStore.scope("w1")).toBeUndefined();
    expect(rulesStore.scope("w2")?.rules.conduct.maxParallel).toBe(2);
    expect((await rulesStore.load("w1")).rules.conduct.maxParallel).toBe(8);
  });

  it("clear sends null and re-reads what applies", async () => {
    await rulesStore.save("w1", DEFAULT_RULES);
    const scope = await rulesStore.clear("w1");
    const sets = link.of("rules.set");
    expect(sets[sets.length - 1]?.params).toEqual({ workspaceId: "w1", rules: null });
    expect(scope.overridden).toBe(false);
    expect(rulesStore.scope("w1")?.overridden).toBe(false);
  });

  it("keeps only spawn providers from the catalog", async () => {
    const catalog = await rulesStore.loadCatalog();
    expect(Object.keys(catalog)).toEqual(["claude"]);
    await rulesStore.loadCatalog();
    expect(link.of("catalog.get")).toHaveLength(1);
  });
});
