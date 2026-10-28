import { describe, expect, it } from "vitest";
import type { Environment } from "./connection/types";
import type { SessionMoveResult } from "@server/shared/contract-session-move";
import { moveNoticeException, movePreviewParts, moveTargets, threadBlocker, type MovableThread } from "./threadMove";

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const ENVS = [env("local", "This Mac"), env("env_box", "box"), env("env_b2", "box two")];
type Status = { transport: "open" | "offline" | "reconnecting"; lastHello: { environmentId: string; contract: number; caps: never } | null };
const open = (caps: string[] = ["read", "operate", "approve", "admin"]): Status => ({ transport: "open" as const, lastHello: { environmentId: "x", contract: 1, caps: caps as never } });
const idle: MovableThread = { id: "t", environmentId: "local", status: "idle" };

describe("moveTargets", () => {
  it("a Mac thread can go to every saved host; a host's thread only back to the Mac", () => {
    const all = (): Status => open();
    expect(moveTargets(idle, ENVS, all, false).map((t) => [t.name, t.ok])).toEqual([["box", true], ["box two", true]]);
    expect(moveTargets({ ...idle, environmentId: "env_box" }, ENVS, all, false).map((t) => [t.name, t.ok])).toEqual([["This Mac", true]]);
  });

  it("names why a target is out of reach: a busy thread, a link down, a key that is not admin", () => {
    expect(moveTargets({ ...idle, status: "running" }, ENVS, () => open(), false)[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/working/) });
    const boxDown = (id: string): Status => (id === "env_box" ? { transport: "reconnecting", lastHello: null } : open());
    expect(moveTargets(idle, ENVS, boxDown, false)[0]).toEqual({ environmentId: "env_box", name: "box", ok: false, reason: "box is not connected" });
    const readKey = (id: string): Status => (id === "env_box" ? open(["read", "operate"]) : open());
    expect(moveTargets({ ...idle, environmentId: "env_box" }, ENVS, readKey, false)[0]).toMatchObject({ ok: false, reason: "the key for box is not an admin key" });
    const macDown = (id: string): Status => (id === "local" ? { transport: "offline", lastHello: null } : open());
    expect(moveTargets(idle, ENVS, macDown, false)[0]).toMatchObject({ ok: false, reason: "this Mac's server is not connected" });
    expect(moveTargets(idle, ENVS, () => open(), true)[0]).toMatchObject({ ok: false, reason: "a move is already running" });
  });

  it("offers nothing where there is no desktop server (the /ui page)", () => {
    expect(moveTargets({ ...idle, environmentId: "web" }, [env("web", "This host")], () => open(), false)).toEqual([]);
  });
});

describe("threadBlocker", () => {
  it("only a settled root with nothing queued moves", () => {
    expect(threadBlocker(idle)).toBeNull()
    expect(threadBlocker({ ...idle, status: "error" })).toBeNull();
    expect(threadBlocker({ ...idle, draft: true })).toBeNull();
    expect(threadBlocker({ ...idle, parentId: "p" })).toMatch(/subagent/);
    expect(threadBlocker({ ...idle, status: "paused" })).toMatch(/paused/);
    expect(threadBlocker({ ...idle, treeHasLiveWork: true })).toMatch(/working/);
    expect(threadBlocker({ ...idle, status: "watching" })).toMatch(/working/);
    expect(threadBlocker({ ...idle, queued: 2 })).toMatch(/queued/);
  });
});

