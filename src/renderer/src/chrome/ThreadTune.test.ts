import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@server/shared/rules";
import { isEmptyTune, normalizeTune, setConduct } from "./ThreadTune";

const base = DEFAULT_RULES.conduct;

describe("ThreadTune model", () => {
  it("drops a key set back to the base and nulls an empty tune", () => {
    const on = setConduct({}, base, "selfEdit", !base.selfEdit);
    expect(on.conduct).toEqual({ selfEdit: !base.selfEdit });
    const off = setConduct(on, base, "selfEdit", base.selfEdit);
    expect(off.conduct).toBeUndefined();
    expect(isEmptyTune(off)).toBe(true);
    expect(normalizeTune({ instructions: "  " })).toBeNull();
    expect(normalizeTune({ instructions: " go ", conduct: {} })).toEqual({ instructions: "go" });
  });
});
