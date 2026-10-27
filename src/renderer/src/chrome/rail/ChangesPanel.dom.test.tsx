// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffIndex, GitPr } from "../../lib/fs";

const h = vi.hoisted(() => ({
  index: null as GitDiffIndex | null,
  project: false,
  pr: null as GitPr | null,
  confirm: vi.fn(() => Promise.resolve(true)),
  review: vi.fn(),
  openUrl: vi.fn(() => Promise.resolve()),
  generate: vi.fn(() => Promise.resolve("Tidy the panel")),
  git: {
    gitCommit: vi.fn(() => Promise.resolve()),
    gitPush: vi.fn(() => Promise.resolve()),
    gitPull: vi.fn(() => Promise.resolve()),
    gitStash: vi.fn(() => Promise.resolve()),
    gitSync: vi.fn(() => Promise.resolve()),
    gitStageFile: vi.fn(() => Promise.resolve()),
    gitUnstageFile: vi.fn(() => Promise.resolve()),
    gitDiscardFile: vi.fn(() => Promise.resolve()),
    gitStageAll: vi.fn(() => Promise.resolve()),
    gitUnstageAll: vi.fn(() => Promise.resolve()),
    gitStageContents: vi.fn(() => Promise.resolve()),
    gitPrCreate: vi.fn(() => Promise.resolve("https://github.com/o/r/pull/7\n")),
    gitPrStatus: vi.fn(() => Promise.resolve(h.pr)),
    gitFileDiff: vi.fn(() =>
      Promise.resolve({ original: "a\nb\nc\nd\ne\nf\ng\nh\n", current: "a\nB\nc\nd\ne\nf\nG\nh\n", binary: false, tooLarge: false }),
    ),
  },
}));

vi.mock("../../lib/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/fs")>()),
  ...h.git,
  notifyGitChanged: () => {},
}));
vi.mock("../../lib/gitIndexStore", () => ({ useGitIndex: () => h.index, refreshGitSnapshot: () => Promise.resolve() }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/tcserver/projects", () => ({
  environmentOfCwd: () => "local",
  projectForCwd: (cwd: string) => (h.project && cwd === "/p" ? { id: "p1", cwd: "/p" } : undefined),
}));
vi.mock("../../lib/tcserver/workspaces", () => ({ useProjects: () => [] }));
vi.mock("./ChangesAgainst", () => ({ ChangesAgainst: ({ projectId }: { projectId: string }) => <section aria-label="Against">{projectId}</section> }));
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("../../lib/openInEditor", () => ({ editorLabelFor: () => "Open in VS Code", openInEditor: vi.fn() }));
vi.mock("../../lib/fileWatch", () => ({ invalidateWatchedFiles: () => {} }));
vi.mock("../../lib/harness", () => ({
  generateCommitMessage: h.generate,
  generatePrContent: () => Promise.resolve({ title: "T", body: "B", base: "master", head: "feat" }),
}));
vi.mock("../../lib/native", () => ({ openUrl: h.openUrl }));
vi.mock("../../lib/reviewRequest", () => ({ requestReview: h.review }));
vi.mock("../ConfirmDialog", () => ({ confirmAction: h.confirm, errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock("../../surfaces/editorGit", () => ({
  hunksOf: () => [
    { from: 2, to: 2, additions: 1, deletions: 1, pos: 2 },
    { from: 7, to: 7, additions: 1, deletions: 1, pos: 12 },
  ],
  stageChunkText: () => "staged text",
}));

// Base UI's scroll area asks for running animations; jsdom has none.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { ChangesPanel, changesRules } from "./ChangesPanel";

const file = (relative: string, over: Partial<GitDiffIndex["files"][number]> = {}) => ({
  path: `/p/${relative}`,
  relative,
  status: "modified",
  additions: 3,
  deletions: 1,
  staged: false,
  unstaged: true,
  ...over,
});

const indexOf = (over: Partial<GitDiffIndex> = {}): GitDiffIndex => ({
  branch: "feat",
  files: [],
  additions: 0,
  deletions: 0,
  remote: "origin",
  upstream: "origin/feat",
  defaultBranch: "master",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  ...over,
});

const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));
const onOpenDiff = vi.fn();
const mount = () => render(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} onOpenFile={() => {}} />);
const menuItem = (name: string) => screen.getByRole("menuitem", { name });

