import { describe, expect, it } from "vitest";
import type { Environment } from "./connection/types";
import type { SessionMoveResult } from "@server/shared/contract-session-move";
import { moveNoticeLines, movePreviewLine, moveTargets, threadBlocker, type MovableThread } from "./threadMove";

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

describe("movePreviewLine", () => {
  it("says what the move carries: the branch and its uncommitted files, or that there is none", () => {
    expect(movePreviewLine(null)).toBe("Checking the branch…");
    expect(movePreviewLine("error")).toMatch(/Could not read the branch/);
    expect(movePreviewLine({ branch: "ios/home", detached: false, worktree: false, dirty: 3, origin: true })).toBe("Branch ios/home travels too · 3 uncommitted files will be carried");
    expect(movePreviewLine({ branch: "ios/home", detached: false, worktree: true, dirty: 1, origin: false })).toBe("Branch ios/home travels too · 1 uncommitted file will be carried");
    expect(movePreviewLine({ branch: "master", detached: false, worktree: false, dirty: 0, origin: true })).toBe("Branch master travels too");
    expect(movePreviewLine({ branch: null, detached: true, worktree: false, dirty: 0, origin: false })).toBe("The checked-out commit travels too");
    expect(movePreviewLine({ branch: null, detached: false, worktree: false, dirty: 0, origin: false })).toBe("No branch to carry");
    expect(movePreviewLine({ branch: null, detached: false, worktree: false, dirty: 2, origin: false })).toBe("No branch to carry · 2 uncommitted files stay behind");
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

describe("moveNoticeLines: the branch", () => {
  it("names where the branch landed and how the commits crossed", () => {
    expect(moveNoticeLines({ result: moved({ branch: landed() }), fromName: "This Mac", toName: "box", error: null })).toEqual(["Branch ios/home in a worktree on box at /srv/work/shop/.claude/worktrees/ios-home, through origin."]);
    const bundle = landed({ transport: "bundle", pushError: "the repo has no origin", landing: { ...landed().landing, mode: "checkout", cwd: "/srv/work/shop", created: false } });
    expect(moveNoticeLines({ result: moved({ branch: bundle }), fromName: "This Mac", toName: "box", error: null })).toEqual(["Branch ios/home checked out in the project on box, over the link (the repo has no origin)."]);
    const detached = landed({ branch: null, landing: { ...landed().landing, branch: null, mode: "detached", note: "ios/home here has commits of its own, so the thread runs on a detached checkout at 0123456789" } });
    expect(moveNoticeLines({ result: moved({ branch: detached }), fromName: "This Mac", toName: "box", error: null })).toEqual([
      "commit 0123456789 in a detached worktree on box at /srv/work/shop/.claude/worktrees/ios-home, through origin.",
      "Ios/home here has commits of its own, so the thread runs on a detached checkout at 0123456789.",
    ]);
  });

  it("says whether the uncommitted changes applied, were kept as a patch, or stayed", () => {
    const applied = landed({ dirty: ["a.ts", "b.ts"], landing: { ...landed().landing, patch: "applied" } });
    expect(moveNoticeLines({ result: moved({ dirty: ["a.ts", "b.ts"], branch: applied }), fromName: "This Mac", toName: "box", error: null })[1]).toBe("2 uncommitted files carried and applied.");
    const kept = landed({ dirty: ["a.ts"], landing: { ...landed().landing, patch: "kept", patchPath: "/srv/work/shop/.claude/worktrees/ios-home/.temp-code/moved-changes.patch", note: "the uncommitted changes did not apply (x); the patch is at …" } });
    expect(moveNoticeLines({ result: moved({ dirty: ["a.ts"], branch: kept }), fromName: "This Mac", toName: "box", error: null })).toEqual([
      "Branch ios/home in a worktree on box at /srv/work/shop/.claude/worktrees/ios-home, through origin.",
      "1 uncommitted file carried, but the patch did not apply; it is at /srv/work/shop/.claude/worktrees/ios-home/.temp-code/moved-changes.patch.",
    ]);
    const skipped = landed({ dirty: ["big.bin"], patchSkipped: "the uncommitted changes are 70 MiB, over the 64 MiB a move carries" });
    expect(moveNoticeLines({ result: moved({ dirty: ["big.bin"], branch: skipped }), fromName: "This Mac", toName: "box", error: null })[1]).toBe("Uncommitted changes stayed on This Mac: the uncommitted changes are 70 MiB, over the 64 MiB a move carries.");
  });

  it("a folder that is not a checkout: the dirty list stayed, as before", () => {
    expect(moveNoticeLines({ result: moved({ dirty: ["a.ts"] }), fromName: "This Mac", toName: "box", error: null })).toEqual(["Uncommitted changes stayed on This Mac: a.ts. The folder is not a git checkout, so nothing carried them."]);
  });
});

describe("moveNoticeLines", () => {
  it("warns about the dirty tree, the undo history and a missing transcript", () => {
    const lines = moveNoticeLines({
      fromName: "This Mac",
      toName: "box",
      error: null,
      result: {
        sessionId: "t",
        sessionIds: ["t"],
        from: "a",
        to: "b",
        cwd: "/srv/agents/work/x",
        events: 10,
        files: 2,
        transcript: "missing",
        dirty: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
        dirtyMore: 4,
        checkpointsStayed: true,
      },
    });
    expect(lines).toEqual([
      "Uncommitted changes stayed on This Mac: a.ts, b.ts, c.ts, d.ts, e.ts and 5 more. The folder is not a git checkout, so nothing carried them.",
      "Undo history stayed on This Mac.",
      "The harness transcript was not on This Mac; the next message replays the dialogue as context.",
    ]);
  });
});
