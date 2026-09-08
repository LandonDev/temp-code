import { describe, expect, it } from "vitest";
import { RUNTIME_MODES } from "../session";
import { modeForPolicy, policyForMode } from "./access";

describe("access mapping", () => {
  it("maps every runtime mode to a policy and the three policies back", () => {
    const policies = RUNTIME_MODES.map(policyForMode);
    expect(policies).toEqual(["safe", "edits", "edits", "auto"]);
    for (const mode of RUNTIME_MODES) {
      if (mode === "auto") continue;
      expect(modeForPolicy(policyForMode(mode))).toBe(mode);
    }
  });

  it("the reviewed mode is the edits policy on purpose, never full access", () => {
    expect(policyForMode("auto")).toBe("edits");
    expect(modeForPolicy(policyForMode("auto"))).toBe("auto-accept-edits");
    expect(modeForPolicy("nope" as never)).toBe("supervised");
  });
});
