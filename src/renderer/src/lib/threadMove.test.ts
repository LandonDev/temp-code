import { describe, expect, it } from "vitest";
import type { Environment } from "./connection/types";
import { moveNoticeLines, moveTargets, threadBlocker, type MovableThread } from "./threadMove";

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
    expect(threadBlocker({ ...idle, draft: true })).toMatch(/first message/);
    expect(threadBlocker({ ...idle, parentId: "p" })).toMatch(/subagent/);
    expect(threadBlocker({ ...idle, status: "paused" })).toMatch(/paused/);
    expect(threadBlocker({ ...idle, treeHasLiveWork: true })).toMatch(/working/);
    expect(threadBlocker({ ...idle, status: "watching" })).toMatch(/working/);
    expect(threadBlocker({ ...idle, queued: 2 })).toMatch(/queued/);
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
      "Uncommitted changes stayed on This Mac: a.ts, b.ts, c.ts, d.ts, e.ts and 5 more. Commit and push them to carry them over.",
      "Undo history stayed on This Mac.",
      "The harness transcript was not on This Mac; the next message replays the dialogue as context.",
    ]);
  });
});
