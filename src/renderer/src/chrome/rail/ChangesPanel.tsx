import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { Collapsible, CollapsibleContent } from "@renderer/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemMedia } from "@renderer/components/ui/item";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { Textarea } from "@renderer/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { registry } from "../../lib/connection";
import { useEditorConfig } from "../../lib/editorConfig";
import { invalidateWatchedFiles } from "../../lib/fileWatch";
import {
  basename,
  gitCommit,
  gitDiscardFile,
  gitFileDiff,
  gitPrCreate,
  gitPrStatus,
  gitPull,
  gitPush,
  gitStageAll,
  gitStageContents,
  gitStageFile,
  gitStash,
  gitSync,
  gitUnstageAll,
  gitUnstageFile,
  notifyGitChanged,
  type GitChangedFile,
  type GitDiffIndex,
  type GitPr,
} from "../../lib/fs";
import { refreshGitSnapshot, useGitIndex } from "../../lib/gitIndexStore";
import { generateCommitMessage, generatePrContent } from "../../lib/harness";
import { openUrl } from "../../lib/native";
import { editorLabelFor, openInEditor } from "../../lib/openInEditor";
import { MOD } from "../../lib/platform";
import { requestReview } from "../../lib/reviewRequest";
import type { OpenFileFn } from "../../lib/search";
import { environmentOfCwd, projectForCwd } from "../../lib/tcserver/projects";
import { useProjects } from "../../lib/tcserver/workspaces";
import { IconAction } from "../../surfaces/transcript/IconAction";
import { confirmAction, errorText } from "../ConfirmDialog";
import { FileTypeIcon } from "../FileTypeIcon";
import { AgainstCommits, AgainstFileRow, AgainstHead, useAgainst, type AgainstModel } from "./ChangesAgainst";
import { BranchPicker } from "../BranchPicker";
import { RowsContextMenu, tidy, type MenuRow } from "../menuRows";
import { VirtualRows } from "../railVirtualRows";
import { SessionActionsContext } from "../../surfaces/threadChat";
import { Counts, FileName } from "./changeRows";
import { changesItems, estimateItem, foldKey, type ChangeSide, type ChangesItem } from "./changesItems";
import { ChevronDown, ChevronRight, ExternalLink, GitCompare, Minus, MoreHorizontal, Plus, Trash2, Undo2, WandSparkles } from "../icons";

/**
 * The right panel's Changes section: the one place a checkout's changes
 * are listed (docs/DESIGN.md "Panels"). The branch with Sync or Publish
 * and the pull request at the top, pull, push, stash and stage-all in a
 * ⋯ menu; the index staged and unstaged, rows opening the file against
 * HEAD, a modification folding open into hunks, stageable one by one under
 * Changes and unstageable one by one under Staged; the branch against a target below (ChangesAgainst, the project's
 * when the checkout is one); the
 * commit field pinned at the foot with the generated message and Commit's
 * menu (and push; push and create a PR). Refreshes ride the server's tree
 * watcher through `gitIndexStore`; nothing here polls.
 *
 * The scroll body is one virtual list (changesItems.ts, the rail's
 * VirtualRows): only the rows near the viewport mount, one context menu
 * serves them all, and a row carries a Collapsible only once its fold has
 * opened, so the section costs the same with 10 files or 10,000.
 */

export interface Hunk {
  /** 1-based line span in the working copy */
  from: number;
  to: number;
  additions: number;
  deletions: number;
  /** offset in the working copy, inside the chunk */
  pos: number;
}

/** A fold's two texts: index → working copy under Changes, HEAD → index
 *  under Staged; either way `current` is the side the hunks sit in. */
interface HunkSet {
  original: string;
  current: string;
  hunks: Hunk[];
}

export { foldKey, type ChangeSide };

/** A folded-open file's hunks, or "loading" while its diff is read. */
export type HunkFold = { hunks: Hunk[] } | "loading";

