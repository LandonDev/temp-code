// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitDiffIndex, GitPr } from "../../lib/fs";

const h = vi.hoisted(() => ({
  index: null as GitDiffIndex | null,
  /** useAgainst's answer for a project's checkout; its row pieces stay real. */
  against: null as unknown,
  revertChunkText: vi.fn((_head: string, _index: string, _pos: number) => "unstaged text"),
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
vi.mock("./ChangesAgainst", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ChangesAgainst")>()),
  useAgainst: (projectId: string | null) => (projectId ? h.against : null),
}));
vi.mock("../../lib/projectRailStore", () => ({}));
vi.mock("../../lib/projectWatch", () => ({ onFileEvent: () => () => {} }));
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
  revertChunkText: h.revertChunkText,
}));

// The head's branch switch: BranchPicker's own tests cover its list; here it reports what the head gave it.
vi.mock("../BranchPicker", () => ({
  BranchPicker: (p: { branch?: string; variant?: string; tip?: string; enabled?: boolean; onChange?: () => void }) => (
    <button type="button" aria-label={`Branch ${p.branch}`} data-variant={p.variant} data-tip={p.tip} disabled={p.enabled === false} onClick={() => p.onChange?.()}>
      {p.branch}
    </button>
  ),
}));

// Base UI's scroll area asks for running animations; jsdom has none.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

import { ChangesPanel, changesRules, fileMenuRows } from "./ChangesPanel";
import type { AgainstModel } from "./ChangesAgainst";
import { SessionActionsContext, type SessionActions } from "../../surfaces/threadChat";

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

const againstOf = (over: Partial<AgainstModel> = {}): AgainstModel => ({
  current: "feat",
  target: "master",
  locals: ["master"],
  remotes: [],
  compare: {
    target: "master",
    mergeBase: "base",
    ahead: 1,
    behind: 0,
    ours: [{ sha: "aaaaaaa1", subject: "One", authoredAt: Date.now() }],
    theirs: [],
    files: [{ path: "src/x.ts", adds: 2, dels: 1, status: "modified" }],
  },
  branchesKnown: true,
  moving: null,
  blocked: false,
  conflicts: null,
  error: null,
  commitsOpen: false,
  onCommitsOpen: vi.fn(),
  onPick: vi.fn(),
  onMove: vi.fn(),
  onOpen: vi.fn(),
  ...over,
});

/** The ResizeObservers the virtualizer made, driven by hand: jsdom has none. */
const observers: { cb: ResizeObserverCallback; els: Set<Element> }[] = [];
class FakeResizeObserver {
  entry: { cb: ResizeObserverCallback; els: Set<Element> };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, els: new Set() };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.els.add(el);
  }
  unobserve(el: Element) {
    this.entry.els.delete(el);
  }
  disconnect() {
    this.entry.els.clear();
  }
}
/** jsdom lays nothing out: the section's scroller is 600px tall, every row has no size of its own. */
const VIEWPORT = '[data-slot="changes-scroller"]';
const sized = (el: HTMLElement, size: number) => (el.matches?.(VIEWPORT) ? size : 0);
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const viewport = (): HTMLElement => document.querySelector(VIEWPORT) as HTMLElement;
const rowsMounted = (): number => document.querySelectorAll("[data-menu-id]").length;

const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));
const onOpenDiff = vi.fn();
const mount = () => render(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} onOpenFile={() => {}} />);
const menuItem = (name: string) => screen.getByRole("menuitem", { name });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  observers.length = 0;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return sized(this, 600); } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) { return sized(this, 320); } });
  h.index = null;
  h.pr = null;
  h.project = false;
  h.against = againstOf();
  vi.clearAllMocks();
  h.confirm.mockImplementation(() => Promise.resolve(true));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
});

