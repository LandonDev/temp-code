import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowDownCircle, Archive, ChevronRight, CloudUpload, Minus, Plus, Undo2 } from "../icons";
import { cn } from "../../motion/cn";
import { StatefulButton, type ButtonState } from "../../motion/StatefulButton";
import { Spinner } from "../../surfaces/threads/bits";
import { diffLineStats, stageChunkText } from "../../surfaces/editorGit";
import { invalidateWatchedFiles } from "../../lib/fileWatch";
import { timeAgo } from "../../lib/format";
import {
  basename,
  gitCommit,
  gitDiscardFile,
  gitFileDiff,
  gitPull,
  gitPush,
  gitStageAll,
  gitStageContents,
  gitStageFile,
  gitStash,
  gitUnstageAll,
  gitUnstageFile,
  notifyGitChanged,
  type GitChangedFile,
  type GitDiffIndex,
} from "../../lib/fs";
import { refreshGitSnapshot, useGitSnapshot } from "../../lib/gitIndexStore";
import { requestReview } from "../../lib/reviewRequest";

/**
 * The Changes tab: the checkout's index, staged and unstaged, on the
 * server's git methods. Rows open the file against HEAD; an unstaged
 * modification unfolds into its hunks, each stageable on its own; the
 * commit box commits the index as it stands. Pull, push and stash sit in
 * the header. Refreshes ride the server's tree watcher through
 * `gitIndexStore` — nothing here polls.
 */

const DIFF_CONFIG = { scanLimit: 5_000, timeout: 100 };

interface Hunk {
  /** 1-based line span in the working copy */
  from: number;
  to: number;
  additions: number;
  deletions: number;
  /** offset in the working copy, inside the chunk */
  pos: number;
}

interface HunkSet {
  original: string;
  current: string;
  hunks: Hunk[];
}

async function loadHunks(cwd: string, relative: string): Promise<HunkSet> {
  const diff = await gitFileDiff(cwd, relative);
  if (diff.binary || diff.tooLarge) return { original: "", current: "", hunks: [] };
  const orig = Text.of(diff.original.split("\n"));
  const cur = Text.of(diff.current.split("\n"));
  const hunks = Chunk.build(orig, cur, DIFF_CONFIG).map((c): Hunk => {
    const start = Math.min(c.fromB, cur.length);
    const from = cur.lineAt(start).number;
    const to = c.fromB === c.toB ? from : cur.lineAt(Math.max(start, Math.min(c.endB, cur.length) - 1)).number;
    return { from, to, pos: c.fromB, ...diffLineStats(cur, [c], orig) };
  });
  return { original: diff.original, current: diff.current, hunks };
}

function syncLabel(index: GitDiffIndex): string {
  if (index.ahead > 0 && index.behind > 0) return `${index.ahead} ahead · ${index.behind} behind`;
  if (index.ahead > 0) return `${index.ahead} to push`;
  if (index.behind > 0) return `${index.behind} to pull`;
  return "No uncommitted changes";
}

