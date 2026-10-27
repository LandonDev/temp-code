// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PANEL_MAX, PANEL_MIN, PANEL_WIDTH, rightPanel, sectionsFor, shownSection, type PanelFacts } from "./rightPanel";

const quiet: PanelFacts = {
  root: true,
  project: false,
  agents: 0,
  liveAgents: 0,
  backgroundTasks: 0,
  watching: false,
  devRunning: false,
  debug: false,
};

describe("sectionsFor", () => {
  it("a subagent has no panel", () => {
    expect(sectionsFor({ ...quiet, root: false })).toEqual({ sections: [], defaultSection: null });
  });

  it("a chat with nothing running has notes alone", () => {
    expect(sectionsFor(quiet)).toEqual({ sections: ["notes"], defaultSection: "notes" });
  });

  it("a project thread adds the checkout sections, changes first; debug only for a dev build or the setting", () => {
    expect(sectionsFor({ ...quiet, project: true })).toEqual({
      sections: ["changes", "notes", "files", "build", "dev"],
      defaultSection: "changes",
    });
    expect(sectionsFor({ ...quiet, project: true, debug: true }).sections).toEqual(["changes", "notes", "files", "build", "dev", "debug"]);
    expect(sectionsFor({ ...quiet, debug: true }).sections).toEqual(["notes"]);
  });

  it("subagents add agents and take the default, live or done; live ones add activity and win it", () => {
    expect(sectionsFor({ ...quiet, project: true, agents: 2 })).toEqual({
      sections: ["agents", "changes", "notes", "files", "build", "dev"],
      defaultSection: "agents",
    });
    expect(sectionsFor({ ...quiet, agents: 2, liveAgents: 1 }).sections).toEqual(["activity", "agents", "notes"]);
    expect(sectionsFor({ ...quiet, agents: 2, liveAgents: 1 }).defaultSection).toBe("activity");
  });

  it("a watching master's wait, background tasks and a dev server each open a section; its batch never opens Agents", () => {
    expect(sectionsFor({ ...quiet, watching: true }).sections).toEqual(["activity", "notes"]);
    expect(sectionsFor({ ...quiet, backgroundTasks: 1 }).sections).toEqual(["activity", "notes"]);
    expect(sectionsFor({ ...quiet, project: true, devRunning: true }).sections[0]).toBe("activity");
  });

  it("the asked section shows when it exists, else the default", () => {
    const available = sectionsFor({ ...quiet, project: true });
    expect(shownSection("files", available)).toBe("files");
    expect(shownSection("agents", available)).toBe("changes");
    expect(shownSection(null, available)).toBe("changes");
  });
});

describe("the store", () => {
  beforeEach(() => rightPanel.reset());

  it("starts closed at the default width", () => {
    expect(rightPanel.get("t1")).toEqual({ open: false, section: null, width: PANEL_WIDTH, debug: false });
  });

  it("toggles, opens on a section and closes per thread", () => {
    rightPanel.toggle("t1");
    expect(rightPanel.get("t1").open).toBe(true);
    rightPanel.open("t2", "files");
    expect(rightPanel.get("t2")).toMatchObject({ open: true, section: "files" });
    rightPanel.close("t1");
    expect(rightPanel.get("t1").open).toBe(false);
    expect(rightPanel.get("t2").open).toBe(true);
  });

  it("show reaches the focused thread when no id is given", () => {
    rightPanel.show("debug");
    expect(rightPanel.get("t1").open).toBe(false);
    rightPanel.focus("t1");
    rightPanel.show("debug");
    expect(rightPanel.get("t1")).toMatchObject({ open: true, section: "debug", debug: true });
    expect(rightPanel.get("t2").debug).toBe(false);
  });

  it("a visible thread takes the target when none is set, and hands it on when it leaves", () => {
    rightPanel.visible("a", true);
    rightPanel.visible("b", true);
    expect(rightPanel.focused()).toBe("a");
    rightPanel.focus("a");
    rightPanel.visible("a", false);
    expect(rightPanel.focused()).toBe("b");
    rightPanel.visible("b", false);
    expect(rightPanel.focused()).toBeNull();
  });

  it("persists the width, clamped, and a new thread inherits the last one", () => {
    rightPanel.setWidth("t1", 1000);
    expect(rightPanel.get("t1").width).toBe(PANEL_MAX);
    rightPanel.setWidth("t1", 10);
    expect(rightPanel.get("t1").width).toBe(PANEL_MIN);
    rightPanel.setWidth("t1", 400);
    expect(rightPanel.get("t2").width).toBe(400);
    const saved = JSON.parse(localStorage.getItem("monocode.rightPanel") ?? "{}") as { width: number; threads: Record<string, unknown> };
    expect(saved.width).toBe(400);
    expect(saved.threads.t1).toEqual({ open: false, section: null, width: 400 });
  });

  it("a write with nothing new emits nothing", () => {
    let n = 0;
    rightPanel.open("t1", "notes");
    const before = JSON.stringify(localStorage.getItem("monocode.rightPanel"));
    rightPanel.open("t1", "notes");
    n += 1;
    expect(JSON.stringify(localStorage.getItem("monocode.rightPanel"))).toBe(before);
    expect(n).toBe(1);
  });
});