beforeEach(() => {
  h.index = null;
  h.pr = null;
  h.project = false;
  vi.clearAllMocks();
  h.confirm.mockImplementation(() => Promise.resolve(true));
});
afterEach(cleanup);

describe("ChangesPanel", () => {
  it("loads as skeleton rows, and an empty checkout is one Empty", async () => {
    const { rerender } = mount();
    expect(screen.getByLabelText("Loading changes")).toBeTruthy();
    h.index = indexOf();
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} />);
    await flush();
    expect(screen.getByText("No changes")).toBeTruthy();
    expect(screen.queryByLabelText("Commit message")).toBeNull();
  });

  it("names the groups only when both have rows", async () => {
    h.index = indexOf({ files: [file("src/a.ts")] });
    const { rerender } = mount();
    await flush();
    expect(screen.queryByRole("heading", { name: /Staged|Changes/ })).toBeNull();
    h.index = indexOf({ files: [file("src/a.ts"), file("src/b.ts", { staged: true, unstaged: false })] });
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} />);
    expect(screen.getByRole("heading", { name: /Staged/ }).textContent).toBe("Staged1");
    expect(screen.getByRole("heading", { name: /Changes/ }).textContent).toBe("Changes1");
  });

  it("a row opens its diff against HEAD; a deleted file does not open", async () => {
    h.index = indexOf({ files: [file("src/a.ts"), file("src/gone.ts", { status: "deleted" })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open the diff of src/a.ts" }));
    expect(h.review).toHaveBeenCalledWith("/p/src/a.ts", "HEAD");
    expect(onOpenDiff).toHaveBeenCalledWith("/p/src/a.ts");
    expect((screen.getByRole("button", { name: "src/gone.ts, deleted" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Deleted")).toBeTruthy();
  });

  it("Stage, Unstage and Discard call git; Discard only after the confirm", async () => {
    h.index = indexOf({ files: [file("a.ts"), file("b.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await flush();
    expect(h.git.gitStageFile).toHaveBeenCalledWith("local", "/p", "a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Unstage" }));
    await flush();
    expect(h.git.gitUnstageFile).toHaveBeenCalledWith("local", "/p", "b.ts");
    h.confirm.mockImplementationOnce(() => Promise.resolve(false));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(h.git.gitDiscardFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(h.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Discard changes in a.ts?", danger: true }));
    expect(h.git.gitDiscardFile).toHaveBeenCalledWith("local", "/p", "a.ts");
  });

  it("the right-click menu offers the row's verbs", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    mount();
    await flush();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open the diff of a.ts" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open diff", "Open in VS Code", "Stage", "Discard…"]);
  });

  it("a modified file folds open into its hunks and stages one", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByText("L2")).toBeTruthy();
    expect(screen.getByText("L7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage lines 2" }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(h.git.gitStageContents).toHaveBeenCalledWith("local", "/p", "a.ts", "staged text");
  });

  it("generate fills the field; Commit and ⌘↩ commit the index", async () => {
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Generate commit message" }));
    await flush();
    const field = screen.getByLabelText("Commit message") as HTMLTextAreaElement;
    expect(field.value).toBe("Tidy the panel");
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await flush();
    expect(h.git.gitCommit).toHaveBeenCalledWith("local", "/p", "Tidy the panel");
    expect(h.git.gitPush).not.toHaveBeenCalled();
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "Second" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await flush();
    expect(h.git.gitCommit).toHaveBeenLastCalledWith("local", "/p", "Second");
  });

  it("Commit's menu commits and pushes, or pushes and opens a pull request", async () => {
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    const field = screen.getByLabelText("Commit message");
    fireEvent.change(field, { target: { value: "One" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit options" }));
    fireEvent.click(menuItem("Commit & push"));
    await flush();
    expect(h.git.gitCommit).toHaveBeenCalledWith("local", "/p", "One");
    expect(h.git.gitPush).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: "Two" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit options" }));
    fireEvent.click(menuItem("Commit, push & create PR"));
    await flush();
    await flush();
    expect(h.git.gitPush).toHaveBeenCalledTimes(2);
    expect(h.git.gitPrCreate).toHaveBeenCalledWith("local", "/p", "T", "B", "master", "feat");
    expect(h.openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
  });

  it("the ⋯ menu pulls, pushes, stashes and stages everything", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    mount();
    await flush();
    for (const [name, fn] of [
      ["Pull", h.git.gitPull],
      ["Push", h.git.gitPush],
      ["Stash changes", h.git.gitStash],
      ["Stage all", h.git.gitStageAll],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "More git actions" }));
      fireEvent.click(menuItem(name));
      await flush();
      expect(fn).toHaveBeenCalled();
    }
  });

  it("Sync, Publish, Create PR and PR #n show by the rules", async () => {
    h.index = indexOf({ ahead: 2, behind: 1 });
    const { rerender } = mount();
    await flush();
    expect(screen.getByRole("button", { name: "Sync with origin/feat" }).textContent).toContain("↓1 ↑2");
    fireEvent.click(screen.getByRole("button", { name: "Sync with origin/feat" }));
    await flush();
    expect(h.git.gitSync).toHaveBeenCalled();

    h.index = indexOf({ upstream: null });
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();

    h.index = indexOf({ aheadOfDefault: 3 });
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} />);
    expect(screen.getByRole("button", { name: "Create PR" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync|Publish/ })).toBeNull();
  });

  it("an open pull request is one button to it", async () => {
    h.pr = { number: 12, title: "Feat", url: "https://github.com/o/r/pull/12", state: "open" };
    h.index = indexOf({ aheadOfDefault: 3 });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "PR #12" }));
    expect(h.openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/12");
    expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
  });

  it("pushing to the default branch asks first", async () => {
    h.index = indexOf({ branch: "master", upstream: "origin/master", ahead: 1 });
    h.confirm.mockImplementationOnce(() => Promise.resolve(false));
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sync with origin/master" }));
    await flush();
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Push to master?" }));
    expect(h.git.gitSync).not.toHaveBeenCalled();
  });

  it("a failed step is one red line", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    h.git.gitStageFile.mockImplementationOnce(() => Promise.reject(new Error("index.lock exists")));
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stage" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("index.lock exists");
  });
});

describe("ChangesPanel against a target", () => {
  it("shows the Against group under the files when the checkout is a project's", async () => {
    h.index = indexOf();
    h.project = true;
    mount();
    await flush();
    expect(screen.getByRole("region", { name: "Against" }).textContent).toBe("p1");
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("has no Against group outside a project", async () => {
    h.index = indexOf();
    mount();
    await flush();
    expect(screen.queryByRole("region", { name: "Against" })).toBeNull();
  });
});

describe("changesRules", () => {
  it("diverged branches never commit and push", () => {
    const index = indexOf({ ahead: 1, behind: 1, files: [file("a.ts", { staged: true })] });
    const rules = changesRules(index, null, "msg", false);
    expect(rules.canCommit).toBe(true);
    expect(rules.canCommitPush).toBe(false);
  });

  it("the default branch never opens a pull request", () => {
    const index = indexOf({ branch: "master", files: [file("a.ts", { staged: true })], aheadOfDefault: 2 });
    const rules = changesRules(index, null, "msg", false);
    expect(rules.canCommitPushPr).toBe(false);
    expect(rules.canCreatePr).toBe(false);
  });
});