describe("ChangesPanel", () => {
  it("the head's branch name is the switch, with its upstream on hover; a switch there is the thread's branch change", async () => {
    h.index = indexOf();
    const onBranchChange = vi.fn();
    render(
      <SessionActionsContext.Provider value={{ onBranchChange } as unknown as SessionActions}>
        <ChangesPanel cwd="/p" sessionId="t1" onOpenDiff={onOpenDiff} />
      </SessionActionsContext.Provider>,
    );
    await flush();
    const head = screen.getByRole("button", { name: "Branch feat" });
    expect(head.getAttribute("data-variant")).toBe("head");
    expect(head.getAttribute("data-tip")).toBe("Tracks origin/feat");
    fireEvent.click(head);
    expect(onBranchChange).toHaveBeenCalledWith("t1");
  });

  it("while the thread's turn runs its branch cannot be switched from the head", async () => {
    h.index = indexOf();
    render(<ChangesPanel cwd="/p" sessionId="t1" busy onOpenDiff={onOpenDiff} />);
    await flush();
    expect((screen.getByRole("button", { name: "Branch feat" }) as HTMLButtonElement).disabled).toBe(true);
  });

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

  it("a partly staged file counts each group's own lines; without the split both rows show the file's", async () => {
    const both = { staged: true, unstaged: true, additions: 3, deletions: 1 };
    h.index = indexOf({ files: [file("a.ts", { ...both, stagedCounts: { additions: 1, deletions: 1 }, unstagedCounts: { additions: 2, deletions: 0 } })] });
    const { rerender, container } = mount();
    await flush();
    const rowText = (group: string) => container.querySelector(`[data-menu-id="${group === "Staged" ? "s" : "u"}:a.ts"]`)!.textContent;
    expect(rowText("Staged")).toContain("+1 −1");
    expect(rowText("Changes")).toContain("+2");
    expect(rowText("Changes")).not.toContain("−");
    h.index = indexOf({ files: [file("a.ts", both)] });
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} />);
    expect(rowText("Staged")).toContain("+3 −1");
    expect(rowText("Changes")).toContain("+3 −1");
  });

  it("a row opens its diff against HEAD; a deleted file does not open", async () => {
    h.index = indexOf({ files: [file("src/a.ts"), file("src/gone.ts", { status: "deleted" })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open the diff of src/a.ts" }));
    expect(h.review).toHaveBeenCalledWith("/p/src/a.ts", "HEAD");
    expect(onOpenDiff).toHaveBeenCalledWith("/p/src/a.ts");
    const gone = screen.getByRole("button", { name: "src/gone.ts, deleted" });
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(gone);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    // Focusable, so its Stage and Discard have a keyboard path.
    gone.focus();
    expect(document.activeElement).toBe(gone);
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

  it("a staged modified file folds open into its hunks between HEAD and the index", async () => {
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show staged hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(h.git.gitFileDiff).toHaveBeenCalledWith("local", "/p", "a.ts", "HEAD");
    expect(h.git.gitFileDiff).toHaveBeenCalledWith("local", "/p", "a.ts", "index");
    expect(screen.getByText("L2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unstage lines 7" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stage lines/ })).toBeNull();
  });

  it("Unstage lines writes the index with that hunk back to HEAD's, at its place in the index text", async () => {
    const head = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const indexText = "a\nB\nc\nd\ne\nf\nG\nh\n";
    const read = ((_env: string, _cwd: string, _rel: string, base?: string) =>
      Promise.resolve({ original: base === "HEAD" ? head : indexText, current: indexText + "more\n", binary: false, tooLarge: false })) as never;
    h.git.gitFileDiff.mockImplementationOnce(read).mockImplementationOnce(read);
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show staged hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    fireEvent.click(screen.getByRole("button", { name: "Unstage lines 7" }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    // HEAD → index, at the second hunk's offset in the index text; the first hunk stays staged.
    expect(h.revertChunkText).toHaveBeenCalledWith(head, indexText, 12);
    expect(h.git.gitStageContents).toHaveBeenCalledWith("local", "/p", "a.ts", "unstaged text");
  });

  it("a file in both groups folds each group on its own", async () => {
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: true })] });
    mount();
    await flush();
    const staged = screen.getByRole("button", { name: "Show staged hunks of a.ts" });
    fireEvent.click(staged);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(staged.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Show hunks of a.ts" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("button", { name: /^Unstage lines/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Stage lines/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getAllByRole("button", { name: /^Stage lines/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide staged hunks of a.ts" }));
    expect(screen.getAllByRole("button", { name: /^Stage lines/ })).toHaveLength(2);
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

  it("text typed while a commit runs is kept", async () => {
    h.index = indexOf({ files: [file("a.ts", { staged: true, unstaged: false })] });
    let finish = () => {};
    h.git.gitCommit.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    mount();
    await flush();
    const field = screen.getByLabelText("Commit message") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await flush();
    fireEvent.change(field, { target: { value: "Next one" } });
    finish();
    await flush();
    expect(field.value).toBe("Next one");
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

describe("ChangesPanel's virtual list", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => file(`notes/${String(i).padStart(5, "0")}.md`, { status: "untracked" }));
  const rowOf = (key: string) => (document.querySelector(`[data-menu-id="${key}"]`)?.closest("[data-index]") ?? null) as HTMLElement | null;

  it("10,000 untracked files mount a screen of rows and no menu until a right-click", async () => {
    h.index = indexOf({ files: many(10_000) });
    const { container } = mount();
    await flush();
    expect(rowsMounted()).toBeGreaterThan(10);
    expect(rowsMounted()).toBeLessThan(60);
    expect(container.querySelectorAll('[data-slot="context-menu-trigger"]')).toHaveLength(0);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open the diff of notes/00003.md" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open diff", "Open in VS Code", "Stage", "Delete…"]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="context-menu-trigger"]').length).toBeLessThanOrEqual(1);
  });

  it("scrolling the viewport mounts the rows under it", async () => {
    h.index = indexOf({ files: many(10_000) });
    mount();
    await flush();
    expect(rowOf("u:notes/00000.md")).toBeTruthy();
    act(() => {
      viewport().scrollTop = 28 * 5_000;
      viewport().dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(rowOf("u:notes/00000.md")).toBeFalsy();
    expect(rowOf("u:notes/05005.md")?.style.transform).toBe(`translateY(${28 * 5_005}px)`);
    expect(rowsMounted()).toBeLessThan(60);
  });

  it("a focused row stays mounted, and focused, when the list scrolls it out of the window", async () => {
    h.index = indexOf({ files: many(10_000) });
    const { rerender } = mount();
    await flush();
    const open = screen.getByRole("button", { name: "Open the diff of notes/00001.md" });
    open.focus();
    act(() => {
      viewport().scrollTop = 28 * 5_000;
      viewport().dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(rowOf("u:notes/05005.md")).toBeTruthy();
    expect(open.isConnected).toBe(true);
    expect(document.activeElement).toBe(open);
    // A refresh drops a file above it: the place stays with the same file.
    h.index = indexOf({ files: many(10_000).slice(1) });
    rerender(<ChangesPanel cwd="/p" onOpenDiff={onOpenDiff} onOpenFile={() => {}} />);
    await flush();
    expect(open.isConnected).toBe(true);
    expect(document.activeElement).toBe(open);
    open.blur();
    act(() => {
      viewport().scrollTop = 28 * 5_001;
      viewport().dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(open.isConnected).toBe(false);
  });

  it("a fold opens inside its row without remounting the toggle, and the row's growth moves the rows under it", async () => {
    h.index = indexOf({ files: [file("a.ts"), file("b.ts")] });
    mount();
    await flush();
    const toggle = screen.getByRole("button", { name: "Show hunks of a.ts" });
    toggle.focus();
    fireEvent.click(toggle);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByRole("button", { name: "Hide hunks of a.ts" })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    const rowA = rowOf("u:a.ts")!;
    expect(within(rowA).getByText("L2")).toBeTruthy();
    const rowB = () => rowOf("u:b.ts")!;
    expect(rowB().style.transform).toBe("translateY(28px)");
    act(() => {
      for (const o of observers) {
        if (o.els.has(rowA)) o.cb([{ target: rowA, borderBoxSize: [{ blockSize: 84, inlineSize: 320 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
    });
    expect(rowB().style.transform).toBe("translateY(84px)");
  });

  it("a closed row carries no fold panel; an opened one keeps its Collapsible once closed", async () => {
    h.index = indexOf({ files: [file("a.ts"), file("b.ts")] });
    const { container } = mount();
    await flush();
    expect(container.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(container.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide hunks of a.ts" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText("L2")).toBeNull();
    expect(container.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(1);
  });

  it("the right-click menu acts on the row it opened on", async () => {
    h.index = indexOf({ files: [file("a.ts"), file("b.ts", { staged: true, unstaged: false })] });
    mount();
    await flush();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open the diff of b.ts" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open diff", "Open in VS Code", "Unstage"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unstage" }));
    await flush();
    expect(h.git.gitUnstageFile).toHaveBeenCalledWith("local", "/p", "b.ts");
  });

  it("a list mounting again starts from its last scroller size, without reading the scroller", async () => {
    h.index = indexOf({ files: many(100) });
    const first = mount();
    await flush();
    const shown = rowsMounted();
    expect(shown).toBeGreaterThan(10);
    first.unmount();
    // A read now would answer zero and mount nothing.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 0 });
    mount();
    await flush();
    expect(rowsMounted()).toBe(shown);
    // The observer's report still wins.
    act(() => {
      for (const o of observers) {
        for (const el of o.els) if (el.matches(VIEWPORT)) o.cb([{ target: el, borderBoxSize: [{ blockSize: 28 * 4, inlineSize: 320 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      }
    });
    expect(rowsMounted()).toBeLessThan(shown);
  });

  it("a row's actions stay reachable from the keyboard", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    mount();
    await flush();
    const open = screen.getByRole("button", { name: "Open the diff of a.ts" });
    open.focus();
    expect(document.activeElement).toBe(open);
    const stage = screen.getByRole("button", { name: "Stage" });
    stage.focus();
    fireEvent.click(stage);
    await flush();
    expect(h.git.gitStageFile).toHaveBeenCalledWith("local", "/p", "a.ts");
  });

  it("the Against group's head, files and commits fold are rows of the same list", async () => {
    h.index = indexOf({ files: [file("a.ts")] });
    h.project = true;
    mount();
    await flush();
    const head = screen.getByRole("region", { name: "Against" }).closest("[data-index]")!;
    const fileRow = screen.getByRole("button", { name: "Open the diff of src/x.ts against master" });
    const fold = screen.getByRole("button", { name: /1 commit ahead/ });
    expect([rowOf("u:a.ts"), head, fileRow.closest("[data-index]"), fold.closest("[data-index]")].map((el) => el?.getAttribute("data-index"))).toEqual(["0", "1", "2", "3"]);
    fireEvent.click(fileRow);
    expect((h.against as AgainstModel).onOpen).toHaveBeenCalledWith("src/x.ts");
    fireEvent.click(fold);
    expect((h.against as AgainstModel).onCommitsOpen).toHaveBeenCalledWith(true, expect.anything());
  });
});

describe("fileMenuRows", () => {
  const labels = (rows: ReturnType<typeof fileMenuRows>) => rows.map((r) => (r.kind === "item" ? r.label : r.kind));
  it("offers the verbs a row's file and side allow", () => {
    expect(labels(fileMenuRows(file("a.ts"), "unstaged", "Open in VS Code"))).toEqual(["Open diff", "Open in VS Code", "Stage", "sep", "Discard…"]);
    expect(labels(fileMenuRows(file("a.ts", { status: "untracked" }), "unstaged", null))).toEqual(["Open diff", "Stage", "sep", "Delete…"]);
    expect(labels(fileMenuRows(file("a.ts", { status: "deleted" }), "unstaged", "Open in VS Code"))).toEqual(["Stage", "sep", "Discard…"]);
    expect(labels(fileMenuRows(file("a.ts"), "staged", "Open in VS Code"))).toEqual(["Open diff", "Open in VS Code", "Unstage"]);
  });
});

describe("ChangesPanel against a target", () => {
  it("shows the Against group under the files when the checkout is a project's", async () => {
    h.index = indexOf();
    h.project = true;
    mount();
    await flush();
    expect(screen.getByRole("region", { name: "Against" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Compare against" })).toBeTruthy();
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