describe("movePreviewParts", () => {
  it("says what the move carries: the branch and its uncommitted files, or that there is none", () => {
    expect(movePreviewParts(null)).toEqual(["Checking the branch…"]);
    expect(movePreviewParts("error")).toEqual([expect.stringMatching(/Could not read the branch/)]);
    expect(movePreviewParts({ branch: "ios/home", detached: false, worktree: false, dirty: 3, origin: true })).toEqual(["Branch ios/home travels too", "3 uncommitted files travel too"]);
    expect(movePreviewParts({ branch: "ios/home", detached: false, worktree: true, dirty: 1, origin: false })).toEqual(["Branch ios/home travels too", "1 uncommitted file travels too"]);
    expect(movePreviewParts({ branch: "master", detached: false, worktree: false, dirty: 0, origin: true })).toEqual(["Branch master travels too"]);
    expect(movePreviewParts({ branch: null, detached: true, worktree: false, dirty: 0, origin: false })).toEqual(["The checked-out commit travels too"]);
    expect(movePreviewParts({ branch: null, detached: false, worktree: false, dirty: 0, origin: false })).toEqual(["No branch to carry"]);
    expect(movePreviewParts({ branch: null, detached: false, worktree: false, dirty: 2, origin: false })).toEqual(["No branch to carry", "2 uncommitted files stay behind"]);
  });
});

const moved = (over: Partial<SessionMoveResult>): SessionMoveResult => ({
  sessionId: "t",
  sessionIds: ["t"],
  from: "local",
  to: "env_box",
  cwd: "/srv/work/shop",
  events: 1,
  files: 0,
  transcript: "moved",
  dirty: [],
  dirtyMore: 0,
  checkpointsStayed: false,
  branch: null,
  ...over,
});
const landed = (over: Partial<NonNullable<SessionMoveResult["branch"]>> = {}): NonNullable<SessionMoveResult["branch"]> => ({
  branch: "ios/home",
  head: "0123456789abcdef0123456789abcdef01234567",
  defaultBranch: "master",
  worktree: true,
  mainCheckout: "/Users/me/IdeaProjects/shop",
  transport: "origin",
  pushError: null,
  dirty: [],
  dirtyMore: 0,
  patch: null,
  patchSkipped: null,
  landing: { branch: "ios/home", head: "0123456789abcdef0123456789abcdef01234567", mode: "worktree", cwd: "/srv/work/shop/.claude/worktrees/ios-home", created: true, patch: "none", patchPath: null, note: null },
  ...over,
});

describe("moveNoticeException", () => {
  const n = (result: SessionMoveResult) => moveNoticeException({ result, fromName: "This Mac" });

  it("says nothing when the move did what was asked", () => {
    expect(n(moved({ branch: landed() }))).toBeNull();
    expect(n(moved({ dirty: ["a.ts"], branch: landed({ dirty: ["a.ts"], landing: { ...landed().landing, patch: "applied" } }) }))).toBeNull();
    expect(n(moved({ checkpointsStayed: true, transcript: "missing" }))).toBeNull();
    expect(moveNoticeException({ result: null, fromName: "This Mac" })).toBeNull();
  });

  it("names a patch that did not apply, and where it is", () => {
    const kept = landed({ dirty: ["a.ts"], landing: { ...landed().landing, patch: "kept", patchPath: "/srv/work/shop/.temp-code/moved-changes.patch" } });
    expect(n(moved({ dirty: ["a.ts"], branch: kept }))).toBe("The patch didn't apply; it's at /srv/work/shop/.temp-code/moved-changes.patch");
  });

  it("names a branch that landed somewhere other than asked", () => {
    const diverged = landed({ landing: { ...landed().landing, mode: "checkout", note: "ios/home here has commits of its own; the thread is on it at 0123456789, not abcdef0123" } });
    expect(n(moved({ branch: diverged }))).toBe("Ios/home here has commits of its own; the thread is on it at 0123456789, not abcdef0123");
  });

  it("says the changes stayed when the patch was skipped or the folder is no checkout", () => {
    expect(n(moved({ dirty: ["big.bin"], branch: landed({ dirty: ["big.bin"], patchSkipped: "over 64 MiB" }) }))).toBe("Uncommitted changes stayed on This Mac");
    expect(n(moved({ dirty: ["a.ts"] }))).toBe("Uncommitted changes stayed on This Mac");
  });
});
