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

  it("leaves the thread on screen out of paused, and out of recovery for its own failure", () => {
    const open = meta("o", { treeHasPaused: true, treeCanContinue: true, status: "error" });
    const other = meta("p", { treeHasPaused: true });
    const result = bannerThreads([open, other], null, "o");
    expect(result.paused).toEqual([other]);
    expect(result.recovery).toEqual([]);
  });

  it("keeps the thread on screen where nothing on it offers Continue", () => {
    // A descendant failed: the root's transcript has no failure card.
    const failedBelow = meta("f", { treeCanContinue: true, status: "idle" });
    expect(bannerThreads([failedBelow], null, "f").recovery).toEqual([failedBelow]);
    // An orchestration thread has no strip.
    const orchestration = meta("o", { treeHasPaused: true, threadType: "orchestration" });
    expect(bannerThreads([orchestration], null, "o").paused).toEqual([orchestration]);
  });

  it("drops a master on screen with the batch threads folded under it", () => {
    const master = meta("m", { treeHasPaused: true });
    const child = meta("c", { treeHasPaused: true, masterId: "m" });
    const result = bannerThreads([master, child], null, "m");
    expect(result.paused).toEqual([]);
    expect(result.batchPaused).toBe(0);
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
    expect(pausedText([{ title: "Build" }], 0)).toEqual({ subject: "Build", detail: null });
    expect(pausedText([{ title: "Build" }], 2)).toEqual({ subject: "Build", detail: "and 2 Mac jobs with it" });
    expect(pausedText([{ title: "A" }, { title: "B" }], 1)).toEqual({ subject: "2 threads", detail: "and 1 Mac job with it" });
  });
  it("counts the batch threads paused with their master before the Mac jobs", () => {
    expect(pausedText([{ title: "Master" }], 0, 3)).toEqual({ subject: "Master", detail: "and 3 batch threads with it" });
    expect(pausedText([{ title: "Master" }], 2, 1)).toEqual({
      subject: "Master",
      detail: "and 1 batch thread with it, and 2 Mac jobs with it",
    });
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
    expect(staleText([one], now)).toEqual({ subject: "Deploy watch", detail: "2h 14m" });
    expect(staleText([one, one], now)).toEqual({ subject: "2 threads", detail: "for over 30 min" });
  });
});
