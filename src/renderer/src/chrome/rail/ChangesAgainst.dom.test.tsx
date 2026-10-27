// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareResult, MergeResult } from "@server/shared/domain";

const h = vi.hoisted(() => ({
  compare: undefined as CompareResult | undefined,
  merge: vi.fn((): Promise<MergeResult> => Promise.resolve({ ok: true, sha: "abc1234def", fastForward: false })),
  land: vi.fn((): Promise<MergeResult> => Promise.resolve({ ok: true, sha: "fff0000aaa", fastForward: true })),
  review: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/projectRailStore", () => ({
  fetchBranches: () => Promise.resolve(),
  fetchCompare: () => Promise.resolve(h.compare),
  fetchLog: () => Promise.resolve(),
  mergeFrom: h.merge,
  mergeInto: h.land,
  useBranchList: () => ({ locals: ["feat", "master"], remotes: ["origin/master"], current: "feat" }),
  useBuild: () => undefined,
  useCompare: () => h.compare,
  useGitLog: () => [{ sha: "head" }],
}));
vi.mock("../../lib/tcserver/workspaces", () => ({ useProjects: () => [{ id: "p1", workspaceId: "w1", cwd: "/p", branch: "feat" }] }));
vi.mock("../../lib/tcserver/projects", () => ({ dirPrefix: (cwd: string) => `${cwd}/` }));
vi.mock("../../lib/projectWatch", () => ({ onFileEvent: () => () => {} }));
vi.mock("../../lib/reviewRequest", () => ({ requestReview: h.review }));
vi.mock("../../lib/fs", () => ({ notifyGitChanged: () => {}, basename: (p: string) => p.split("/").pop() }));
vi.mock("sonner", () => ({ toast: { success: h.toast } }));

import { ChangesAgainst } from "./ChangesAgainst";

const compareOf = (over: Partial<CompareResult> = {}): CompareResult => ({
  target: "master",
  mergeBase: "base123",
  ahead: 2,
  behind: 1,
  ours: [
    { sha: "aaaaaaa1", subject: "Fold Branch into Changes", authoredAt: Date.now() - 3_600_000 },
    { sha: "aaaaaaa2", subject: "Notes in place", authoredAt: Date.now() - 7_200_000 },
  ],
  theirs: [{ sha: "bbbbbbb1", subject: "A3 usage meter", authoredAt: Date.now() - 600_000 }],
  files: [
    { path: "src/a.ts", adds: 4, dels: 1, status: "modified" },
    { path: "src/new.ts", adds: 9, dels: 0, status: "added" },
  ],
  ...over,
});

const onOpenDiff = vi.fn();
const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));
const mount = () => render(<ChangesAgainst projectId="p1" onOpenDiff={onOpenDiff} />);
const move = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Branch moves" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
};

beforeEach(() => {
  localStorage.setItem("compare-target:p1", "master");
  h.compare = compareOf();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("ChangesAgainst", () => {
  it("lists the files changed since the merge base and opens one against it", async () => {
    mount();
    await flush();
    expect(screen.getByLabelText("2 ahead, 1 behind").textContent).toBe("↑2 ↓1");
    expect(screen.getByText("New")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the diff of src/a.ts against master" }));
    expect(h.review).toHaveBeenCalledWith("/p/src/a.ts", "base123");
    expect(onOpenDiff).toHaveBeenCalledWith("/p/src/a.ts");
  });

  it("folds the commits on each side behind one line", async () => {
    mount();
    await flush();
    const fold = screen.getByRole("button", { name: /2 commits ahead/ });
    expect(fold.textContent).toBe("2 commits ahead1 behind");
    expect(screen.queryByText("Fold Branch into Changes")).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByText("Fold Branch into Changes")).toBeTruthy();
    expect(screen.getByText("A3 usage meter")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ahead" })).toBeTruthy();
  });

  it("Update, Rebase onto and Merge into call the moves and toast the outcome", async () => {
    mount();
    await flush();
    move("Update from master");
    await flush();
    expect(h.merge).toHaveBeenLastCalledWith("p1", "master", "merge");
    expect(h.toast).toHaveBeenLastCalledWith("Merged master  abc1234", undefined);
    move("Rebase onto master");
    await flush();
    expect(h.merge).toHaveBeenLastCalledWith("p1", "master", "rebase");
    expect(h.toast).toHaveBeenLastCalledWith("Rebased onto master  abc1234", undefined);
    move("Merge feat into master");
    await flush();
    expect(h.land).toHaveBeenCalledWith("p1", "master");
    expect(h.toast).toHaveBeenLastCalledWith("Fast-forwarded master  fff0000", undefined);
  });

  it("a remote target offers no merge into it", async () => {
    localStorage.setItem("compare-target:p1", "origin/master");
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Branch moves" }));
    expect(screen.queryByRole("menuitem", { name: /Merge feat into/ })).toBeNull();
  });

  it("conflicts are one Alert naming the files, and nothing changed", async () => {
    h.merge.mockImplementationOnce(() => Promise.resolve({ ok: false, conflicts: ["src/a.ts", "src/b.ts"] }));
    mount();
    await flush();
    move("Update from master");
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Conflicts in 2 files, nothing changed");
    expect(alert.textContent).toContain("src/b.ts");
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("an up-to-date branch says so", async () => {
    h.compare = compareOf({ ahead: 0, behind: 0, ours: [], theirs: [], files: [] });
    mount();
    await flush();
    expect(screen.getByText("Up to date with master")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /commits/ })).toBeNull();
  });
});
