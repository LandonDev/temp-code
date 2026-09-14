import { describe, expect, it } from "vitest";
import { collapseBlankTabs, isBlankSession, isPlaceholderTitle } from "./blankTabs";
import { leaf, newFileTab, newTab, type WorkspaceTab } from "./layout";
import { newSession } from "./session";

const tab = (sessionId: string): WorkspaceTab => ({ ...newTab(sessionId), id: `t-${sessionId}` });
const project = (id: string): string => (id.startsWith("a") ? "/a" : "/b");

describe("isPlaceholderTitle", () => {
  it("knows the server placeholders and the draft label", () => {
    expect(isPlaceholderTitle("New chat")).toBe(true);
    expect(isPlaceholderTitle("New task")).toBe(true);
    expect(isPlaceholderTitle("claude · implementer")).toBe(true);
    expect(isPlaceholderTitle("claude")).toBe(true);
  });

  it("treats a message slice or a rename as a real title", () => {
    expect(isPlaceholderTitle("Fix the login flow")).toBe(false);
    expect(isPlaceholderTitle("")).toBe(false);
  });
});

describe("isBlankSession", () => {
  it("is blank for a stub the server never saw", () => {
    expect(isBlankSession({ ...newSession("claude", "/a"), title: "anything" }, false)).toBe(true);
  });

  it("is blank for a loaded transcript with no blocks", () => {
    expect(isBlankSession({ ...newSession("claude", "/a"), title: "Renamed", loaded: true }, true)).toBe(true);
  });

  it("goes by the title when the history is not fetched yet", () => {
    expect(isBlankSession({ ...newSession("claude", "/a"), title: "New chat" }, true)).toBe(true);
    expect(isBlankSession({ ...newSession("claude", "/a"), title: "Fix login" }, true)).toBe(false);
  });

  it("is never blank with blocks", () => {
    const s = { ...newSession("claude", "/a"), title: "New chat", blocks: [{ id: "u1", role: "user" as const, text: "hi" }] };
    expect(isBlankSession(s, true)).toBe(false);
  });
});

describe("collapseBlankTabs", () => {
  const blank = new Set(["a1", "a2", "a3", "b1", "b2"]);

  it("keeps the newest blank tab per project and every non-blank tab", () => {
    const tabs = [tab("a1"), tab("x1"), tab("a2"), tab("b1"), tab("a3"), tab("b2")];
    const out = collapseBlankTabs(tabs, blank, project, "t-x1");
    expect(out.map((t) => t.id)).toEqual(["t-x1", "t-a3", "t-b2"]);
  });

  it("prefers the active tab over a newer blank one", () => {
    const tabs = [tab("a1"), tab("a2"), tab("a3")];
    const out = collapseBlankTabs(tabs, blank, project, "t-a2");
    expect(out.map((t) => t.id)).toEqual(["t-a2"]);
  });

  it("leaves splits and tabs with editor or terminal panes alone", () => {
    const split: WorkspaceTab = {
      ...tab("a1"),
      layout: { type: "split", id: "s", dir: "right", children: [leaf("a1"), leaf("a2")], sizes: [0.5, 0.5] },
    };
    const file = newFileTab("/a/x.ts", "/a");
    const editor: WorkspaceTab = { ...tab("a3"), editorPanes: [{ id: "e1", files: [file], activeFileId: file.id }] };
    const tabs = [split, editor, tab("b1"), tab("b2")];
    const out = collapseBlankTabs(tabs, blank, project, "t-b2");
    expect(out.map((t) => t.id)).toEqual(["t-a1", "t-a3", "t-b2"]);
  });

  it("returns the same array when nothing drops", () => {
    const tabs = [tab("a1"), tab("b1"), tab("x1")];
    expect(collapseBlankTabs(tabs, blank, project, "t-a1")).toBe(tabs);
  });
});
