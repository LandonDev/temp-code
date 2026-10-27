import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import { STALE_WATCH_MS } from "@shared/watch";
import { bannerThreads, pausedText, staleText, staleWatchers } from "./ThreadBanners";

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    planPath: null,
    provider: "claude",
    model: "claude",
    reasoning: "medium",
    agentType: "implementer",
    title: id,
    cwd: "/a",
    status: "idle",
    pinned: false,
    archived: false,
    permission: "supervised",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 100,
    ...over,
  } as SessionMeta;
}

describe("bannerThreads", () => {
  it("collects paused and recovery across every project, not just one", () => {
    const paused = meta("p1", { treeHasPaused: true, projectId: "a" });
    const recovering = meta("r1", { treeCanContinue: true, projectId: "b" });
    const result = bannerThreads([paused, recovering], "a", undefined);
    expect(result.paused).toEqual([paused]);
    expect(result.recovery).toEqual([recovering]);
  });

  it("folds a batch thread paused with its master under the master, and counts it", () => {
    const master = meta("m", { treeHasPaused: true, projectId: "a" });
    const child = meta("c", { treeHasPaused: true, projectId: "a", masterId: "m" });
    const loner = meta("l", { treeHasPaused: true, projectId: "a", masterId: "other" });
    const result = bannerThreads([master, child, loner], "a", undefined);
    expect(result.paused.map((m) => m.id)).toEqual(["m", "l"]);
    expect(result.batchPaused).toBe(1);
  });

  it("scopes needs-you to the given project, unlike paused and recovery", () => {
    const here = meta("h1", { status: "waiting", projectId: "a" });
    const elsewhere = meta("e1", { status: "waiting", projectId: "b" });
    const result = bannerThreads([here, elsewhere], "a", undefined);
    expect(result.needsYou).toEqual([here]);
  });

  it("shows needs-you from every project when projectId is null", () => {
    const here = meta("h1", { status: "waiting", projectId: "a" });
    const elsewhere = meta("e1", { status: "waiting", projectId: "b" });
    const result = bannerThreads([here, elsewhere], null, undefined);
    expect(result.needsYou).toEqual([here, elsewhere]);
  });

  it("drops the thread already on screen from needs-you", () => {
    const open = meta("h1", { status: "waiting" });
    const result = bannerThreads([open], null, "h1");
    expect(result.needsYou).toEqual([]);
  });

  it("skips archived and subagent-child threads everywhere", () => {
    const archived = meta("a1", { treeHasPaused: true, archived: true });
    const child = meta("c1", { treeCanContinue: true, parentId: "a1" });
    const result = bannerThreads([archived, child], null, undefined);
    expect(result.paused).toEqual([]);
    expect(result.recovery).toEqual([]);
  });
});

describe("pausedText", () => {
  it("names the one paused thread, or counts them, and the Mac jobs waiting with it", () => {
    expect(pausedText([{ title: "Build" }], 0)).toBe("Build is paused");
    expect(pausedText([{ title: "Build" }], 2)).toBe("Build is paused, and 2 Mac jobs with it");
    expect(pausedText([{ title: "A" }, { title: "B" }], 1)).toBe("2 threads paused, and 1 Mac job with it");
  });
  it("counts the batch threads paused with their master before the Mac jobs", () => {
    expect(pausedText([{ title: "Master" }], 0, 3)).toBe("Master is paused, and 3 batch threads with it");
    expect(pausedText([{ title: "Master" }], 2, 1)).toBe("Master is paused, and 1 batch thread with it, and 2 Mac jobs with it");
  });
});

describe("staleWatchers", () => {
  const now = 100 * STALE_WATCH_MS;
  const watching = (id: string, since: number, over: Partial<SessionMeta> = {}): SessionMeta =>
    meta(id, {
      status: "watching",
      projectId: "a",
      background: { tasks: [], agents: [], batch: null, watchingSince: since },
      ...over,
    });

  it("lists roots watching past 30 minutes, oldest first, leaving out fresh ones and the thread on screen", () => {
    const old = watching("old", now - 3 * STALE_WATCH_MS);
    const older = watching("older", now - 5 * STALE_WATCH_MS);
    const fresh = watching("fresh", now - 60_000);
    const onScreen = watching("on-screen", now - 4 * STALE_WATCH_MS);
    const child = watching("child", now - 4 * STALE_WATCH_MS, { parentId: "older" });
    const elsewhere = watching("elsewhere", now - 4 * STALE_WATCH_MS, { projectId: "b" });
    const list = staleWatchers([old, older, fresh, onScreen, child, elsewhere], "a", "on-screen", now);
    expect(list.map((m) => m.id)).toEqual(["older", "old"]);
  });

  it("names one thread with its age and counts several", () => {
    const one = watching("Deploy watch", now - (2 * 3_600_000 + 14 * 60_000));
    expect(staleText([one], now)).toBe("Deploy watch has been watching for 2h 14m");
    expect(staleText([one, one], now)).toBe("2 threads watching for over 30 min");
  });
});
