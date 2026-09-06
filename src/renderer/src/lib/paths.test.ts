import { describe, expect, it } from "vitest";
import { parseFileHref, resolveWorkspacePath } from "./paths";

describe("parseFileHref", () => {
  it("reads :line, :line:col and #L suffixes before resolving", () => {
    expect(parseFileHref("src/App.tsx:42", "/repo")).toEqual({ path: "/repo/src/App.tsx", line: 42 });
    expect(parseFileHref("src/App.tsx:42:7", "/repo")).toEqual({
      path: "/repo/src/App.tsx",
      line: 42,
      column: 7,
    });
    expect(parseFileHref("/abs/Main.java#L10-L20")).toEqual({ path: "/abs/Main.java", line: 10 });
    expect(parseFileHref("file:///abs/Main.java#L3")).toEqual({ path: "/abs/Main.java", line: 3 });
  });

  it("leaves a plain path without navigation and rejects non-files", () => {
    expect(parseFileHref("README.md", "/repo")).toEqual({ path: "/repo/README.md" });
    expect(parseFileHref("src/App.tsx:0", "/repo")).toEqual({ path: "/repo/src/App.tsx" });
    expect(parseFileHref("https://example.com/a.ts:3")).toBeUndefined();
    expect(parseFileHref("#thread:abcdef", "/repo")).toBeUndefined();
    expect(parseFileHref("src/App.tsx:3")).toBeUndefined();
  });

  it("matches resolveWorkspacePath on the path", () => {
    for (const href of ["src/a.ts:12", "docs/b.md", "/x/y.rs#L4"]) {
      expect(parseFileHref(href, "/repo")?.path).toBe(resolveWorkspacePath(href, "/repo"));
    }
  });
});
