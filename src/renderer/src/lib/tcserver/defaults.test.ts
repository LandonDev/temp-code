import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels } from "../models";
import { agentModelsFor } from "./catalog";
import type { ProviderInfo } from "./types";
import {
  BUILT_IN_SCOPE,
  clampReasoning,
  coerceDefaults,
  draftFromDefaults,
  effortLadder,
  modelForDefaults,
  normalizeDefaults,
  parseDefaultsScope,
  storedModelId,
} from "./defaults";

const claude: ProviderInfo = {
  id: "claude",
  label: "Claude",
  defaultModel: "claude-sonnet-5-5",
  models: [
    { id: "claude-opus-5", label: "Opus 5", reasoning: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "high" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" },
  ],
};
const cursor: ProviderInfo = {
  id: "cursor",
  label: "Cursor",
  defaultModel: "composer-2.5",
  models: [{ id: "composer-2.5", label: "Composer 2.5", reasoning: [] }],
};

const live = () => {
  setHarnessModels("claude", agentModelsFor(claude), claude.defaultModel);
  setHarnessModels("cursor", agentModelsFor(cursor), cursor.defaultModel);
};

afterEach(() => resetHarnessModelOverlays());

describe("parseDefaultsScope", () => {
  it("reads the {defaults, overridden} wrapper the server sends", () => {
    const scope = parseDefaultsScope({
      defaults: { provider: "codex", model: "gpt-6-astra", reasoning: "high", permission: "auto" },
      overridden: true,
    });
    expect(scope).toEqual({
      defaults: { provider: "codex", model: "gpt-6-astra", reasoning: "high", permission: "auto" },
      overridden: true,
    });
  });

  it("an inherited scope keeps the effective set but no override bit", () => {
    const scope = parseDefaultsScope({ defaults: { provider: "claude", model: "", reasoning: "low", permission: "safe" }, overridden: false });
    expect(scope.overridden).toBe(false);
    expect(scope.defaults.reasoning).toBe("low");
  });

  it("a bare set (older server) counts as stored; null is the built-in set", () => {
    expect(parseDefaultsScope({ provider: "claude", model: "", reasoning: "max", permission: "edits" })).toEqual({
      defaults: { provider: "claude", model: "", reasoning: "max", permission: "edits" },
      overridden: true,
    });
    expect(parseDefaultsScope(null)).toBe(BUILT_IN_SCOPE);
    expect(parseDefaultsScope(undefined)).toBe(BUILT_IN_SCOPE);
  });

  it("bad fields fall back one at a time", () => {
    expect(coerceDefaults({ provider: "nope", model: 3, reasoning: "warp", permission: "auto" })).toEqual({
      provider: "claude",
      model: "",
      reasoning: "medium",
      permission: "auto",
    });
  });
});

describe("effort ladders", () => {
  it("come from the model's catalog entry", () => {
    live();
    const opus = modelForDefaults({ provider: "claude", model: "claude-opus-5" });
    expect(effortLadder(opus)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLadder(modelForDefaults({ provider: "cursor", model: "" }))).toEqual([]);
  });

  it("an empty model means the provider default", () => {
    live();
    expect(modelForDefaults({ provider: "claude", model: "" }).nativeId).toBe("claude-sonnet-5-5");
    expect(storedModelId({ provider: "claude", model: "", reasoning: "low", permission: "safe" })).toBe("");
    expect(storedModelId({ provider: "claude", model: "claude-opus-5", reasoning: "low", permission: "safe" })).toBe("claude-opus-5");
  });

  it("clamps an effort off the ladder to the model's own default", () => {
    live();
    const sonnet = modelForDefaults({ provider: "claude", model: "claude-sonnet-5-5" });
    expect(clampReasoning(sonnet, "high")).toBe("high");
    expect(clampReasoning(sonnet, "ultra")).toBe("medium");
    const opus = modelForDefaults({ provider: "claude", model: "claude-opus-5" });
    expect(clampReasoning(opus, "ultra")).toBe("high");
    // No ladder: nothing to clamp against.
    expect(clampReasoning(modelForDefaults({ provider: "cursor", model: "" }), "ultra")).toBe("ultra");
  });

  it("normalizeDefaults returns the same object when nothing changes", () => {
    live();
    const d = { provider: "claude" as const, model: "claude-sonnet-5-5", reasoning: "low" as const, permission: "edits" as const };
    expect(normalizeDefaults(d)).toBe(d);
    expect(normalizeDefaults({ ...d, reasoning: "max" }).reasoning).toBe("medium");
  });
});

describe("draftFromDefaults", () => {
  it("seeds harness, picker model id, access mode and effort", () => {
    live();
    expect(draftFromDefaults({ provider: "claude", model: "claude-opus-5", reasoning: "xhigh", permission: "auto" })).toEqual({
      harness: "claude",
      model: "claude:claude-opus-5",
      runtimeMode: "full-access",
      modelSettings: { effort: "xhigh" },
    });
  });

  it("leaves the model open for the provider default and clamps the effort", () => {
    live();
    const seed = draftFromDefaults({ provider: "claude", model: "", reasoning: "max", permission: "safe" });
    expect(seed.model).toBeUndefined();
    expect(seed.runtimeMode).toBe("supervised");
    expect(seed.modelSettings).toEqual({ effort: "medium" });
  });

  it("seeds a research thread on claude when the default provider is another, keeping the access mode", () => {
    live();
    const seed = draftFromDefaults({ provider: "cursor", model: "composer-2.5", reasoning: "high", permission: "edits" }, "research");
    expect(seed.harness).toBe("claude");
    expect(seed.model).toBeUndefined();
    expect(seed.runtimeMode).toBe("auto-accept-edits");
    expect(seed.modelSettings).toEqual({ effort: "high" });
    // Other thread types keep the default provider; a claude default is untouched.
    expect(draftFromDefaults({ provider: "cursor", model: "", reasoning: "high", permission: "edits" }, "chat").harness).toBe("cursor");
    expect(
      draftFromDefaults({ provider: "claude", model: "claude-opus-5", reasoning: "high", permission: "edits" }, "research").model,
    ).toBe("claude:claude-opus-5");
  });
});
