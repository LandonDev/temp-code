import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fileListeners, gitListeners, gitDiffIndex, gitLog, release, watchCwd } = vi.hoisted(() => ({
  fileListeners: [] as ((e: { path: string }) => void)[],
  gitListeners: [] as (() => void)[],
  gitDiffIndex: vi.fn(),
  gitLog: vi.fn(() => Promise.resolve([{ hash: "a".repeat(40), short: "aaaaaaa", subject: "one", author: "x", date: "2026-01-01T00:00:00Z" }])),
  release: vi.fn(),
  watchCwd: vi.fn(),
}));

vi.mock("./fs", () => ({
  gitDiffIndex,
  gitLog,
  subscribeGitChanged: (l: () => void) => {
    gitListeners.push(l);
    return () => gitListeners.splice(gitListeners.indexOf(l), 1);
  },
}));

vi.mock("./projectWatch", () => ({
  watchCwd,
  onFileEvent: (l: (e: { path: string }) => void) => {
    fileListeners.push(l);
    return () => fileListeners.splice(fileListeners.indexOf(l), 1);
  },
}));

import { getGitSnapshot, holdGitSnapshot, refreshGitSnapshot, resetGitSnapshots } from "./gitIndexStore";

const index = (n: number) => ({ branch: `b${n}`, files: [], additions: 0, deletions: 0, ahead: 0, behind: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  let n = 0;
  gitDiffIndex.mockImplementation(() => Promise.resolve(index(++n)));
  watchCwd.mockReturnValue(release);
});

afterEach(() => {
  resetGitSnapshots();
  gitDiffIndex.mockReset();
  watchCwd.mockReset();
  release.mockClear();
  fileListeners.length = 0;
  gitListeners.length = 0;
  vi.useRealTimers();
});

describe("gitIndexStore", () => {
  it("loads once on hold, through the server watcher, and stops with the last holder", async () => {
    const a = holdGitSnapshot("/w/one");
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
});
