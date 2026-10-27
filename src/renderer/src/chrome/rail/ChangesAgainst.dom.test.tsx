// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareResult, MergeResult } from "@server/shared/domain";

const h = vi.hoisted(() => ({
  compare: undefined as CompareResult | null | undefined,
  branches: { locals: ["feat", "master"], remotes: ["origin/master"], current: "feat" } as { locals: string[]; remotes: string[]; current: string },
  fetchError: null as Error | null,
  merge: vi.fn((): Promise<MergeResult> => Promise.resolve({ ok: true, sha: "abc1234def", fastForward: false })),
  land: vi.fn((): Promise<MergeResult> => Promise.resolve({ ok: true, sha: "fff0000aaa", fastForward: true })),
  review: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/projectRailStore", () => ({
  fetchBranches: () => Promise.resolve(),
  fetchCompare: () => (h.fetchError ? Promise.reject(h.fetchError) : Promise.resolve(h.compare)),
  fetchLog: () => Promise.resolve(),
  mergeFrom: h.merge,
  mergeInto: h.land,
  useBranchList: () => h.branches,
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
  h.branches = { locals: ["feat", "master"], remotes: ["origin/master"], current: "feat" };
  h.fetchError = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("ChangesAgainst", () => {
  it("lists the files changed since the merge base and opens one against it", async () => {
    mount();
    await flush();
    // Ahead and behind are the commits fold's alone, never repeated in the header.
    expect(screen.queryByText("↑2 ↓1")).toBeNull();
    expect(screen.queryByLabelText("2 ahead, 1 behind")).toBeNull();
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

  it("a refused move keeps its reason after the comparison refreshes", async () => {
    h.merge.mockImplementationOnce(() => Promise.reject(new Error("Commit or stash your changes first")));
    mount();
    await flush();
    move("Update from master");
    await flush();
    await flush();
    expect(screen.getByText("Commit or stash your changes first")).toBeTruthy();
  });

  it("an up-to-date branch says nothing under the picker", async () => {
    h.compare = compareOf({ ahead: 0, behind: 0, ours: [], theirs: [], files: [] });
    const { container } = mount();
    await flush();
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect(screen.queryByText(/No file differs/)).toBeNull();
    expect(screen.queryByRole("button", { name: /commits/ })).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("no file differs but commits do: the line names no branch, the fold says the commits", async () => {
    h.compare = compareOf({ files: [] });
    mount();
    await flush();
    expect(screen.getByText("No file differs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /2 commits ahead/ })).toBeTruthy();
  });

  it("with no target and none to default to, the picker stands alone: no skeleton, no error", async () => {
    localStorage.removeItem("compare-target:p1");
    h.compare = null;
    h.branches = { locals: ["master"], remotes: [], current: "master" };
    const { container } = mount();
    await flush();
    expect(screen.getByRole("combobox", { name: "Compare against" }).textContent).toContain("Choose a branch");
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
    expect(screen.queryByText(/main/)).toBeNull();
  });

  it("a picked branch that is gone says so in words", async () => {
    localStorage.setItem("compare-target:p1", "old-feature");
    h.compare = undefined;
    h.fetchError = new Error("unknown branch: old-feature");
    mount();
    await flush();
    expect(screen.getByText("old-feature no longer exists")).toBeTruthy();
    expect(screen.queryByText(/unknown branch/)).toBeNull();
  });
});
