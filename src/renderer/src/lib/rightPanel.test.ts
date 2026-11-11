// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_MAX,
  PANEL_MIN,
  PANEL_WIDTH,
  THREAD_MIN,
  panelFit,
  rightPanel,
  sectionsCompact,
  sectionsFor,
  shownSection,
  watchSection,
  type PanelFacts,
} from "./rightPanel";

const quiet: PanelFacts = {
  root: true,
  notes: true,
  project: false,
  checkout: false,
  agents: 0,
  activity: 0,
  computer: false,
  computerLive: false,
  debug: false,
};

describe("sectionsFor", () => {
  it("a subagent has no panel", () => {
    expect(sectionsFor({ ...quiet, root: false })).toEqual({ sections: [], defaultSection: null });
  });

  it("a subagent a pane shows has its agents and activity, never notes", () => {
    const agent = { ...quiet, notes: false };
    expect(sectionsFor(agent)).toEqual({ sections: [], defaultSection: null });
    expect(sectionsFor({ ...agent, agents: 2, activity: 1 })).toEqual({ sections: ["agents", "activity"], defaultSection: "agents" });
    expect(sectionsFor({ ...agent, checkout: true })).toEqual({ sections: ["changes", "files"], defaultSection: "changes" });
  });

  it("a chat with nothing running has notes alone", () => {
    expect(sectionsFor(quiet)).toEqual({ sections: ["notes"], defaultSection: "notes" });
  });

  it("a project thread adds the checkout sections, changes first; debug only for a dev build or the setting", () => {
    expect(sectionsFor({ ...quiet, project: true, checkout: true })).toEqual({
      sections: ["changes", "notes", "files", "build"],
      defaultSection: "changes",
    });
    expect(sectionsFor({ ...quiet, project: true, checkout: true, debug: true }).sections).toEqual(["changes", "notes", "files", "build", "debug"]);
    expect(sectionsFor({ ...quiet, debug: true }).sections).toEqual(["notes"]);
  });

  it("a loose chat in a git workspace lists Changes and Files, never Build or Debug", () => {
    expect(sectionsFor({ ...quiet, checkout: true, debug: true })).toEqual({
      sections: ["changes", "notes", "files"],
      defaultSection: "changes",
    });
  });

  it("subagents lead the header and take the default, live or done, even beside activity", () => {
    expect(sectionsFor({ ...quiet, project: true, checkout: true, agents: 2 })).toEqual({
      sections: ["agents", "changes", "notes", "files", "build"],
      defaultSection: "agents",
    });
    expect(sectionsFor({ ...quiet, agents: 2, activity: 1 })).toEqual({ sections: ["agents", "activity", "notes"], defaultSection: "agents" });
  });

  it("Activity exists only with rows, and takes the default only without subagents", () => {
    expect(sectionsFor({ ...quiet, activity: 1 })).toEqual({ sections: ["activity", "notes"], defaultSection: "activity" });
    expect(sectionsFor({ ...quiet, project: true, checkout: true }).sections).not.toContain("activity");
  });

  it("Computer exists with a drawable live session or kept steps, after Activity in the header", () => {
    expect(sectionsFor(quiet).sections).not.toContain("computer");
    expect(sectionsFor({ ...quiet, computer: true }).sections).toEqual(["computer", "notes"]);
    expect(sectionsFor({ ...quiet, computer: true, computerLive: true, activity: 1, agents: 1, project: true, checkout: true, debug: true }).sections).toEqual([
      "agents",
      "activity",
      "computer",
      "changes",
      "notes",
      "files",
      "build",
      "debug",
    ]);
    // a subagent a pane shows may have used the computer too
    expect(sectionsFor({ ...quiet, notes: false, computer: true }).sections).toEqual(["computer"]);
    expect(sectionsFor({ ...quiet, root: false, computer: true, computerLive: true })).toEqual({ sections: [], defaultSection: null });
  });

  it("Computer takes the default only while a session is live, after Agents and before Activity", () => {
    const live = { ...quiet, computer: true, computerLive: true };
    expect(sectionsFor(live).defaultSection).toBe("computer");
    expect(sectionsFor({ ...live, activity: 2, checkout: true }).defaultSection).toBe("computer");
    expect(sectionsFor({ ...live, agents: 1 }).defaultSection).toBe("agents");
    // kept steps alone never take it: the thread's state does, as before
    const kept = { ...quiet, computer: true };
    expect(sectionsFor(kept).defaultSection).toBe("notes");
    expect(sectionsFor({ ...kept, activity: 1 }).defaultSection).toBe("activity");
    expect(sectionsFor({ ...kept, checkout: true }).defaultSection).toBe("changes");
    // a live flag with no section (nothing this desktop can draw) changes nothing
    expect(sectionsFor({ ...quiet, computerLive: true }).defaultSection).toBe("notes");
  });

  it("a section the person picked stays theirs while Computer goes live", () => {
    rightPanel.reset();
    rightPanel.set("t9", { open: true, section: "notes" });
    const live = sectionsFor({ ...quiet, computer: true, computerLive: true });
    expect(shownSection(rightPanel.get("t9").section, live)).toBe("notes");
    // and a picked Computer stays once the session settles, on its kept steps
    rightPanel.set("t9", { section: "computer" });
    expect(shownSection(rightPanel.get("t9").section, sectionsFor({ ...quiet, computer: true }))).toBe("computer");
    // with nothing kept the section is gone and the default takes over
    expect(shownSection(rightPanel.get("t9").section, sectionsFor(quiet))).toBe("notes");
  });

  it("the header goes compact where its segments do not fit the panel", () => {
    // seven 28px segments 2px apart need 208px; a 260px panel has 203px for them
    expect(sectionsCompact(7, 260)).toBe(true);
    expect(sectionsCompact(7, 265)).toBe(false);
    expect(sectionsCompact(8, 260)).toBe(true);
    expect(sectionsCompact(8, 294)).toBe(true);
    expect(sectionsCompact(8, 295)).toBe(false);
    expect(sectionsCompact(8, PANEL_WIDTH)).toBe(false);
    expect(sectionsCompact(6, PANEL_MIN)).toBe(false);
    expect(sectionsCompact(1, PANEL_MIN)).toBe(false);
    // compact, eight 24px segments with no gap fit the narrowest panel
    expect(8 * 24).toBeLessThanOrEqual(PANEL_MIN - 57);
  });

  it("the Watching line opens Agents for a thread waiting on subagents, else Activity", () => {
    expect(watchSection({ agents: ["a1"] })).toBe("agents");
    expect(watchSection({ agents: [] })).toBe("activity");
    expect(watchSection(null)).toBe("activity");
  });

  it("a section the person picked is remembered per thread over the default", () => {
    rightPanel.reset();
    const available = sectionsFor({ ...quiet, project: true, checkout: true, agents: 2 });
    expect(shownSection(rightPanel.get("t1").section, available)).toBe("agents");
    rightPanel.set("t1", { section: "changes" });
    expect(shownSection(rightPanel.get("t1").section, available)).toBe("changes");
    expect(shownSection(rightPanel.get("t2").section, available)).toBe("agents");
  });

  it("the asked section shows when it exists, else the default", () => {
    const available = sectionsFor({ ...quiet, project: true, checkout: true });
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

  it("keeps the section a drawn panel reports, telling listeners only of a change; reset forgets it", () => {
    let n = 0;
    const off = rightPanel.subscribe(() => (n += 1));
    rightPanel.setShown("t1", "agents");
    rightPanel.setShown("t1", "agents");
    expect(n).toBe(1);
    rightPanel.setShown("t1", null);
    expect(n).toBe(2);
    rightPanel.setShown("t1", "notes");
    off();
    rightPanel.reset();
    rightPanel.setShown("t1", null);
    expect(n).toBe(3);
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

describe("panelFit", () => {
  it("draws the stored width when the thread keeps THREAD_MIN beside it", () => {
    expect(panelFit(1200, 320)).toBe(320);
  });

  it("shrinks toward PANEL_MIN so the thread keeps THREAD_MIN", () => {
    expect(panelFit(THREAD_MIN + 300, 400)).toBe(300);
    expect(panelFit(THREAD_MIN + PANEL_MIN, 400)).toBe(PANEL_MIN);
  });

  it("is null when even PANEL_MIN does not fit", () => {
    expect(panelFit(THREAD_MIN + PANEL_MIN - 1, 320)).toBeNull();
    expect(panelFit(400, 320)).toBeNull();
  });

  it("never passes PANEL_MAX", () => {
    expect(panelFit(4000, 9000)).toBe(PANEL_MAX);
  });
});

describe("no room", () => {
  beforeEach(() => rightPanel.reset());

  it("keeps the stored open state, and the toggle does nothing until the row has room", () => {
    rightPanel.open("t1");
    rightPanel.setRoom("t1", false);
    expect(rightPanel.hasRoom("t1")).toBe(false);
    rightPanel.toggle("t1");
    expect(rightPanel.get("t1").open).toBe(true);
    rightPanel.setRoom("t1", true);
    rightPanel.toggle("t1");
    expect(rightPanel.get("t1").open).toBe(false);
  });
});

describe("the shown thread", () => {
  beforeEach(() => rightPanel.reset());

  it("a pane showing a child keeps its own open and width, and reads the child's section memory", () => {
    rightPanel.open("master", "notes");
    rightPanel.setWidth("master", 400);
    rightPanel.set("child", { section: "agents" });
    rightPanel.showThread("master", { id: "child", environmentId: "env_box" });
    expect(rightPanel.shownThread("master")).toEqual({ id: "child", environmentId: "env_box" });
    expect(rightPanel.get("master")).toEqual({ open: true, width: 400, section: "agents", debug: false });
    // Back to the board: the master's own memory again.
    rightPanel.showThread("master", null);
    expect(rightPanel.get("master")).toMatchObject({ open: true, section: "notes" });
  });

  it("a section picked while the child shows is the child's, never the master's", () => {
    rightPanel.open("master", "notes");
    rightPanel.showThread("master", { id: "child", environmentId: "env_mac" });
    rightPanel.set("master", { section: "activity" });
    expect(rightPanel.get("child").section).toBe("activity");
    rightPanel.showThread("master", null);
    expect(rightPanel.get("master").section).toBe("notes");
    // A second child remembers its own.
    rightPanel.showThread("master", { id: "other", environmentId: "env_mac" });
    expect(rightPanel.get("master").section).toBeNull();
  });

  it("a write naming the shown thread lands on the pane that shows it", () => {
    rightPanel.visible("master", true);
    rightPanel.showThread("master", { id: "child", environmentId: "env_mac" });
    // The child's Watching line opens Activity: the pane's panel opens on the child's section.
    rightPanel.open("child", "activity");
    expect(rightPanel.get("master")).toMatchObject({ open: true, section: "activity" });
    expect(rightPanel.get("child")).toMatchObject({ open: true, section: "activity" });
    rightPanel.toggle("child");
    expect(rightPanel.get("master").open).toBe(false);
  });

  it("a thread that is a tab on screen keeps its own panel, wherever else it shows", () => {
    rightPanel.visible("master", true);
    rightPanel.visible("child", true);
    rightPanel.showThread("master", { id: "child", environmentId: "env_mac" });
    rightPanel.open("child", "agents");
    expect(rightPanel.get("child").open).toBe(true);
    expect(rightPanel.get("master").open).toBe(false);
  });

  it("the merged state is one object until a part changes, and a repeat show emits nothing", () => {
    rightPanel.showThread("master", { id: "child", environmentId: "env_mac" });
    expect(rightPanel.get("master")).toBe(rightPanel.get("master"));
    let n = 0;
    const off = rightPanel.subscribe(() => (n += 1));
    rightPanel.showThread("master", { id: "child", environmentId: "env_mac" });
    expect(n).toBe(0);
    const before = rightPanel.get("master");
    rightPanel.open("master");
    expect(rightPanel.get("master")).not.toBe(before);
    off();
  });
});
