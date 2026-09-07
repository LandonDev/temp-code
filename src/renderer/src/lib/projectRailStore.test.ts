import { beforeEach, describe, expect, it, vi } from "vitest";

const { openListeners, pushListeners, request } = vi.hoisted(() => ({
  openListeners: [] as (() => void)[],
  pushListeners: [] as ((push: unknown) => void)[],
  request: vi.fn((method: string) => {
    if (method === "build.status") return Promise.resolve({ run: { id: "r0", status: "ok" }, lines: ["old"] });
    if (method === "project.compare") return Promise.resolve({ target: "main", ahead: 1, behind: 2, files: [] });
    if (method === "build.pull") return Promise.resolve({ branch: "main", ahead: 0, behind: 0 });
    return Promise.resolve(null);
  }),
}));

vi.mock("./tcserver/client", () => ({
  client: {
    connected: true,
    request,
    onOpen: (l: () => void) => {
      openListeners.push(l);
      return () => {};
    },
    onPush: (l: (push: unknown) => void) => {
      pushListeners.push(l);
      return () => {};
    },
  },
}));

import {
  BUILD_LOG_CAP,
  fetchBuildStatus,
  fetchCompare,
  pullBranch,
  railSnapshot,
  resetRailStore,
} from "./projectRailStore";

const push = (p: unknown) => {
  for (const l of pushListeners) l(p);
};
const run = (id: string, status = "running") => ({ id, status, command: "x", cwd: "/w", branch: null, startedAt: 1, outputs: [] });

beforeEach(() => {
  resetRailStore();
  request.mockClear();
});

describe("projectRailStore", () => {
  it("appends log lines for the same run and replaces them for a new one", () => {
    push({ push: "build", projectId: "p1", run: run("a"), lines: ["1"] });
    push({ push: "build", projectId: "p1", run: run("a"), lines: ["2", "3"] });
    expect(railSnapshot().builds.p1.lines).toEqual(["1", "2", "3"]);
    push({ push: "build", projectId: "p1", run: run("a", "ok") });
    expect(railSnapshot().builds.p1.lines).toEqual(["1", "2", "3"]);
    expect(railSnapshot().builds.p1.run?.status).toBe("ok");
    push({ push: "build", projectId: "p1", run: run("b"), lines: ["fresh"] });
    expect(railSnapshot().builds.p1.lines).toEqual(["fresh"]);
    expect(railSnapshot().builds.p2).toBeUndefined();
  });

  it("caps the log at the last 3000 lines", () => {
    push({ push: "build", projectId: "p1", run: run("a"), lines: ["first"] });
    push({ push: "build", projectId: "p1", run: run("a"), lines: Array.from({ length: BUILD_LOG_CAP + 5 }, (_, i) => `l${i}`) });
    const lines = railSnapshot().builds.p1.lines;
    expect(lines).toHaveLength(BUILD_LOG_CAP);
    expect(lines[0]).toBe("l5");
    expect(lines.at(-1)).toBe(`l${BUILD_LOG_CAP + 4}`);
  });

  it("tracks sync progress per project and clears it when the pull settles", async () => {
    push({ push: "sync", projectId: "p1", branch: "main", line: "Receiving objects: 40%", percent: 40 });
    expect(railSnapshot().syncs.p1).toEqual({ branch: "main", line: "Receiving objects: 40%", percent: 40 });
    await pullBranch("p1", "main");
    expect(request).toHaveBeenCalledWith("build.pull", { projectId: "p1", branch: "main" });
    expect(railSnapshot().syncs.p1).toBeUndefined();
  });

  it("replays build.status into the store and drops everything on reconnect", async () => {
    await fetchBuildStatus("p1");
    expect(railSnapshot().builds.p1).toEqual({ run: { id: "r0", status: "ok" }, lines: ["old"] });
    await fetchCompare("p1");
    expect(request).toHaveBeenCalledWith("project.compare", { projectId: "p1" });
    expect(railSnapshot().compares.p1?.target).toBe("main");
    for (const l of openListeners) l();
    expect(railSnapshot().builds).toEqual({});
    expect(railSnapshot().compares).toEqual({});
  });
});
