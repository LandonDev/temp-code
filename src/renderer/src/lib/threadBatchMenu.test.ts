import { describe, expect, it } from "vitest";
import type { SessionMeta } from "./tcserver/types";
import { batchActionOfMenuId, batchCounts, batchMenuRows, batchMenuExtraItems, batchMenuId } from "./threadBatchMenu";

const NOW = 9_000_000;
function meta(over: Partial<SessionMeta>): SessionMeta {
  return { id: "s", environmentId: "local", parentId: null, projectId: null, workspaceId: null, cwd: "/a", title: "t", status: "idle", archived: false, updatedAt: NOW - 11 * 60_000, ...over } as SessionMeta;
}
const sel = { catalog: { workspaces: [], projects: [] }, lastSeen: { c: NOW }, floor: 0, now: NOW, scope: { kind: "all" } as const };

describe("thread batch menu rows", () => {
  it("counts what each action would touch", () => {
    const metas = [meta({ id: "a", status: "running" }), meta({ id: "b", status: "paused" }), meta({ id: "c" })];
    expect(batchCounts(metas, sel)).toEqual({ pause: 1, resume: 1, stop: 1, archiveDone: 1 });
  });

  it("builds the project menu's group with a disabled row at zero", () => {
    const items = batchMenuExtraItems({ pause: 2, resume: 0, stop: 2, archiveDone: 0 });
    expect(items.map((i) => [i.id, i.label, i.disabled, i.danger ?? false, i.sepBefore ?? false])).toEqual([
      ["batch-pause", "Pause all", false, false, true],
      ["batch-resume", "Resume all", true, false, false],
      ["batch-stop", "Stop all", false, true, false],
      ["batch-archiveDone", "Archive done", true, false, false],
    ]);
    expect(batchMenuExtraItems(null).every((i) => i.disabled)).toBe(true);
  });

  it("builds the rows with Mark all read first when a count is given, each with its glyph", () => {
    expect(batchMenuRows(null).map((i) => (i.kind === "item" ? i.id : "sep"))).toEqual(["batch-pause", "batch-resume", "batch-stop", "batch-archiveDone"]);
    expect(batchMenuRows(null).every((i) => i.kind === "item" && i.icon && i.disabled)).toBe(true);
    const items = batchMenuRows({ pause: 0, resume: 3, stop: 0, archiveDone: 1 }, 0);
    expect(items.map((i) => (i.kind === "item" ? [i.id, i.disabled] : "sep"))).toEqual([
      ["read", true],
      ["batch-pause", true],
      ["batch-resume", false],
      ["batch-stop", true],
      ["batch-archiveDone", false],
    ]);
  });

  it("reads an action back from its row id", () => {
    expect(batchActionOfMenuId(batchMenuId("archiveDone"))).toBe("archiveDone");
    expect(batchActionOfMenuId("read")).toBeNull();
    expect(batchActionOfMenuId("batch-nope")).toBeNull();
  });
});
