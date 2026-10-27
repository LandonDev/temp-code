import { describe, expect, it } from "vitest";
import { newTerminalFile } from "../lib/layout";
import { createProjectTerminal, defaultDockSize, withDockOpen } from "../lib/projectTerminal";
import {
  currentDock,
  initialTerminalsState,
  openNext,
  openTerminal,
  patchTerminal,
  removeProject,
  setDocks,
  terminals,
  terminalsStore,
  toBottom,
  updateDock,
} from "./terminals";

const file = (cwd = "/repo") => newTerminalFile(cwd, "zsh");
const dock = (path = "/repo") => createProjectTerminal(path, file(path));

describe("terminal reducers keep the state object on a no-op", () => {
  const s = initialTerminalsState([dock("/repo"), dock("/other")]);

  it("setDocks with the same array", () => {
    expect(setDocks(s, s.docks)).toBe(s);
  });

  it("updateDock that changes nothing, or names no dock", () => {
    expect(updateDock(s, "/repo", (d) => d)).toBe(s);
    expect(updateDock(s, "/repo", (d) => withDockOpen(d, true))).toBe(s);
    expect(updateDock(s, "/nowhere", () => null)).toBe(s);
  });

  it("patchTerminal for an unknown file, or a patch that changes nothing", () => {
    expect(patchTerminal(s, "missing", { title: "x" })).toBe(s);
    const { id, path } = s.docks[0].pane.files[0];
    expect(patchTerminal(s, id, { title: path })).toBe(s);
  });

  it("removeProject for a project with no dock", () => {
    expect(removeProject(s, "/nowhere")).toBe(s);
  });
});

describe("terminal reducers", () => {
  it("openTerminal makes the dock, then adds to it and opens it", () => {
    const first = openTerminal(initialTerminalsState(), "/repo", file());
    expect(first.docks).toHaveLength(1);
    expect(first.docks[0].open).toBe(true);
    const closed = updateDock(first, "/repo", (d) => withDockOpen(d, false));
    const second = openTerminal(closed, "/repo", file());
    expect(second.docks).toHaveLength(1);
    expect(second.docks[0].pane.files).toHaveLength(2);
    expect(second.docks[0].open).toBe(true);
    expect(second.docks[0].pane.activeFileId).toBe(second.docks[0].pane.files[1].id);
  });

  it("updateDock replaces only the named dock, and null removes it", () => {
    const s = initialTerminalsState([dock("/repo"), dock("/other")]);
    const closed = updateDock(s, "/repo", (d) => withDockOpen(d, false));
    expect(closed.docks[0].open).toBe(false);
    expect(closed.docks[1]).toBe(s.docks[1]);
    expect(updateDock(s, "/repo", () => null).docks).toEqual([s.docks[1]]);
  });

  it("patchTerminal patches the terminal's meta wherever it sits", () => {
    const s = initialTerminalsState([dock("/repo")]);
    const id = s.docks[0].pane.files[0].id;
    const next = patchTerminal(s, id, { title: "build" });
    expect(next.docks[0].pane.files[0].path).toBe("build");
  });

  it("removeProject drops the project's dock by normalized path", () => {
    const s = initialTerminalsState([dock("/repo"), dock("/other")]);
    expect(removeProject(s, "/repo/").docks).toEqual([s.docks[1]]);
  });
});

describe("the dock is bottom only", () => {
  it("a dock saved on the right restores at the bottom at the default height", () => {
    const right = { ...dock("/repo"), side: "right" as const, size: 480 };
    const [restored] = initialTerminalsState([right]).docks;
    expect(restored.side).toBe("bottom");
    expect(restored.size).toBe(defaultDockSize("bottom"));
    expect(restored.pane).toBe(right.pane);
    const moved = setDocks(initialTerminalsState(), [{ ...right, side: "top" }]);
    expect(moved.docks[0].side).toBe("bottom");
  });

  it("a bottom dock keeps its object, and setDocks of bottom docks keeps the state", () => {
    const bottom = { ...dock("/repo"), size: 300 };
    expect(toBottom(bottom)).toBe(bottom);
    const s = initialTerminalsState([bottom]);
    expect(s.docks[0]).toBe(bottom);
    expect(setDocks(s, [bottom])).toBe(s);
  });
});

describe("openNext", () => {
  it("opens a terminal at the project folder and titles the second after the first", () => {
    const first = openNext(initialTerminalsState(), "/repo");
    const second = openNext(first, "/repo");
    const [a, b] = second.docks[0].pane.files;
    expect(a.cwd).toBe("/repo");
    expect(b.path).toBe(`${a.path} 2`);
    expect(second.docks[0].pane.activeFileId).toBe(b.id);
  });

  it("opens at a thread's folder inside the project's dock when given one", () => {
    const s = openNext(initialTerminalsState(), "/repo", "/repo/.worktrees/t1");
    expect(s.docks[0].projectPath).toBe("/repo");
    expect(s.docks[0].pane.files[0].cwd).toBe("/repo/.worktrees/t1");
  });
});

describe("terminals store", () => {
  it("binds the reducers and reads the current dock", () => {
    terminalsStore.setState(initialTerminalsState(), true);
    terminals.openTerminal("/repo", file());
    expect(currentDock("/repo")?.pane.files).toHaveLength(1);
    let notified = 0;
    const off = terminalsStore.subscribe(() => notified++);
    terminals.updateDock("/repo", (d) => withDockOpen(d, true));
    terminals.removeProject("/nowhere");
    expect(notified).toBe(0);
    terminals.removeProject("/repo");
    expect(notified).toBe(1);
    expect(currentDock("/repo")).toBeUndefined();
    off();
  });
});
