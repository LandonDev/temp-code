// @vitest-environment jsdom
// A node-project file on jsdom: the dom project stubs CodeMirror, and this
// test needs the real editor's states and history.
import "../test/domSetup";

// CodeMirror measures text ranges; jsdom has no layout.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
import { act, cleanup, render } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillTextEditor } from "./SkillTextEditor";

afterEach(cleanup);

const view = (): EditorView => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
const text = () => view().state.doc.toString();
/** A change the person makes: no annotation, so it counts as theirs. */
const typeAt = (at: number, insert: string) => act(() => view().dispatch({ changes: { from: at, insert } }));

describe("SkillTextEditor", () => {
  it("shows the value, and tells a typed change", () => {
    const onChange = vi.fn();
    render(<SkillTextEditor path="SKILL.md" value="# Skill" onChange={onChange} label="SKILL.md" />);
    expect(text()).toBe("# Skill");
    expect(document.querySelector(".cm-content")!.getAttribute("aria-label")).toBe("SKILL.md");
    typeAt(7, "!");
    expect(onChange).toHaveBeenLastCalledWith("# Skill!");
  });

  it("swaps the text for a new path without calling onChange", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SkillTextEditor path="SKILL.md" value="one" onChange={onChange} label="SKILL.md" />);
    rerender(<SkillTextEditor path="notes.md" value="two" onChange={onChange} label="notes.md" />);
    expect(text()).toBe("two");
    expect(document.querySelector(".cm-content")!.getAttribute("aria-label")).toBe("notes.md");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps each file's own history: an Undo in B never brings A's text, and A keeps its edit", () => {
    // The dialog's shape: drafts per path, the editor shown on one of them.
    let api: { open: (p: string) => void } = { open: () => {} };
    function Host() {
      const [drafts, setDrafts] = useState<Record<string, string>>({ "a.md": "alpha", "b.md": "beta" });
      const [path, setPath] = useState("a.md");
      api = { open: setPath };
      return <SkillTextEditor path={path} value={drafts[path]!} onChange={(t) => setDrafts((d) => ({ ...d, [path]: t }))} label={path} />;
    }
    render(<Host />);
    typeAt(5, " edited");
    expect(text()).toBe("alpha edited");
    act(() => api.open("b.md"));
    expect(text()).toBe("beta");
    act(() => {
      undo(view());
    });
    expect(text()).toBe("beta");
    act(() => api.open("a.md"));
    expect(text()).toBe("alpha edited");
    act(() => {
      undo(view());
    });
    expect(text()).toBe("alpha");
  });

  it("takes a new value for the same path at once, with no onChange and no undo step", () => {
    const onChange = vi.fn();
    const md = (name: string) => `---\nname: ${name}\ndescription: \n---\n`;
    const { rerender } = render(<SkillTextEditor path="SKILL.md" value={md("dra")} onChange={onChange} label="SKILL.md" />);
    rerender(<SkillTextEditor path="SKILL.md" value={md("draft")} onChange={onChange} label="SKILL.md" />);
    expect(text()).toBe(md("draft"));
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      undo(view());
    });
    expect(text()).toBe(md("draft"));
  });
});
