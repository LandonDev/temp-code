import { beforeEach, describe, expect, it, vi } from "vitest";

const { openListeners, pushListeners, request } = vi.hoisted(() => ({
  openListeners: [] as (() => void)[],
  pushListeners: [] as ((push: unknown) => void)[],
  request: vi.fn(() => Promise.resolve(null)),
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

vi.mock("./tcserver/workspaces", () => ({
  workspaceStore: {
    projects: [{ id: "p1", cwd: "/w/one" }],
    subscribe: () => () => {},
    getSnapshot: () => ({ loaded: true }),
  },
}));

vi.mock("./tcserver/projects", () => ({
  projectForCwd: (cwd: string) => (cwd === "/w/one" ? { id: "p1", cwd } : null),
  dirPrefix: (cwd: string) => `${cwd}/`,
}));

import { onFileEvent, watchCwd, watchProject, watchedProjectIds, type FileEvent } from "./projectWatch";

beforeEach(() => request.mockClear());

describe("projectWatch", () => {
  it("holds one server subscription per project across holders", () => {
    const a = watchProject("p1");
    const b = watchProject("p1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    a();
    expect(request).toHaveBeenCalledTimes(1);
    b();
    expect(request).toHaveBeenLastCalledWith("fs.watch", { projectId: "p1", subscribe: false });
    expect(watchedProjectIds()).toEqual([]);
  });

  it("resubscribes every held project when the socket reopens", () => {
    const release = watchProject("p1");
    request.mockClear();
    for (const l of openListeners) l();
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    release();
  });

  it("resolves a cwd to its project and fans events out as absolute paths", () => {
    const release = watchCwd("/w/one");
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    const seen: FileEvent[] = [];
    const off = onFileEvent((e) => seen.push(e));
    for (const l of pushListeners) l({ push: "file-event", projectId: "p1", path: "src/a.ts", kind: "changed" });
    for (const l of pushListeners) l({ push: "file-event", projectId: "nope", path: "x", kind: "changed" });
    expect(seen).toEqual([{ projectId: "p1", path: "/w/one/src/a.ts", relative: "src/a.ts", kind: "changed" }]);
    off();
    release();
    expect(watchCwd("/elsewhere")).toBeTypeOf("function");
  });
});
