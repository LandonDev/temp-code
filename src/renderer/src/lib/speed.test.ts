import { describe, expect, it } from "vitest";
import type { ModelSetting } from "./models";
import { speedChoices, speedOf, withSpeed } from "./speed";

const toggle = (id: string, label: string): ModelSetting => ({
  id,
  label,
  kind: "toggle",
  value: "false",
  options: [
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ],
});
const effort: ModelSetting = { id: "effort", label: "Effort", kind: "select", value: "high", options: [{ value: "high", label: "High" }] };

describe("speed", () => {
  it("offers nothing without a tier, else Standard and each tier by its name", () => {
    expect(speedChoices([effort])).toEqual([]);
    expect(speedChoices([effort, toggle("fast", "Fast")]).map((c) => c.label)).toEqual(["Standard", "Fast"]);
    expect(speedChoices([toggle("fast", "Fast"), toggle("ultrafast", "Ultrafast")]).map((c) => c.value)).toEqual([
      "standard",
      "fast",
      "ultrafast",
    ]);
  });

  it("reads the stored tier, Ultrafast over a stale Fast", () => {
    expect(speedOf({})).toBe("standard");
    expect(speedOf({ fast: "true" })).toBe("fast");
    expect(speedOf({ fast: "true", ultrafast: "true" })).toBe("ultrafast");
  });

  it("one tier on turns the other off, and only offered tiers are written", () => {
    const both = speedChoices([toggle("fast", "Fast"), toggle("ultrafast", "Ultrafast")]);
    expect(withSpeed({ fast: "true", effort: "high" }, "ultrafast", both)).toEqual({ fast: "false", ultrafast: "true", effort: "high" });
    expect(withSpeed({ ultrafast: "true" }, "standard", both)).toEqual({ fast: "false", ultrafast: "false" });
    const fastOnly = speedChoices([toggle("fast", "Fast")]);
    expect(withSpeed({}, "fast", fastOnly)).toEqual({ fast: "true" });
  });
});
