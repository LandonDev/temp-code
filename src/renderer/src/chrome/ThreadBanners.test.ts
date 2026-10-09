import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import { bannerThreads } from "./ThreadBanners";

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
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
