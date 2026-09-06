import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const mod = await import("./breakpoints");
const state = await import("./editorState");

describe("breakpoints", () => {
  beforeEach(() => {
    store.clear();
    mod.loadBreakpoints();
  });

  it("toggles a line on and off and persists", () => {
    expect(mod.toggleBreakpoint("/p/A.java", 4)).toBe(true);
    expect(mod.toggleBreakpoint("/p/A.java", 2)).toBe(true);
    expect(mod.breakpointLines("/p/A.java")).toEqual([2, 4]);
    expect(JSON.parse(store.get("monocode.debug.breakpoints")!)).toEqual({ "/p/A.java": [4, 2] });
    expect(mod.toggleBreakpoint("/p/A.java", 4)).toBe(false);
    expect(mod.breakpointLines("/p/A.java")).toEqual([2]);
  });

  it("drops empty files and mirrors into the editor state", () => {
    mod.toggleBreakpoint("/p/B.java", 1);
    mod.toggleBreakpoint("/p/B.java", 1);
    expect(mod.breakpointPaths()).toEqual([]);
    expect(state.getEditorState().debugBreakpoints).toEqual({});
  });

  it("reloads what was saved", () => {
    store.set("monocode.debug.breakpoints", JSON.stringify({ "/p/C.java": [9, 3] }));
    mod.loadBreakpoints();
    expect(mod.breakpointLines("/p/C.java")).toEqual([3, 9]);
    expect(state.getEditorState().debugBreakpoints).toEqual({ "/p/C.java": [3, 9] });
  });
});