async function loadHunks(environmentId: string, cwd: string, relative: string, side: ChangeSide): Promise<HunkSet> {
  let original: string;
  let current: string;
  if (side === "staged") {
    // The staged side's texts: HEAD's (the original against HEAD) and the index's (the original against the index).
    const [head, index] = await Promise.all([
      gitFileDiff(environmentId, cwd, relative, "HEAD"),
      gitFileDiff(environmentId, cwd, relative, "index"),
    ]);
    if (head.binary || head.tooLarge || index.binary || index.tooLarge) return { original: "", current: "", hunks: [] };
    original = head.original;
    current = index.original;
  } else {
    const diff = await gitFileDiff(environmentId, cwd, relative);
    if (diff.binary || diff.tooLarge) return { original: "", current: "", hunks: [] };
    original = diff.original;
    current = diff.current;
  }
  // The editor's git helpers (and CodeMirror's diff under them) stay out
  // of the index bundle (the editor chunk, surfaces/chunks.ts): the panel
  // only needs them once a file is folded open.
  const { hunksOf } = await import("../../surfaces/editorGit");
  return { original, current, hunks: hunksOf(original, current) };
}

/** What the section offers, from the index, the PR and the field. */
export interface ChangesRules {
  canCommit: boolean;
  canCommitPush: boolean;
  canCommitPushPr: boolean;
  canGenerate: boolean;
  canCreatePr: boolean;
  canViewPr: boolean;
  canPublish: boolean;
  canSync: boolean;
  onDefault: boolean;
}

export function changesRules(index: GitDiffIndex | null, pr: GitPr | null, message: string, busy: boolean): ChangesRules {
  const files = index?.files ?? [];
  const staged = files.some((f) => f.staged);
  const hasRemote = Boolean(index?.remote);
  const hasOpenPr = pr?.state === "open";
  const ahead = index?.ahead ?? 0;
  const behind = index?.behind ?? 0;
  const diverged = ahead > 0 && behind > 0;
  const onDefault = !!index?.branch && !!index.defaultBranch && index.branch === index.defaultBranch;
  const canCommit = staged && message.trim().length > 0 && !busy;
  const canCommitPush = canCommit && hasRemote && !diverged;
  return {
    canCommit,
    canCommitPush,
    canCommitPushPr: canCommitPush && !hasOpenPr && !onDefault,
    canGenerate: files.length > 0 && !busy,
    canCreatePr:
      hasRemote && !hasOpenPr && !onDefault && !diverged && files.length === 0 && (index?.aheadOfDefault ?? 0) > 0 && behind === 0,
    canViewPr: hasOpenPr && !!pr?.url,
    canPublish: hasRemote && !index?.upstream,
    canSync: hasRemote && Boolean(index?.upstream) && (ahead > 0 || behind > 0),
    onDefault,
  };
}

const prByCwd = new Map<string, GitPr | null>();

