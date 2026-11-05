import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "./tcserver/types";

const { archive } = vi.hoisted(() => ({ archive: vi.fn(async (_id: string, _archived: boolean) => {}) }));
vi.mock("./tcserver/commands", () => ({ archive }));
const { metas } = vi.hoisted(() => ({ metas: [] as SessionMeta[] }));
vi.mock("./tcserver/store", () => ({ sessionStore: { metas: () => metas } }));

import { archiveDormant, settledBatchOf } from "./archiveDormant";

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, status: "idle", archived: false, pinned: false, updatedAt: 100, ...extra }) as SessionMeta;

const batch = [
  meta("master", { isMaster: true }),
  meta("done", { masterId: "master", status: "done", updatedAt: 500 }),
  meta("idle", { masterId: "master", updatedAt: 500 }),
  meta("working", { masterId: "master", status: "running" }),
  meta("failed", { masterId: "master", treeCanContinue: true }),
  { ...meta("pinned", { masterId: "master" }), pinned: true },
  meta("on-screen", { masterId: "master" }),
  meta("held-plan", { masterId: "master", threadType: "planning", planPath: "/p/plan.md" }),
  meta("subagent", { parentId: "master" }),
  meta("other", { masterId: "elsewhere" }),
];

afterEach(() => {
  archive.mockClear();
  metas.length = 0;
});

describe("settledBatchOf", () => {
  it("takes a picked master's settled batch, read or not, and nothing that works, waits, is pinned, holds a plan or is on screen", () => {
    expect(settledBatchOf(batch, [{ id: "master" }], new Set(["on-screen"])).map((m) => m.id)).toEqual(["done", "idle"]);
  });

  it("takes nothing for roots that are no master, or a master that is archived", () => {
    expect(settledBatchOf(batch, [{ id: "other" }], new Set())).toEqual([]);
    const gone = batch.map((m) => (m.id === "master" ? { ...m, archived: true } : m));
    expect(settledBatchOf(gone, [{ id: "master" }], new Set())).toEqual([]);
  });
});

describe("archiveDormant", () => {
  it("archives the batch first, then the picked roots, sparing the tree on screen", async () => {
    metas.push(...batch, meta("on-screen-agent", { parentId: "on-screen" }));
    archiveDormant([{ id: "master" }, { id: "plain" }], "on-screen-agent");
    await Promise.resolve();
    expect(archive.mock.calls).toEqual([
      ["done", true],
      ["idle", true],
      ["master", true],
      ["plain", true],
    ]);
  });
});
