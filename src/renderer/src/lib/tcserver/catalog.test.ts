import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelId, modelsFor, resetHarnessModelOverlays, resolveModel } from "../models";
import {
  agentModelsFor,
  availabilityFromDoctor,
  probeDoctor,
  refreshCatalog,
  resetCatalogProbes,
} from "./catalog";
import { registry } from "../connection";
import type { Link } from "./store";
import type { ProviderInfo } from "./types";

const claude: ProviderInfo = {
  id: "claude",
  label: "Claude",
  defaultModel: "claude-sonnet-5-5",
  models: [
    { id: "claude-opus-5", label: "Opus 5", reasoning: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "medium", context: 1_000_000 },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", reasoning: ["low", "medium", "high"], defaultReasoning: "medium", context: 1_000_000 },
  ],
};
const cursor: ProviderInfo = {
  id: "cursor",
  label: "Cursor",
  defaultModel: "composer-2.5",
  models: [{ id: "composer-2.5", label: "Composer 2.5", reasoning: [] }],
};

function fakeLink(responses: Record<string, unknown>): Link & { calls: string[] } {
  const calls: string[] = [];
  const link: Link & { calls: string[] } = {
    environmentId: "local",
    profile: "local" as const,
    onClose: () => () => {},
    calls,
    connected: true,
    request<T>(method: string): Promise<T> {
      calls.push(method);
      return Promise.resolve(responses[method] as T);
    },
    onPush: () => () => {},
    onOpen: () => () => {},
  };
  vi.spyOn(registry, "linkOf").mockReturnValue(link as unknown as ReturnType<typeof registry.linkOf>);
  return link;
}

beforeEach(() => {
  resetCatalogProbes();
  resetHarnessModelOverlays();
});
afterEach(() => {
  resetHarnessModelOverlays();
  vi.restoreAllMocks();
});

describe("agentModelsFor", () => {
  it("maps models to picker ids with an effort select and claude toggles", () => {
    const models = agentModelsFor(claude);
    expect(models.map((m) => m.id)).toEqual(["claude:claude-opus-5", "claude:claude-sonnet-5-5"]);
    const opus = models[0];
    expect(opus.nativeId).toBe("claude-opus-5");
    expect(opus.contextWindow).toBe(1_000_000);
    expect(opus.settings?.map((s) => s.id)).toEqual(["effort", "context", "fast"]);
    expect(opus.settings?.[0]).toMatchObject({ value: "medium", kind: "select" });
    expect(opus.settings?.[0].options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1].settings?.map((s) => s.id)).toEqual(["effort", "context"]);
  });

  it("a model without reasoning has no effort setting", () => {
    expect(agentModelsFor(cursor)[0].settings).toBeUndefined();
  });

  it("codex gets Ultrafast beside Fast only when the probed tiers list it; unprobed rows just get Fast", () => {
    const codex: ProviderInfo = {
      id: "codex",
      label: "Codex",
      defaultModel: "gpt-5.6-sol",
      models: [
        { id: "gpt-6-astra", label: "Astra", reasoning: [], speedTiers: ["priority", "ultrafast"] },
        { id: "gpt-5.6-sol", label: "Sol", reasoning: [], speedTiers: ["priority"] },
        { id: "gpt-6-sol", label: "Sol 6", reasoning: [] },
      ],
    };
    const [astra, sol, sol6] = agentModelsFor(codex);
    expect(astra.settings?.map((s) => s.id)).toEqual(["fast", "ultrafast"]);
    expect(astra.settings?.[1]).toMatchObject({ kind: "toggle", value: "false", label: "Ultrafast" });
    expect(sol.settings?.map((s) => s.id)).toEqual(["fast"]);
    expect(sol.settings?.[0].description).toContain("Ultrafast is not on this account");
    expect(sol6.settings?.map((s) => s.id)).toEqual(["fast"]);
    expect(sol6.settings?.[0].description).toBe("Fast (priority processing)");
  });
});

describe("refreshCatalog", () => {
  it("overlays every provider and resolves native ids", async () => {
    const link = fakeLink({ "catalog.get": { claude, cursor } });
    await Promise.all([refreshCatalog("local"), refreshCatalog("local")]);
    expect(link.calls).toEqual(["catalog.get"]);
    expect(modelsFor("claude").map((m) => m.id)).toEqual(["claude:claude-opus-5", "claude:claude-sonnet-5-5"]);
    expect(resolveModel("claude", "claude-opus-5").id).toBe("claude:claude-opus-5");
    expect(modelsFor("cursor")[0].id).toBe("cursor:composer-2.5");
  });
});

describe("probeDoctor", () => {
  it("caches for the TTL and force bypasses it", async () => {
    const link = fakeLink({ "doctor.get": { claude: { found: true }, codex: { found: false }, cursor: { found: true, error: "x" } } });
    const first = await probeDoctor("local");
    await probeDoctor("local");
    expect(link.calls).toHaveLength(1);
    await probeDoctor("local", { force: true });
    expect(link.calls).toHaveLength(2);
    expect(availabilityFromDoctor(first)).toMatchObject({ claude: true, codex: false, cursor: true, fx: false, grok: false });
  });
});

describe("provider defaults", () => {
  it("the catalog's defaultModel becomes the picker default, not the first entry", async () => {
    const codex: ProviderInfo = {
      id: "codex",
      label: "Codex",
      defaultModel: "gpt-5.6-sol",
      models: [
        { id: "gpt-6-astra", label: "Astra", reasoning: ["low", "high"] },
        { id: "gpt-5.6-sol", label: "Sol", reasoning: ["low", "high"] },
      ],
    };
    fakeLink({ "catalog.get": { codex, claude } });
    await refreshCatalog("local");
    expect(defaultModelId("codex")).toBe("codex:gpt-5.6-sol");
    expect(defaultModelId("claude")).toBe("claude:claude-sonnet-5-5");
  });
});
