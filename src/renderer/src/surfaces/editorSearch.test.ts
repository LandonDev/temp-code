import { describe, expect, it } from "vitest";
import { isHiddenEditorHost } from "./editorSearch";
import { countLabel } from "./FindBar";

describe("isHiddenEditorHost", () => {
  it("treats FilePane's hidden inactive tabs as unusable", () => {
    expect(
      isHiddenEditorHost({
        closest: (selector) =>
          selector.includes(".hidden") &&
          selector.includes("[aria-hidden='true']")
            ? {}
            : null,
      }),
    ).toBe(true);
  });

  it("treats the markdown source overlay as unusable", () => {
    expect(
      isHiddenEditorHost({
        closest: (selector) => (selector.includes(".invisible") ? {} : null),
      }),
    ).toBe(true);
  });

  it("keeps a visible editor", () => {
    expect(isHiddenEditorHost({ closest: () => null })).toBe(false);
  });
});

describe("countLabel", () => {
  const at = (over: Partial<Parameters<typeof countLabel>[0]>) =>
    countLabel({ value: "foo", valid: true, current: 0, total: 0, capped: false, ...over });

  it("says nothing before there is a query", () => {
    expect(at({ value: "" })).toEqual({ text: "", state: "idle" });
  });

  it("names a broken regex and a query with no match", () => {
    expect(at({ valid: false })).toEqual({ text: "Invalid regex", state: "invalid" });
    expect(at({ total: 0 })).toEqual({ text: "No results", state: "empty" });
  });

  it("counts the match in view of the total, the total alone, and past the cap", () => {
    expect(at({ current: 2, total: 7 })).toEqual({ text: "2 of 7", state: "ok" });
    expect(at({ total: 7 })).toEqual({ text: "7", state: "ok" });
    expect(at({ total: 999, capped: true })).toEqual({ text: "999+", state: "ok" });
    expect(at({ current: 3, total: 999, capped: true })).toEqual({ text: "3 of 999+", state: "ok" });
  });
});
