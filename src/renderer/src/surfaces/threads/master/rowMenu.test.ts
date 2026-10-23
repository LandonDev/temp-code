import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { rowMenuItems } from "./rowMenu";

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: "t", environmentId: "local", parentId: null, projectId: "p1", threadType: "implementation", status: "idle", title: "Home", ...over }) as SessionMeta;

const ids = (items: ReturnType<typeof rowMenuItems>) => items.map((i) => (i.kind === "sep" ? "—" : i.id));

describe("a board row's menu", () => {
  it("leads with New pass… and Open, then the tab's own actions the board answers", () => {
    expect(ids(rowMenuItems(meta({ status: "idle" }), false, []))).toEqual(["new-pass", "open", "—", "rename", "compact", "—", "master", "—", "archive"]);
  });

  it("offers Pause and Stop on a running thread, Continue on a paused one, and the master pin's other word on a master", () => {
    expect(ids(rowMenuItems(meta({ status: "running" }), false, []))).toEqual(["new-pass", "open", "—", "rename", "pause", "stop", "—", "master", "—", "archive"]);
    const paused = rowMenuItems(meta({ status: "paused" }), true, []);
    expect(paused.find((i) => i.kind === "item" && i.id === "resume")).toMatchObject({ label: "Continue" });
    expect(paused.find((i) => i.kind === "item" && i.id === "master")).toMatchObject({ label: "Not a master" });
  });

  it("puts the host moves before Archive, a refused one disabled with its reason", () => {
    const items = rowMenuItems(meta({}), false, [{ environmentId: "box", name: "The box", ok: false, reason: "the thread is working; stop it or wait for it to finish" }]);
    expect(ids(items).slice(-6)).toEqual(["master", "—", "move:box", "why:box", "—", "archive"]);
    expect(items.find((i) => i.kind === "item" && i.id === "move:box")).toMatchObject({ label: "Move to The box…", disabled: true });
  });

  it("gives a subagent no master pin", () => {
    expect(ids(rowMenuItems(meta({ parentId: "root" }), false, []))).not.toContain("master");
  });
});
