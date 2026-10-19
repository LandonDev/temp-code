// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fileListeners, gitListeners, gitDiffIndex, gitLog, invalidateWatchedFiles, release, watchCwd } = vi.hoisted(() => ({
  fileListeners: [] as ((e: { path: string }) => void)[],
  gitListeners: [] as (() => void)[],
  gitDiffIndex: vi.fn(),
  invalidateWatchedFiles: vi.fn(),
  gitLog: vi.fn(() => Promise.resolve([{ hash: "a".repeat(40), short: "aaaaaaa", subject: "one", author: "x", date: "2026-01-01T00:00:00Z" }])),
  release: vi.fn(),
  watchCwd: vi.fn(),
}));

vi.mock("./fs", async () => {
  // The real scoped subscription, plus a hand-fired list for the older cases.
  const real = await vi.importActual<typeof import("./gitChanged")>("./gitChanged");
  return {
    gitDiffIndex,
    gitLog,
    subscribeGitChanged: (l: () => void, cwd?: string | null) => {
      gitListeners.push(l);
      const stop = real.subscribeGitChanged(l, cwd);
      return () => {
        gitListeners.splice(gitListeners.indexOf(l), 1);
        stop();
      };
    },
  };
});

vi.mock("./fileWatch", () => ({ invalidateWatchedFiles }));

vi.mock("./projectWatch", () => ({
  watchCwd,
  onFileEvent: (l: (e: { path: string }) => void) => {
    fileListeners.push(l);
    return () => fileListeners.splice(fileListeners.indexOf(l), 1);
  },
}));

import { notifyGitChanged } from "./gitChanged";
import {
  getGitSnapshot,
  holdGitSnapshot,
  isGitSnapshotHeld,
  refreshGitSnapshot,
  resetGitSnapshots,
  statsOf,
} from "./gitIndexStore";

const file = (relative: string, additions = 1) => ({
  path: `/w/one/${relative}`,
  relative,
  status: "modified",
  additions,
  deletions: 0,
  staged: false,
  unstaged: true,
});
const index = (n: number, files: ReturnType<typeof file>[] = []) => ({
  branch: `b${n}`,
  files,
  additions: files.reduce((s, f) => s + f.additions, 0),
  deletions: 0,
  remote: null,
  upstream: null,
  defaultBranch: null,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
  let n = 0;
  gitDiffIndex.mockImplementation(() => Promise.resolve(index(++n)));
  watchCwd.mockReturnValue(release);
});

afterEach(() => {
  resetGitSnapshots();
  gitDiffIndex.mockReset();
  gitLog.mockClear();
  invalidateWatchedFiles.mockReset();
  watchCwd.mockReset();
  release.mockClear();
  fileListeners.length = 0;
  gitListeners.length = 0;
  vi.useRealTimers();
});

describe("gitIndexStore", () => {
  it("loads once on hold, through the server watcher, and stops with the last holder", async () => {
    const a = holdGitSnapshot("/w/one", { log: true });
    const b = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    expect(watchCwd).toHaveBeenCalledTimes(1);
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    expect(getGitSnapshot("/w/one").index?.branch).toBe("b1");
    expect(getGitSnapshot("/w/one").log?.[0]?.short).toBe("aaaaaaa");
    a();
    expect(release).not.toHaveBeenCalled();
    b();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fileListeners).toHaveLength(0);
  });

  it("reloads after a burst of file events under the checkout, and ignores others", async () => {
    const stop = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    for (const l of fileListeners) l({ path: "/w/one/src/a.ts" });
    for (const l of fileListeners) l({ path: "/w/one/src/b.ts" });
    for (const l of fileListeners) l({ path: "/w/two/c.ts" });
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    expect(getGitSnapshot("/w/one").index?.branch).toBe("b2");
    for (const l of fileListeners) l({ path: "/w/two/c.ts" });
    await vi.advanceTimersByTimeAsync(250);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    stop();
  });

  it("coalesces refreshes that land while one is in flight", async () => {
    let resolve: ((v: unknown) => void) | null = null;
    gitDiffIndex.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = refreshGitSnapshot("/w/one");
    void refreshGitSnapshot("/w/one");
    void refreshGitSnapshot("/w/one");
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    resolve!(index(9));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    expect(getGitSnapshot("/w/one").index?.branch).toBe("b1");
  });

  it("a burst of git-changed signals with four holders costs one index call per checkout", async () => {
    const stops = [
      holdGitSnapshot("/w/one"),
      holdGitSnapshot("/w/one"),
      holdGitSnapshot("/w/one"),
      holdGitSnapshot("/w/one", { log: true }),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    expect(gitLog).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) {
      for (const l of gitListeners) l();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    expect(gitLog).toHaveBeenCalledTimes(2);
    expect(isGitSnapshotHeld("/w/one")).toBe(true);
    for (const stop of stops) stop();
    expect(isGitSnapshotHeld("/w/one")).toBe(false);
    for (const l of gitListeners) l();
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
  });

  it("a burst of scoped git-changed signals reloads once, and another checkout's signals not at all", async () => {
    const stop = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) {
      notifyGitChanged("/w/one/src");
      notifyGitChanged("/w/two");
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 6; i++) notifyGitChanged("/w/two");
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    // An unscoped signal (a commit from a UI with no cwd) still reaches it.
    notifyGitChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(3);
    stop();
  });

  it("holders without a log reader never fetch the log; stats derive from the index", async () => {
    const stop = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    expect(gitLog).not.toHaveBeenCalled();
    expect(statsOf(getGitSnapshot("/w/one").index)).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(statsOf(null)).toBeNull();
    stop();
  });

  it("keeps the snapshot object when the index is unchanged and re-stats files whose state moved", async () => {
    gitDiffIndex.mockReset();
    gitDiffIndex
      .mockResolvedValueOnce(index(1, [file("a.ts")]))
      .mockResolvedValueOnce(index(1, [file("a.ts")]))
      .mockResolvedValueOnce(index(1, [file("a.ts", 3), file("b.ts")]));
    const stop = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    const first = getGitSnapshot("/w/one");
    await refreshGitSnapshot("/w/one");
    expect(getGitSnapshot("/w/one")).toBe(first);
    expect(invalidateWatchedFiles).not.toHaveBeenCalled();
    await refreshGitSnapshot("/w/one");
    expect(getGitSnapshot("/w/one")).not.toBe(first);
    expect(invalidateWatchedFiles).toHaveBeenCalledWith(["/w/one/a.ts", "/w/one/b.ts"]);
    stop();
  });

  it("defers a refresh while the window is hidden and runs it on focus", async () => {
    const stop = holdGitSnapshot("/w/one");
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    for (const l of gitListeners) l();
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(300);
    expect(gitDiffIndex).toHaveBeenCalledTimes(2);
    stop();
  });
});

vi.mock("./tcserver/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tcserver/projects")>()),
  hostOfCwd: () => "local",
}));