/** The branch's open pull request, read on mount, on a branch change and when the window comes forward. */
function usePrStatus(environmentId: string, cwd: string, branch: string | null | undefined): { pr: GitPr | null; reload: () => void } {
  const key = JSON.stringify([environmentId, cwd]);
  const [pr, setPr] = useState<GitPr | null>(() => (cwd && cwd !== "~" && branch ? (prByCwd.get(key) ?? null) : null));
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    if (!cwd || cwd === "~" || !branch) {
      setPr(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void gitPrStatus(environmentId, cwd)
        .then((next) => {
          prByCwd.set(key, next);
          if (!cancelled) setPr(next);
        })
        .catch(() => {
          prByCwd.set(key, null);
          if (!cancelled) setPr(null);
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [environmentId, cwd, branch, key, nonce]);
  return { pr, reload };
}

export function ChangesPanel({
  cwd,
  sessionId,
  busy: threadBusy = false,
  selectedPath,
  onOpenDiff,
  onOpenFile,
}: {
  cwd: string;
  /** The panel's thread: a branch switched in the head is its branch change. */
  sessionId?: string;
  /** The thread's turn is running: its branch does not change under it. */
  busy?: boolean;
  /** the review file the focused tab shows, relative to the git root */
  selectedPath?: string;
  /** opens the file as a review tab; HEAD is parked as its base first */
  onOpenDiff: (path: string) => void;
  /** the fallback for "Open in <editor>" when no editor is set up */
  onOpenFile?: OpenFileFn;
}) {
  const project = projectForCwd(cwd, useProjects());
  const sessionActions = useContext(SessionActionsContext);
  const environmentId = environmentOfCwd(cwd) ?? registry.primary().environmentId;
  const index = useGitIndex(cwd);
  const editorConfig = useEditorConfig();
  const { pr, reload: reloadPr } = usePrStatus(environmentId, cwd, index?.branch);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hunks, setHunks] = useState<Record<string, HunkSet | "loading">>({});
  const files = index?.files ?? [];
  const rules = changesRules(index, pr, message, !!busy);
  const against = useAgainst(project?.id ?? null, onOpenDiff);
  const drop = (key: string) =>
    setHunks((prev) => {
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });

  // Folded-open files keep their hunks current as the index moves.
  useEffect(() => {
    for (const key of Object.keys(hunks)) {
      const side: ChangeSide = key.startsWith("s:") ? "staged" : "unstaged";
      const relative = key.slice(2);
      if (!files.some((f) => f.relative === relative && f.status === "modified" && f[side])) {
        drop(key);
        continue;
      }
      void loadHunks(environmentId, cwd, relative, side).then((set) =>
        setHunks((prev) => (key in prev ? { ...prev, [key]: set } : prev)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, cwd, index]);

  /** Runs one git step with the section busy on `key`, then refreshes what it touched. */
  const run = async (key: string, op: () => Promise<void>, touched?: string[]): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    setError(null);
    let ok = true;
    try {
      await op();
    } catch (e) {
      ok = false;
      setError(errorText(e));
    } finally {
      notifyGitChanged();
      if (touched) {
        invalidateWatchedFiles(touched);
        window.setTimeout(() => invalidateWatchedFiles(touched), 150);
      }
      await refreshGitSnapshot(cwd);
      setBusy(null);
    }
    return ok;
  };

  /** Pushing to the default branch asks first. */
  const confirmDefault = (kind: "push" | "pr"): Promise<boolean> => {
    if (!rules.onDefault || !index?.branch) return Promise.resolve(true);
    return kind === "pr"
      ? confirmAction({ title: `Create a pull request from ${index.branch}?`, body: "This is the default branch.", action: "Create PR" })
      : confirmAction({ title: `Push to ${index.branch}?`, body: "This is the default branch.", action: "Push" });
  };

  const openCreatedPr = async (): Promise<void> => {
    const content = await generatePrContent(cwd);
    if (!content) throw new Error("Could not prepare the pull request");
    const url = await gitPrCreate(environmentId, cwd, content.title, content.body, content.base, content.head);
    await openUrl(url.trim());
  };

  const actions: ChangesActions = {
    open: (file) => {
      if (file.status === "deleted") return;
      requestReview(file.path, "HEAD");
      onOpenDiff(file.path);
    },
    openInEditor: onOpenFile ? (file) => void openInEditor({ path: file.path, cwd }, onOpenFile) : undefined,
    stage: (file) => void run(file.relative, () => gitStageFile(environmentId, cwd, file.relative)),
    unstage: (file) => void run(file.relative, () => gitUnstageFile(environmentId, cwd, file.relative)),
    discard: async (file) => {
      const name = basename(file.relative);
      const ok = await confirmAction(
        file.status === "untracked"
          ? { title: `Delete ${name}?`, body: "The untracked file is deleted for good.", action: "Delete", danger: true }
          : { title: `Discard changes in ${name}?`, body: "The edits are gone for good.", action: "Discard", danger: true },
      );
      if (ok) await run(file.relative, () => gitDiscardFile(environmentId, cwd, file.relative), [file.path]);
    },
    toggleHunks: (file, side) => {
      const key = foldKey(side, file.relative);
      if (key in hunks) {
        drop(key);
        return;
      }
      setHunks((prev) => ({ ...prev, [key]: "loading" }));
      void loadHunks(environmentId, cwd, file.relative, side)
        .then((set) => setHunks((prev) => (key in prev ? { ...prev, [key]: set } : prev)))
        .catch((e) => {
          setError(errorText(e));
          drop(key);
        });
    },
    // Both write the index: Stage takes the hunk from the working copy into it,
    // Unstage puts HEAD's lines back over the hunk in it (positions are the index text's).
    stageHunk: (file, hunk) => {
      const key = foldKey("unstaged", file.relative);
      const set = hunks[key];
      if (!set || set === "loading") return;
      void import("../../surfaces/editorGit").then(({ stageChunkText }) => {
        const contents = stageChunkText(set.original, set.current, hunk.pos);
        if (contents == null) return;
        void run(`${key}#${hunk.from}`, () => gitStageContents(environmentId, cwd, file.relative, contents));
      });
    },
    unstageHunk: (file, hunk) => {
      const key = foldKey("staged", file.relative);
      const set = hunks[key];
      if (!set || set === "loading") return;
      void import("../../surfaces/editorGit").then(({ revertChunkText }) => {
        const contents = revertChunkText(set.original, set.current, hunk.pos);
        if (contents == null) return;
        void run(`${key}#${hunk.from}`, () => gitStageContents(environmentId, cwd, file.relative, contents));
      });
    },
    stageAll: () => void run("stage-all", () => gitStageAll(environmentId, cwd)),
    unstageAll: () => void run("unstage-all", () => gitUnstageAll(environmentId, cwd)),
    pull: () => void run("pull", () => gitPull(environmentId, cwd)),
    push: async () => {
      if (await confirmDefault("push")) await run("push", () => gitPush(environmentId, cwd));
    },
    stash: () => void run("stash", () => gitStash(environmentId, cwd), files.map((f) => f.path)),
    sync: async () => {
      if (!index || !(rules.canSync || rules.canPublish)) return;
      const willPush = !index.upstream || index.ahead > 0;
      if (willPush && !(await confirmDefault("push"))) return;
      if (await run("sync", () => gitSync(environmentId, cwd))) reloadPr();
    },
    createPr: async () => {
      if (!rules.canCreatePr || !(await confirmDefault("pr"))) return;
      const ok = await run("pr", async () => {
        if ((index?.ahead ?? 0) > 0) await gitPush(environmentId, cwd);
        await openCreatedPr();
      });
      if (ok) reloadPr();
    },
    viewPr: () => {
      if (pr?.url) void openUrl(pr.url);
    },
    generate: async () => {
      if (!rules.canGenerate) return;
      setBusy("generate");
      setError(null);
      try {
        setMessage(await generateCommitMessage(cwd));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    commit: async (then) => {
      if (!rules.canCommit) return;
      if (then !== "none" && !(await confirmDefault(then === "pr" ? "pr" : "push"))) return;
      const text = message.trim();
      const ok = await run("commit", async () => {
        await gitCommit(environmentId, cwd, text);
        // The commit landed: the field's work is done even if the push fails.
        // Text typed while git ran is a new message, not this one.
        setMessage((current) => (current.trim() === text ? "" : current));
        if (then !== "none") await gitPush(environmentId, cwd);
        if (then === "pr") await openCreatedPr();
      });
      if (ok && then === "pr") reloadPr();
    },
  };

  const folds: Record<string, HunkFold> = {};
  for (const [key, set] of Object.entries(hunks)) folds[key] = set === "loading" ? set : { hunks: set.hunks };

  return (
    <ChangesView
      index={index}
      pr={pr}
      rules={rules}
      selectedPath={selectedPath}
      busy={busy}
      error={error}
      message={message}
      onMessage={setMessage}
      folds={folds}
      editorLabel={(file) => editorLabelFor(file.path, editorConfig)}
      actions={actions}
      against={against}
      branchPicker={
        index ? (
          <BranchPicker
            variant="head"
            cwd={cwd}
            branch={index.branch ?? undefined}
            enabled={!threadBusy}
            tip={trackingWords(index)}
            onChange={sessionId ? () => sessionActions?.onBranchChange(sessionId) : undefined}
          />
        ) : null
      }
    />
  );
}

export interface ChangesActions {
  open: (file: GitChangedFile) => void;
  /** absent: the section has no way to open a file outside a review tab */
  openInEditor?: (file: GitChangedFile) => void;
  stage: (file: GitChangedFile) => void;
  unstage: (file: GitChangedFile) => void;
  discard: (file: GitChangedFile) => void;
  toggleHunks: (file: GitChangedFile, side: ChangeSide) => void;
  stageHunk: (file: GitChangedFile, hunk: Hunk) => void;
  unstageHunk: (file: GitChangedFile, hunk: Hunk) => void;
  stageAll: () => void;
  unstageAll: () => void;
  pull: () => void;
  push: () => void;
  stash: () => void;
  sync: () => void;
  createPr: () => void;
  viewPr: () => void;
  generate: () => void;
  /** commit the index, then nothing, push, or push and open a pull request */
  commit: (then: "none" | "push" | "pr") => void;
}

/** The Changes section given its data (ChangesPanel; tests; ui:preview fixtures). */
export function ChangesView({
  index,
  pr,
  rules,
  selectedPath,
  busy,
  error,
  message,
  onMessage,
  folds,
  editorLabel,
  actions,
  against,
  branchPicker,
  rowsInFlow = false,
}: {
  index: GitDiffIndex | null;
  pr: GitPr | null;
  rules: ChangesRules;
  selectedPath?: string;
  busy: string | null;
  error: string | null;
  message: string;
  onMessage: (text: string) => void;
  /** keyed by `foldKey(side, relative)` */
  folds: Record<string, HunkFold>;
  editorLabel: (file: GitChangedFile) => string | null;
  actions: ChangesActions;
  /** The Against group's state when the checkout is a project's (useAgainst). */
  against?: AgainstModel | null;
  /** The branch name as the switch (BranchPicker's head); plain text without it. */
  branchPicker?: ReactNode;
  /** Every row in flow, no virtualizer: the ui:preview fixtures, whose document has no layout to measure. */
  rowsInFlow?: boolean;
}) {
  const files = index?.files ?? [];
  const hasStaged = files.some((f) => f.staged);
  const compare = against?.compare;
  const hasAgainst = !!against;
  const items = useMemo(() => changesItems(index, hasAgainst ? { compare } : undefined), [index, hasAgainst, compare]);
  const fileItems = useMemo(() => {
    const byKey = new Map<string, { file: GitChangedFile; side: ChangeSide }>();
    for (const item of items) if (item.kind === "file") byKey.set(item.key, item);
    return byKey;
  }, [items]);
  // The element that scrolls, as state: the list attaches to it the render it arrives.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const rowsFor = (id: string | null): MenuRow[] | null => {
    const row = id ? fileItems.get(id) : undefined;
    return row ? fileMenuRows(row.file, row.side, actions.openInEditor ? editorLabel(row.file) : null) : null;
  };
  const pick = (verb: string, id: string | null): void => {
    const row = id ? fileItems.get(id) : undefined;
    if (!row) return;
    if (verb === "open") actions.open(row.file);
    else if (verb === "editor") actions.openInEditor?.(row.file);
    else if (verb === "stage") actions.stage(row.file);
    else if (verb === "unstage") actions.unstage(row.file);
    else if (verb === "discard") actions.discard(row.file);
  };

  const renderItem = (item: ChangesItem): ReactNode => {
    const body =
      item.kind === "loading" ? (
        <RowsSkeleton />
      ) : item.kind === "empty" ? (
        <Empty className="flex-none py-6">
          <EmptyHeader>
            <EmptyTitle>No changes</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : item.kind === "heading" ? (
        <h3 className="flex h-6 items-center justify-between px-2 text-xs font-medium text-muted-foreground">
          {item.label}
          <span className="tabular-nums">{item.count}</span>
        </h3>
      ) : item.kind === "file" ? (
        <FileRow file={item.file} side={item.side} fold={folds[item.key]} selectedPath={selectedPath} busy={busy} actions={actions} />
      ) : !against ? null : item.kind === "against" ? (
        <AgainstHead model={against} />
      ) : item.kind === "against-file" ? (
        <AgainstFileRow file={item.file} target={against.compare?.target ?? ""} selectedPath={selectedPath} onOpen={against.onOpen} />
      ) : against.compare ? (
        <AgainstCommits compare={against.compare} open={against.commitsOpen} onOpenChange={against.onCommitsOpen} />
      ) : null;
    return item.gap ? <div className="pt-4">{body}</div> : body;
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col" data-slot="changes-section">
        {index ? <TopRow index={index} pr={pr} rules={rules} busy={busy} actions={actions} branchPicker={branchPicker} /> : <TopRowSkeleton />}
        {error ? (
          <p role="alert" className="shrink-0 px-3 pb-2 text-xs break-words text-destructive">
            {error}
          </p>
        ) : null}
        {/* A native scroller, as the rail's and the board's virtual lists have: the
            ScrollArea's thumb measuring read and wrote layout on every mount and resize. */}
        <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto" data-slot="changes-scroller">
          <RowsContextMenu label="File actions" lazyMount rowsFor={rowsFor} onPick={pick}>
            <div className="px-1 pb-3">
              {rowsInFlow ? (
                items.map((item) => <div key={item.key}>{renderItem(item)}</div>)
              ) : (
                <VirtualRows
                  count={items.length}
                  scroller={scroller}
                  scrollMargin={0}
                  gap={0}
                  estimateSize={(i) => estimateItem(items[i]!)}
                  getItemKey={(i) => items[i]!.key}
                  render={(i) => renderItem(items[i]!)}
                  reveal={null}
                  sizeKey="changes"
                />
              )}
            </div>
          </RowsContextMenu>
        </div>
        {index && files.length > 0 ? (
          <CommitFooter staged={hasStaged} message={message} onMessage={onMessage} rules={rules} busy={busy} actions={actions} />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

function TopRowSkeleton() {
  return (
    <div className="flex h-9 shrink-0 items-center px-3" aria-hidden>
      <Skeleton className="h-3.5 w-24" />
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-2 pt-1" aria-busy="true" aria-label="Loading changes">
      {["w-2/3", "w-1/2", "w-3/5"].map((w) => (
        <div key={w} className="flex h-7 items-center gap-2">
          <Skeleton className="size-4" />
          <Skeleton className={cn("h-3.5", w)} />
        </div>
      ))}
    </div>
  );
}

/** Ahead and behind of an upstream, as git's arrows. */
function distance(behind: number, ahead: number): string {
  return [behind > 0 ? `↓${behind}` : "", ahead > 0 ? `↑${ahead}` : ""].filter(Boolean).join(" ");
}

/** Where the branch's commits go: the head's branch name says it on hover. */
export function trackingWords(index: GitDiffIndex): string {
  return index.upstream ? `Tracks ${index.upstream}` : index.remote ? "Not published" : "No remote";
}

function TopRow({
  index,
  pr,
  rules,
  busy,
  actions,
  branchPicker,
}: {
  index: GitDiffIndex;
  pr: GitPr | null;
  rules: ChangesRules;
  busy: string | null;
  actions: ChangesActions;
  branchPicker?: ReactNode;
}) {
  const files = index.files;
  const hasUnstaged = files.some((f) => f.unstaged);
  const hasStaged = files.some((f) => f.staged);
  const branch = index.branch ?? "Detached HEAD";
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-1 pr-2", branchPicker ? "pl-1.5" : "pl-3")}>
      {branchPicker ?? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" />}>{branch}</TooltipTrigger>
          <TooltipContent>{trackingWords(index)}</TooltipContent>
        </Tooltip>
      )}
      {rules.canPublish ? (
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={actions.sync}>
          {busy === "sync" ? <Spinner /> : null}
          Publish
        </Button>
      ) : rules.canSync ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={actions.sync} aria-label={`Sync with ${index.upstream}`} />
            }
          >
            {busy === "sync" ? <Spinner /> : null}
            Sync
            <span className="text-xs tabular-nums text-muted-foreground">{distance(index.behind, index.ahead)}</span>
          </TooltipTrigger>
          <TooltipContent>Pull, then push {index.upstream}</TooltipContent>
        </Tooltip>
      ) : null}
      {rules.canViewPr && pr ? (
        <Button variant="ghost" size="sm" onClick={actions.viewPr}>
          PR #{pr.number}
        </Button>
      ) : rules.canCreatePr ? (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={!!busy} onClick={actions.createPr} />}>
            {busy === "pr" ? <Spinner /> : null}
            Create PR
          </TooltipTrigger>
          <TooltipContent>{index.defaultBranch ? `Into ${index.defaultBranch}` : "Open a pull request"}</TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                aria-label="More git actions"
                render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" />}
              />
            }
          >
            {busy === "pull" || busy === "push" || busy === "stash" || busy === "stage-all" || busy === "unstage-all" ? (
              <Spinner className="size-3" />
            ) : (
              <MoreHorizontal className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" aria-label="More git actions">
          <DropdownMenuItem disabled={!index.upstream || !!busy} onClick={actions.pull}>
            Pull
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!index.remote || !!busy} onClick={actions.push}>
            {index.upstream ? "Push" : "Publish"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={files.length === 0 || !!busy} onClick={actions.stash}>
            Stash changes
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasUnstaged || !!busy} onClick={actions.stageAll}>
            Stage all
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasStaged || !!busy} onClick={actions.unstageAll}>
            Unstage all
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** A row's counts: its side's when the host split them (a file both staged
 *  and unstaged), else the file's own (one side only, or an older host). */
export function countsFor(file: GitChangedFile, side: "staged" | "unstaged"): { additions: number; deletions: number } {
  const split = side === "staged" ? file.stagedCounts : file.unstagedCounts;
  return split ?? { additions: file.additions, deletions: file.deletions };
}

/** A row's right-click verbs (the list's one `RowsContextMenu`). */
export function fileMenuRows(file: GitChangedFile, side: ChangeSide, editor: string | null): MenuRow[] {
  const deleted = file.status === "deleted";
  const untracked = file.status === "untracked";
  return tidy([
    ...(deleted ? [] : [{ kind: "item", id: "open", label: "Open diff", icon: GitCompare } as const]),
    ...(editor && !deleted ? [{ kind: "item", id: "editor", label: editor, icon: ExternalLink } as const] : []),
    side === "staged"
      ? ({ kind: "item", id: "unstage", label: "Unstage", icon: Minus } as const)
      : ({ kind: "item", id: "stage", label: "Stage", icon: Plus } as const),
    ...(side === "unstaged"
      ? [{ kind: "sep" } as const, { kind: "item", id: "discard", label: untracked ? "Delete…" : "Discard…", icon: untracked ? Trash2 : Undo2 } as const]
      : []),
  ]);
}

/** A fold's Collapsible mounts only once the fold opens on this row, so a
 *  closed row carries none. A fresh open mounts it closed for a frame, so its
 *  height animates; a row scrolled back into view with its fold open mounts
 *  it open, with nothing to replay. */
function useFoldPanel(open: boolean): { held: boolean; shown: boolean } {
  const [held, setHeld] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    setHeld(true);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return { held, shown };
}

function FileRow({
  file,
  side,
  fold,
  selectedPath,
  busy,
  actions,
}: {
  file: GitChangedFile;
  side: ChangeSide;
  fold?: HunkFold;
  selectedPath?: string;
  busy: string | null;
  actions: ChangesActions;
}) {
  const deleted = file.status === "deleted";
  const foldable = file.status === "modified";
  // Distinct names when the file is in both groups: each group folds on its own.
  const hunksName = `${side === "staged" ? "staged hunks" : "hunks"} of ${basename(file.relative)}`;
  const open = fold !== undefined;
  const active = selectedPath === file.relative;
  const rowBusy = busy === file.relative;
  const panel = useFoldPanel(open);

  const row = (
    <Item
      size="xs"
      aria-current={active || undefined}
      className={cn("group/row min-h-7 flex-nowrap gap-2 py-0 hover:bg-foreground/5", active && "bg-muted hover:bg-muted")}
    >
      <ItemMedia className="relative z-10 size-4">
        {foldable ? (
          <>
            <span className={cn("grid place-items-center", open ? "opacity-0" : "group-hover/row:opacity-0 group-focus-within/row:opacity-0")}>
              <FileTypeIcon name={file.relative} isDir={false} size={16} />
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={open ? `Hide ${hunksName}` : `Show ${hunksName}`}
              aria-expanded={open}
              onClick={() => actions.toggleHunks(file, side)}
              className={cn(
                "absolute inset-0 size-4 rounded-sm text-muted-foreground hover:text-foreground",
                open ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
              )}
            >
              <ChevronRight className={cn("size-3 transition-transform duration-(--dur-fast) motion-reduce:transition-none", open && "rotate-90")} />
            </Button>
          </>
        ) : (
          <FileTypeIcon name={file.relative} isDir={false} size={16} />
        )}
      </ItemMedia>
      <ItemContent className="min-w-0">
        {/* A deleted file has no diff to open, but its row still takes focus: its actions show on focus. */}
        <Button
          variant="ghost"
          aria-disabled={deleted || undefined}
          onClick={() => actions.open(file)}
          className="static flex h-auto min-w-0 justify-start rounded-none px-0 py-0 text-left font-normal before:absolute before:inset-0 before:content-[''] hover:bg-transparent focus-visible:before:rounded-lg focus-visible:before:ring-2 focus-visible:before:ring-ring active:bg-transparent active:not-aria-[haspopup]:scale-100 aria-disabled:cursor-default"
          aria-label={deleted ? `${file.relative}, deleted` : `Open the diff of ${file.relative}`}
        >
          <FileName relative={file.relative} muted={deleted} />
        </Button>
      </ItemContent>
      <ItemActions className="relative z-10 gap-1">
        {rowBusy ? (
          <Spinner className="size-3 text-muted-foreground" />
        ) : (
          <span className="hidden items-center group-hover/row:flex group-focus-within/row:flex">
            {side === "staged" ? (
              <IconAction label="Unstage" disabled={!!busy} onClick={() => actions.unstage(file)}>
                <Minus className="size-3.5" />
              </IconAction>
            ) : (
              <>
                <IconAction label="Discard" disabled={!!busy} onClick={() => actions.discard(file)}>
                  <Undo2 className="size-3.5" />
                </IconAction>
                <IconAction label="Stage" disabled={!!busy} onClick={() => actions.stage(file)}>
                  <Plus className="size-3.5" />
                </IconAction>
              </>
            )}
          </span>
        )}
        <Counts status={file.status} {...countsFor(file, side)} />
      </ItemActions>
    </Item>
  );

  // The row stays first and keyed by position, so opening its fold never remounts the toggle under the keyboard.
  return (
    <>
      <div className="relative" data-menu-id={foldKey(side, file.relative)}>
        {row}
      </div>
      {foldable && panel.held ? (
        <Collapsible open={panel.shown}>
          <CollapsibleContent>
            <HunkRows file={file} side={side} fold={fold} busy={busy} actions={actions} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  );
}

/** A folded-open file's hunks, aligned under its name. */
function HunkRows({ file, side, fold, busy, actions }: { file: GitChangedFile; side: ChangeSide; fold?: HunkFold; busy: string | null; actions: ChangesActions }) {
  if (!fold) return null;
  if (fold === "loading") {
    return (
      <div className="flex h-7 items-center pl-8" aria-busy="true" aria-label="Loading hunks">
        <Skeleton className="h-3 w-20" />
      </div>
    );
  }
  const staged = side === "staged";
  if (fold.hunks.length === 0) {
    return <p className="flex h-7 items-center pl-8 text-xs text-muted-foreground">{staged ? "Nothing to unstage line by line" : "Nothing to stage line by line"}</p>;
  }
  return (
    <div className="flex flex-col">
      {fold.hunks.map((h) => {
        const span = h.from === h.to ? `L${h.from}` : `L${h.from}–${h.to}`;
        return (
          <div key={h.from} className="group/hunk flex h-7 items-center gap-2 rounded-lg pr-2 pl-8 hover:bg-foreground/5">
            <span className="text-xs tabular-nums text-muted-foreground">{span}</span>
            <Counts status="modified" additions={h.additions} deletions={h.deletions} />
            <span className="flex-1" />
            {busy === `${foldKey(side, file.relative)}#${h.from}` ? (
              <Spinner className="size-3 text-muted-foreground" />
            ) : (
              <span className="opacity-0 group-hover/hunk:opacity-100 group-focus-within/hunk:opacity-100">
                {staged ? (
                  <IconAction label={`Unstage lines ${span.slice(1)}`} disabled={!!busy} onClick={() => actions.unstageHunk(file, h)}>
                    <Minus className="size-3.5" />
                  </IconAction>
                ) : (
                  <IconAction label={`Stage lines ${span.slice(1)}`} disabled={!!busy} onClick={() => actions.stageHunk(file, h)}>
                    <Plus className="size-3.5" />
                  </IconAction>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CommitFooter({
  staged,
  message,
  onMessage,
  rules,
  busy,
  actions,
}: {
  staged: boolean;
  message: string;
  onMessage: (text: string) => void;
  rules: ChangesRules;
  busy: string | null;
  actions: ChangesActions;
}) {
  const committing = busy === "commit";
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-3">
      <div className="relative">
        <Textarea
          value={message}
          rows={1}
          onChange={(e) => onMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            actions.commit("none");
          }}
          placeholder={staged ? "Message" : "Stage files to commit"}
          aria-label="Commit message"
          className="max-h-40 min-h-8 resize-none py-1.5 pr-8 leading-5"
        />
        <span className="absolute top-1 right-1">
          <IconAction label="Generate commit message" disabled={!rules.canGenerate} onClick={actions.generate}>
            {busy === "generate" ? <Spinner className="size-3" /> : <WandSparkles className="size-3.5" />}
          </IconAction>
        </span>
      </div>
      <div className="flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" className="min-w-0 flex-1 rounded-r-none" disabled={!rules.canCommit} onClick={() => actions.commit("none")} />
            }
          >
            {committing ? <Spinner /> : null}
            Commit
          </TooltipTrigger>
          <TooltipContent>Commit {MOD}↩</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Commit options"
            disabled={!rules.canCommit}
            render={<Button size="icon-sm" className="rounded-l-none border-l border-primary-foreground/15" />}
          >
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="Commit options">
            <DropdownMenuItem disabled={!rules.canCommitPush} onClick={() => actions.commit("push")}>
              Commit & push
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!rules.canCommitPushPr} onClick={() => actions.commit("pr")}>
              Commit, push & create PR
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
