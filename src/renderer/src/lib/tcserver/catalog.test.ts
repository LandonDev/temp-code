import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultModelId, modelsFor, resetHarnessModelOverlays, resolveModel } from "../models";
import {
  agentModelsFor,
  availabilityFromDoctor,
  probeDoctor,
  refreshCatalog,
  resetCatalogProbes,
} from "./catalog";
import type { Link } from "./store";
import type { ProviderInfo } from "./types";

const claude: ProviderInfo = {
  id: "claude",
  label: "Claude",
  defaultModel: "claude-sonnet-5",
  models: [
    { id: "claude-opus-5", label: "Opus 5", reasoning: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "medium", context: 1_000_000 },
    { id: "claude-sonnet-5", label: "Sonnet 5", reasoning: ["low", "medium", "high"], defaultReasoning: "medium", context: 1_000_000 },
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
  return {
    calls,
    connected: true,
    request<T>(method: string): Promise<T> {
      calls.push(method);
      return Promise.resolve(responses[method] as T);
    },
    onPush: () => () => {},
    onOpen: () => () => {},
  };
}

beforeEach(() => {
  resetCatalogProbes();
  resetHarnessModelOverlays();
});
afterEach(() => resetHarnessModelOverlays());

describe("agentModelsFor", () => {
  it("maps models to picker ids with an effort select and claude toggles", () => {
    const models = agentModelsFor(claude);
    expect(models.map((m) => m.id)).toEqual(["claude:claude-opus-5", "claude:claude-sonnet-5"]);
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
});

describe("refreshCatalog", () => {
  it("overlays every provider and resolves native ids", async () => {
    const link = fakeLink({ "catalog.get": { claude, cursor } });
    await Promise.all([refreshCatalog(link), refreshCatalog(link)]);
    expect(link.calls).toEqual(["catalog.get"]);
    expect(modelsFor("claude").map((m) => m.id)).toEqual(["claude:claude-opus-5", "claude:claude-sonnet-5"]);
    expect(resolveModel("claude", "claude-opus-5").id).toBe("claude:claude-opus-5");
    expect(modelsFor("cursor")[0].id).toBe("cursor:composer-2.5");
  });
});

describe("probeDoctor", () => {
  it("caches for the TTL and force bypasses it", async () => {
    const link = fakeLink({ "doctor.get": { claude: { found: true }, codex: { found: false }, cursor: { found: true, error: "x" } } });
    const first = await probeDoctor(undefined, link);
    await probeDoctor(undefined, link);
    expect(link.calls).toHaveLength(1);
    await probeDoctor({ force: true }, link);
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
    await refreshCatalog(fakeLink({ "catalog.get": { codex, claude } }));
    expect(defaultModelId("codex")).toBe("codex:gpt-5.6-sol");
    expect(defaultModelId("claude")).toBe("claude:claude-sonnet-5");
  });
});
