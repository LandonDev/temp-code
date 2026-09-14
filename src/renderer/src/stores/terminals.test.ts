import { describe, expect, it } from "vitest";
import { newTerminalFile } from "../lib/layout";
import { createProjectTerminal, withDockOpen } from "../lib/projectTerminal";
import {
  currentDock,
  initialTerminalsState,
  openTerminal,
  patchTerminal,
  removeProject,
  setDocks,
  terminals,
  terminalsStore,
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
