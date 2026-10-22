import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { addMenuItems, adoptCandidates, archiveCopy, boardMenuItems, doneRows, pausedRows } from "./boardActions";

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: "x", environmentId: "local", projectId: "p1", parentId: null, archived: false, status: "idle", createdAt: 1, ...over }) as SessionMeta;
const master = { id: "m", environmentId: "local", projectId: "p1" };

describe("the board's menus", () => {
  it("takes done and paused rows by status", () => {
    const rows = ["idle", "done", "stopped", "error", "paused", "running"].map((status, i) => ({ meta: meta({ id: `c${i}`, status: status as SessionMeta["status"] }) }));
    expect(doneRows(rows).map((r) => r.meta.id)).toEqual(["c0", "c1"]);
    expect(pausedRows(rows).map((r) => r.meta.id)).toEqual(["c4"]);
  });

  it("disables a switch with nothing to act on", () => {
    const items = boardMenuItems({ pausable: 0, paused: 1, done: 0, all: 3 });
    const by = (id: string) => items.find((i) => i.kind === "item" && i.id === id) as { label: string; disabled?: boolean };
    expect(by("pause")).toMatchObject({ label: "Pause all", disabled: true });
    expect(by("resume")).toMatchObject({ label: "Resume all", disabled: false });
    expect(by("archive-done")).toMatchObject({ label: "Archive done…", disabled: true });
    expect(by("archive-all")).toMatchObject({ label: "Archive all…", disabled: false });
    expect(addMenuItems(0).map((i) => (i.kind === "item" ? `${i.label}:${!!i.disabled}` : ""))).toEqual(["New thread…:false", "Add existing thread…:true"]);
  });

  it("writes the archive confirm with the live count and the resources clause", () => {
    expect(archiveCopy("done", 1, null)).toMatchObject({ title: "Archive 1 done thread?", confirmLabel: "Archive 1", cleanup: null });
    expect(archiveCopy("all", 7, 3)).toMatchObject({ title: "Archive all 7 threads?", cleanup: "and remove their 3 worktrees and simulators" });
    expect(archiveCopy("all", 7, 0).cleanup).toBeNull();
    expect(archiveCopy("all", 2, null).body).toMatch(/stopped first/);
  });

  it("offers the project's unarchived roots on the master's host that are in no batch and are no master", () => {
    const metas = [
      meta({ id: "a", createdAt: 5 }),
      meta({ id: "b", createdAt: 2 }),
      meta({ id: "m", isMaster: true }),
      meta({ id: "other-master", isMaster: true }),
      meta({ id: "in-batch", masterId: "other-master" }),
      meta({ id: "sub", parentId: "a" }),
      meta({ id: "gone", archived: true }),
      meta({ id: "elsewhere", environmentId: "box" }),
      meta({ id: "p2", projectId: "p2" }),
    ];
    expect(adoptCandidates(metas, master).map((m) => m.id)).toEqual(["b", "a"]);
    expect(adoptCandidates(metas, { ...master, projectId: null })).toEqual([]);
  });
});
