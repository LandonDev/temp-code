import { describe, expect, it } from "vitest";
import { WORKING_MIN, workingRows } from "./railWorking";
import type { SessionMeta } from "./tcserver/types";

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

const NONE: ReadonlySet<string> = new Set();
const ids = (metas: SessionMeta[], unseen: ReadonlySet<string> = NONE) => workingRows(metas, unseen).map((r) => [r.id, r.state]);

describe("workingRows", () => {
  it("lists roots only, never a subagent, an archived thread or one housed in a master's batch", () => {
    expect(
      ids([
        meta("root", { status: "running", busySince: 5 }),
        meta("kid", { status: "running", busySince: 5, parentId: "root" }),
        meta("gone", { status: "running", busySince: 5, archived: true }),
        meta("m", { status: "watching", isMaster: true }),
        meta("in-batch", { status: "running", busySince: 5, masterId: "m" }),
      ]),
    ).toEqual([["root", "working"]]);
  });

  it("reads every host the window knows", () => {
    expect(
      ids([meta("mac", { status: "running", busySince: 2 }), meta("box", { status: "running", busySince: 1, environmentId: "env_box" })]).map(
        ([id]) => id,
      ),
    ).toEqual(["box", "mac"]);
  });

  it("orders needs you first, then working by when the turn began, then the unseen done", () => {
    expect(
      ids(
        [
          meta("late", { status: "running", busySince: 30 }),
          meta("done", { status: "idle" }),
          meta("early", { status: "running", busySince: 10 }),
          meta("ask", { status: "waiting" }),
          meta("quiet", { status: "idle" }),
        ],
        new Set(["done"]),
      ),
    ).toEqual([
      ["ask", "waiting"],
      ["early", "working"],
      ["late", "working"],
      ["done", "done"],
    ]);
  });

  it("is under the section's minimum with one row", () => {
    expect(workingRows([meta("one", { status: "running", busySince: 1 })], NONE).length).toBeLessThan(WORKING_MIN);
  });
});