export function ChangesPanel({
  cwd,
  onOpenDiff,
}: {
  cwd: string;
  /** opens the file as a review tab; HEAD is parked as its base first */
  onOpenDiff: (path: string) => void;
}) {
  const { index, log } = useGitSnapshot(cwd);
  const reduce = useReducedMotion();
  const [message, setMessage] = useState("");
  const [commitState, setCommitState] = useState<ButtonState>("idle");
  const [pushState, setPushState] = useState<ButtonState>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hunks, setHunks] = useState<Record<string, HunkSet | "loading">>({});

  const files = index?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged);
  const hasRemote = Boolean(index?.remote);
  const hasUpstream = Boolean(index?.upstream);
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  // Unfolded files keep their hunks current as the index moves.
  useEffect(() => {
    for (const relative of Object.keys(hunks)) {
      if (!unstaged.some((f) => f.relative === relative && f.status === "modified")) {
        setHunks((prev) => {
          const { [relative]: _gone, ...rest } = prev;
          return rest;
        });
        continue;
      }
      void loadHunks(cwd, relative).then((set) =>
        setHunks((prev) => (relative in prev ? { ...prev, [relative]: set } : prev)),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, index]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const mutate = async (key: string, op: () => Promise<void>, touched?: string[]) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await op();
    } catch (e) {
      fail(e);
    } finally {
      notifyGitChanged();
      if (touched) {
        invalidateWatchedFiles(touched);
        window.setTimeout(() => invalidateWatchedFiles(touched), 150);
      }
      await refreshGitSnapshot(cwd);
      setBusy(null);
    }
  };

  const discard = (file: GitChangedFile) => {
    const name = basename(file.relative);
    const ok = window.confirm(
      file.status === "untracked" ? `Delete untracked file ${name}?` : `Discard changes in ${name}? This cannot be undone.`,
    );
    if (!ok) return;
    void mutate(file.relative, () => gitDiscardFile(cwd, file.relative), [file.path]);
  };

  const toggleHunks = (file: GitChangedFile) => {
    if (file.relative in hunks) {
      setHunks((prev) => {
        const { [file.relative]: _gone, ...rest } = prev;
        return rest;
      });
      return;
    }
    setHunks((prev) => ({ ...prev, [file.relative]: "loading" }));
    void loadHunks(cwd, file.relative)
      .then((set) => setHunks((prev) => (file.relative in prev ? { ...prev, [file.relative]: set } : prev)))
      .catch(fail);
  };

  const stageHunk = (file: GitChangedFile, set: HunkSet, hunk: Hunk) => {
    const contents = stageChunkText(set.original, set.current, hunk.pos);
    if (contents == null) return;
    void mutate(`${file.relative}#${hunk.from}`, () => gitStageContents(cwd, file.relative, contents));
  };

  const open = (file: GitChangedFile) => {
    if (file.status === "deleted") return;
    requestReview(file.path, "HEAD");
    onOpenDiff(file.path);
  };

  const commit = async (alsoPush: boolean) => {
    if (!canCommit) return;
    const setState = alsoPush ? setPushState : setCommitState;
    setState("loading");
    setBusy("commit");
    setError(null);
    try {
      await gitCommit(cwd, message.trim());
      if (alsoPush) await gitPush(cwd);
      setMessage("");
      setState("success");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      fail(e);
      window.setTimeout(() => setState("idle"), 2500);
    } finally {
      notifyGitChanged();
      await refreshGitSnapshot(cwd);
      setBusy(null);
    }
  };

  const committing = commitState === "loading" || pushState === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-4 text-[11px]">
        <span className="min-w-0 truncate font-medium text-content" title={index?.branch ?? undefined}>
          {index?.branch ?? "—"}
        </span>
        {index && (index.ahead > 0 || index.behind > 0) ? (
          <span className="shrink-0 tabular-nums text-content/50">
            {index.ahead > 0 ? `↑${index.ahead}` : ""}
            {index.ahead > 0 && index.behind > 0 ? " " : ""}
            {index.behind > 0 ? `↓${index.behind}` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        <IconAction
          title={hasUpstream ? "Pull (fast-forward)" : "No upstream to pull from"}
          disabled={!hasUpstream || !!busy}
          busy={busy === "pull"}
          onClick={() => void mutate("pull", () => gitPull(cwd))}
        >
          <ArrowDownCircle className="size-3.5" strokeWidth={1.75} />
        </IconAction>
        <IconAction
          title={hasRemote ? (hasUpstream ? "Push" : "Publish branch") : "No remote"}
          disabled={!hasRemote || !!busy}
          busy={busy === "push"}
          onClick={() => void mutate("push", () => gitPush(cwd))}
        >
          <CloudUpload className="size-3.5" strokeWidth={1.75} />
        </IconAction>
        <IconAction
          title="Stash changes"
          disabled={files.length === 0 || !!busy}
          busy={busy === "stash"}
          onClick={() => void mutate("stash", () => gitStash(cwd), files.map((f) => f.path))}
        >
          <Archive className="size-3.5" strokeWidth={1.75} />
        </IconAction>
      </div>

      {error ? <p className="shrink-0 break-words px-4 pb-2 text-[11px] leading-snug text-danger">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!index ? (
          <div className="flex h-16 items-center justify-center">
            <Spinner className="size-3.5 text-content/50" />
          </div>
        ) : files.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-content/40">{syncLabel(index)}</p>
        ) : (
          <>
            {staged.length > 0 ? (
              <Section
                label={`Staged · ${staged.length}`}
                action={{
                  title: "Unstage all",
                  icon: <Minus className="size-3.5" strokeWidth={1.75} />,
                  onClick: () => void mutate("unstage-all", () => gitUnstageAll(cwd)),
                }}
              >
                {staged.map((file) => (
                  <Row
                    key={`s:${file.relative}`}
                    file={file}
                    reduce={!!reduce}
                    busy={busy === file.relative}
                    onOpen={() => open(file)}
                    actions={
                      <IconAction
                        title="Unstage"
                        disabled={!!busy}
                        onClick={() => void mutate(file.relative, () => gitUnstageFile(cwd, file.relative))}
                      >
                        <Minus className="size-3.5" strokeWidth={1.75} />
                      </IconAction>
                    }
                  />
                ))}
              </Section>
            ) : null}
            {unstaged.length > 0 ? (
              <Section
                label={`Changes · ${unstaged.length}`}
                action={{
                  title: "Stage all",
                  icon: <Plus className="size-3.5" strokeWidth={1.75} />,
                  onClick: () => void mutate("stage-all", () => gitStageAll(cwd)),
                }}
              >
                {unstaged.map((file) => {
                  const set = hunks[file.relative];
                  const foldable = file.status === "modified";
                  return (
                    <div key={`u:${file.relative}`}>
                      <Row
                        file={file}
                        reduce={!!reduce}
                        busy={busy === file.relative}
                        onOpen={() => open(file)}
                        fold={foldable ? { open: set !== undefined, onToggle: () => toggleHunks(file) } : undefined}
                        actions={
                          <>
                            <IconAction title="Discard" disabled={!!busy} onClick={() => discard(file)}>
                              <Undo2 className="size-3.5" strokeWidth={1.75} />
                            </IconAction>
                            <IconAction
                              title="Stage"
                              disabled={!!busy}
                              onClick={() => void mutate(file.relative, () => gitStageFile(cwd, file.relative))}
                            >
                              <Plus className="size-3.5" strokeWidth={1.75} />
                            </IconAction>
                          </>
                        }
                      />
                      {set === "loading" ? (
                        <div className="flex h-7 items-center pl-9">
                          <Spinner className="size-3 text-content/40" />
                        </div>
                      ) : set ? (
                        set.hunks.length === 0 ? (
                          <p className="py-1 pl-9 text-[11px] text-content/40">Nothing to stage line by line</p>
                        ) : (
                          set.hunks.map((h) => (
                            <div
                              key={h.from}
                              className="group flex h-7 items-center gap-2 rounded-md pl-9 pr-2 text-[11px] transition-colors hover:bg-content/5"
                            >
                              <span className="tabular-nums text-content/60">
                                {h.from === h.to ? `L${h.from}` : `L${h.from}–${h.to}`}
                              </span>
                              <span className="tabular-nums">
                                {h.additions > 0 ? <span className="text-success">+{h.additions}</span> : null}
                                {h.additions > 0 && h.deletions > 0 ? " " : ""}
                                {h.deletions > 0 ? <span className="text-danger">−{h.deletions}</span> : null}
                              </span>
                              <span className="flex-1" />
                              <button
                                type="button"
                                disabled={!!busy}
                                onClick={() => stageHunk(file, set, h)}
                                className="rounded px-1.5 py-0.5 text-[10.5px] text-content/50 opacity-0 transition-colors hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
                              >
                                {busy === `${file.relative}#${h.from}` ? "Staging…" : "Stage"}
                              </button>
                            </div>
                          ))
                        )
                      ) : null}
                    </div>
                  );
                })}
              </Section>
            ) : null}
          </>
        )}
      </div>

      {log && log.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-content/10 px-4 py-1.5">
          <p className="h-6 text-[11px] leading-6 text-content/50">Recent</p>
          {log.map((c) => (
            <div key={c.hash} className="flex items-baseline gap-2 py-1">
              <span className="shrink-0 font-mono text-[10.5px] text-content/40">{c.short}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-content" title={c.subject}>
                {c.subject}
              </span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-content/40">{timeAgo(Date.parse(c.date))}</span>
            </div>
          ))}
        </div>
      ) : null}

      {index && files.length > 0 ? (
        <div className="shrink-0 border-t border-content/10 p-3">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void commit(e.metaKey || e.ctrlKey);
            }}
            placeholder={staged.length > 0 ? "Commit message" : "Stage something to commit"}
            disabled={staged.length === 0 || committing}
            aria-label="Commit message"
            className="w-full rounded-md bg-content/10 px-2.5 py-1.5 text-xs text-content outline-none placeholder:text-content/35 disabled:opacity-40"
          />
          <div className="mt-2 flex gap-1.5">
            <StatefulButton
              size="sm"
              variant="secondary"
              state={commitState}
              disabled={!canCommit || committing}
              loadingText="Committing"
              successText="Committed"
              errorText="Failed"
              onClick={() => void commit(false)}
              className="min-w-0 flex-1"
              title="Commit the index (↩)"
            >
              Commit
            </StatefulButton>
            <StatefulButton
              size="sm"
              variant="primary"
              state={pushState}
              disabled={!canCommit || committing || !hasRemote}
              loadingText="Pushing"
              successText="Pushed"
              errorText="Failed"
              onClick={() => void commit(true)}
              className="min-w-0 flex-1"
              title={hasRemote ? "Commit, then push (⌘↩)" : "No remote"}
            >
              Commit & push
            </StatefulButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action: { title: string; icon: ReactNode; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className="pb-1">
      <div className="group flex h-6 items-center px-2">
        <span className="text-[11px] text-content/50">{label}</span>
        <span className="flex-1" />
        <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconAction title={action.title} onClick={action.onClick}>
            {action.icon}
          </IconAction>
        </span>
      </div>
      {children}
    </div>
  );
}

function Row({
  file,
  reduce,
  busy,
  fold,
  actions,
  onOpen,
}: {
  file: GitChangedFile;
  reduce: boolean;
  busy: boolean;
  fold?: { open: boolean; onToggle: () => void };
  actions: ReactNode;
  onOpen: () => void;
}) {
  const name = basename(file.relative);
  const dir = file.relative.includes("/") ? file.relative.slice(0, file.relative.lastIndexOf("/")) : "";
  const deleted = file.status === "deleted";
  return (
    <motion.div
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="group flex h-7 w-full items-center gap-1 rounded-md pl-1 pr-2 transition-colors hover:bg-content/5"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {fold ? (
          <button
            type="button"
            aria-label={fold.open ? "Hide hunks" : "Show hunks"}
            aria-expanded={fold.open}
            onClick={fold.onToggle}
            className="grid size-4 place-items-center rounded text-content/40 hover:text-content"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", fold.open && "rotate-90")}
              strokeWidth={1.75}
            />
          </button>
        ) : null}
      </span>
      <button
        type="button"
        disabled={deleted}
        onClick={onOpen}
        title={file.relative}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left active:scale-[0.99] disabled:active:scale-100"
      >
        <span className={cn("min-w-0 flex-1 truncate text-xs text-content", deleted && "text-content/50 line-through")}>
          {name}
          {dir ? <span className="ml-1.5 text-[11px] text-content/40">{dir}</span> : null}
        </span>
      </button>
      {busy ? (
        <Spinner className="size-3 shrink-0 text-content/50" />
      ) : (
        <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">{actions}</span>
      )}
      <span className="shrink-0 text-[11px] tabular-nums">
        {file.status === "untracked" ? (
          <span className="text-success">new</span>
        ) : (
          <>
            <span className="text-success">+{file.additions}</span>{" "}
            <span className="text-danger">−{file.deletions}</span>
          </>
        )}
      </span>
    </motion.div>
  );
}

function IconAction({
  title,
  disabled,
  busy,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-content/55 transition-colors hover:bg-content/10 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {busy ? <Spinner className="size-3" /> : children}
    </button>
  );
}
