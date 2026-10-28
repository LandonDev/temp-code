// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorFolding, foldMarkerDOM, foldPlaceholderDOM } from "./editorChrome";

describe("the fold gutter and placeholder", () => {
  it("draws the open and closed markers with no native title", () => {
    const open = foldMarkerDOM(true);
    const closed = foldMarkerDOM(false);
    expect(open.textContent).toBe("⌄");
    expect(closed.textContent).toBe("›");
    for (const marker of [open, closed]) expect(marker.title).toBe("");
  });

  it("draws the folded placeholder with its name for screen readers and no title, and unfolds on click", () => {
    const onclick = vi.fn();
    const placeholder = foldPlaceholderDOM(null as never, onclick);
    expect(placeholder.className).toBe("cm-foldPlaceholder");
    expect(placeholder.getAttribute("aria-label")).toBe("folded code");
    expect(placeholder.hasAttribute("title")).toBe(false);
    placeholder.click();
    expect(onclick).toHaveBeenCalledOnce();
  });

  it("is an extension a state takes", () => {
    expect(() => EditorState.create({ doc: "a\n", extensions: editorFolding })).not.toThrow();
  });
});
