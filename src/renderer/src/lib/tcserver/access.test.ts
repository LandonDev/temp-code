import { describe, expect, it } from "vitest";
import { RUNTIME_MODES } from "../session";
import { modeForPolicy, policyForMode } from "./access";

describe("access mapping", () => {
  // temp-code's server has three policies; the AI-reviewed `auto` mode runs
  // as `edits` until M4 maps access explicitly, so it does not round-trip.
  it("maps every runtime mode to a policy and the three policies back", () => {
    const policies = RUNTIME_MODES.map(policyForMode);
    expect(policies).toEqual(["safe", "edits", "edits", "auto"]);
    for (const mode of RUNTIME_MODES) {
      if (mode === "auto") continue;
      expect(modeForPolicy(policyForMode(mode))).toBe(mode);
    }
  });
});
