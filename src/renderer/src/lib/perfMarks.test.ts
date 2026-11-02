import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("perfMark retention", () => {
  it.each([true, false])("bounds 1,000 marks with repeated names: %s, and delivers every mark", async (repeated) => {
    vi.resetModules();
    let marks = ["other:keep"];
    const mark = vi.fn((name: string) => marks.push(name));
    const clearMarks = vi.fn((name: string) => { marks = marks.filter((m) => m !== name); });
    const getEntriesByType = vi.fn(() => marks.map((name) => ({ name })));
    vi.stubGlobal("performance", { mark, clearMarks, getEntriesByType });
    const { perfMark, onPerfMark } = await import("./perfMarks");
    const hear = vi.fn();
    const off = onPerfMark(hear);
    for (let i = 0; i < 1_000; i++) {
      perfMark(repeated ? `stage-${i % 7}` : `stage-${i}`, "s1");
      expect(marks.filter((name) => name.startsWith("tc:")).length).toBeLessThanOrEqual(200);
    }
    expect(hear).toHaveBeenCalledTimes(1_000);
    expect(hear).toHaveBeenLastCalledWith(repeated ? "stage-5" : "stage-999", "s1");
    expect(marks).toContain("other:keep");
    expect(getEntriesByType).not.toHaveBeenCalled();
    off();
    perfMark("after");
    expect(hear).toHaveBeenCalledTimes(1_000);
  });
})
