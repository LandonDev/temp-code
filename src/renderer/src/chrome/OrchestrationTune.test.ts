import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@server/shared/rules";
import { setConduct, tuneIsSet, tuneSummary } from "./OrchestrationTune";

const base = DEFAULT_RULES.conduct;

describe("setConduct", () => {
  it("records an override and drops it again at the default", () => {
    const other = base.delegation === "free" ? "strict" : "free";
    const one = setConduct({}, base, "delegation", other);
    expect(one.conduct).toEqual({ delegation: other });
    const back = setConduct(one, base, "delegation", base.delegation);
    expect(back.conduct).toBeUndefined();
  });

  it("keeps other overrides and the instructions", () => {
    const t = setConduct({ instructions: "go", conduct: { maxParallel: 2 } }, base, "selfEdit", !base.selfEdit);
    expect(t).toEqual({ instructions: "go", conduct: { maxParallel: 2, selfEdit: !base.selfEdit } });
  });
});

describe("tuneSummary", () => {
  it("counts overrides and notes instructions", () => {
    expect(tuneSummary({})).toBeNull();
    expect(tuneSummary({ conduct: { maxParallel: 2 } })).toBe("1 override");
    expect(tuneSummary({ conduct: { maxParallel: 2, selfEdit: false }, instructions: "x" })).toBe(
      "2 overrides + instructions",
    );
    expect(tuneIsSet({ instructions: "  " })).toBe(false);
    expect(tuneIsSet({ conduct: { escalate: true } })).toBe(true);
  });
});
