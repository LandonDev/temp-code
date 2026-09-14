import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { CommitInfo, MergeResult } from "@server/shared/domain";
import { ChevronRight, GitCompare, RefreshCw } from "../icons";
import { cn } from "../../motion/cn";
import { StatefulButton, type ButtonState } from "../../motion/StatefulButton";
import { Spinner } from "../../surfaces/threads/bits";
import { timeAgo } from "../../lib/format";
import { onFileEvent } from "../../lib/projectWatch";
import { dirPrefix } from "../../lib/tcserver/projects";
import { useProjects } from "../../lib/tcserver/workspaces";
import { notifyGitChanged } from "../../lib/fs";
import {
  fetchBranches,
  fetchCompare,
  fetchLog,
  mergeFrom,
  mergeInto,
  useBranchList,
  useBuild,
  useCompare,
  useGitLog,
} from "../../lib/projectRailStore";
import { requestReview } from "../../lib/reviewRequest";
import { RailSelect } from "./RailSelect";

/**
 * The Branch tab: this checkout against a target branch — ahead/behind,
 * the files this branch changed since the merge base (click → diff vs
 * that base), the commits on each side — and the two moves: bring the
 * target in (merge or rebase) or land the branch on it. Conflicts never
 * leave a half-merged tree; the panel lists the files instead.
 */

type Outcome =
  | { kind: "ok"; text: string }
  | { kind: "conflicts"; files: string[] }
  | { kind: "error"; text: string };

const targetKey = (projectId: string): string => `compare-target:${projectId}`;
const MODE_KEY = "compare-mode";

/** Button labels roll letter by letter, so they cannot truncate: clip by hand. */
const short = (b: string): string => {
  const name = b.replace(/^origin\//, "");
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
};

export function BranchPanel({
  projectId,
  onOpenDiff,
}: {
  projectId: string;
  /** opens the file as a review tab; the base ref is parked beforehand */
  onOpenDiff: (path: string) => void;
}) {
  const project = useProjects().find((p) => p.id === projectId);
  const compare = useCompare(projectId);
  const branchList = useBranchList(project?.workspaceId ?? null);
  const headSha = useGitLog(projectId)?.[0]?.sha;
  const buildRunning = useBuild(projectId)?.run?.status === "running";
  const reduce = useReducedMotion();

  const [target, setTarget] = useState<string | null>(() => localStorage.getItem(targetKey(projectId)));
  const [mode, setMode] = useState<"merge" | "rebase">(() =>
    localStorage.getItem(MODE_KEY) === "rebase" ? "rebase" : "merge",
  );
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [updateState, setUpdateState] = useState<ButtonState>("idle");
  const [landState, setLandState] = useState<ButtonState>("idle");
  const [aheadOpen, setAheadOpen] = useState(false);
  const [behindOpen, setBehindOpen] = useState(false);

  const refresh = useCallback(
    async (t: string | null): Promise<void> => {
      try {
        const r = await fetchCompare(projectId, t ?? undefined);
        setError(null);
        if (!t) setTarget(r.target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId],
  );

  // Keyed by projectId in the host — state resets by construction.
  useEffect(() => {
    void refresh(target);
    void fetchLog(projectId).catch(() => undefined);
    if (project) void fetchBranches(project.workspaceId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount + target only
  }, [projectId, target]);

  // Counts stay live: a commit moves HEAD; edits come as file events.
  useEffect(() => {
    void refresh(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSha]);
  useEffect(() => {
    let timer: number | undefined;
    const off = onFileEvent((e) => {
      if (e.projectId !== projectId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh(target);
        void fetchLog(projectId).catch(() => undefined);
      }, 800);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [projectId, target, refresh]);

  const pick = (t: string): void => {
    localStorage.setItem(targetKey(projectId), t);
    setOutcome(null);
    setTarget(t);
  };
  const flipMode = (): void => {
    const next = mode === "merge" ? "rebase" : "merge";
    localStorage.setItem(MODE_KEY, next);
    setMode(next);
  };

  const current = project?.branch ?? branchList?.current ?? null;
  const groups = useMemo(() => {
    const locals = (branchList?.locals ?? []).filter((b) => b !== current);
    const remotes = branchList?.remotes ?? [];
    const known = [...locals, ...remotes];
    const extra = target && !known.includes(target) ? [target] : [];
    return [
      { items: [...extra, ...locals].map((b) => ({ value: b, label: b })) },
      { label: "Remote", items: remotes.map((b) => ({ value: b, label: b })) },
    ];
  }, [branchList, current, target]);
  const isLocal = !!target && (branchList?.locals ?? []).includes(target);

  const settle = async (): Promise<void> => {
    notifyGitChanged();
    await Promise.all([refresh(target), fetchLog(projectId).catch(() => undefined)]);
  };

  const act = async (
    setState: (s: ButtonState) => void,
    op: () => Promise<MergeResult>,
    okText: (r: Extract<MergeResult, { ok: true }>) => string,
  ): Promise<void> => {
    setState("loading");
    setOutcome(null);
    try {
      const r = await op();
      if (r.ok) {
        setOutcome({ kind: "ok", text: okText(r) });
        setState("success");
      } else {
        setOutcome({ kind: "conflicts", files: r.conflicts });
        setState("error");
      }
    } catch (err) {
      setOutcome({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      setState("error");
    }
    await settle();
    setTimeout(() => setState("idle"), 1500);
  };

  const update = (): Promise<void> =>
    act(
      setUpdateState,
      () => mergeFrom(projectId, target!, mode),
      (r) =>
        mode === "rebase"
          ? `Rebased onto ${target} · ${r.sha.slice(0, 7)}`
          : `${r.fastForward ? "Fast-forwarded" : "Merged"} · ${r.sha.slice(0, 7)}`,
    );
  const land = (): Promise<void> =>
    act(
      setLandState,
      () => mergeInto(projectId, target!),
      (r) =>
        `${r.fastForward ? "Fast-forwarded" : "Merged into"} ${target} · ${r.sha.slice(0, 7)}${
          r.where ? ` · in ${r.where.replace(/^\/Users\/[^/]+/, "~")}` : ""
        }`,
    );

  const openAgainstBase = (path: string): void => {
    if (!compare || !project) return;
    const abs = `${dirPrefix(project.cwd)}${path}`;
    requestReview(abs, compare.mergeBase);
    onOpenDiff(abs);
  };

  const busy = updateState === "loading" || landState === "loading" || buildRunning;
  const ahead = compare?.ahead ?? 0;
  const behind = compare?.behind ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-4 pb-2 text-[11px]">
        <span className="min-w-0 max-w-[45%] truncate font-medium text-content" title={current ?? undefined}>
          {current ?? "—"}
        </span>
        <GitCompare className="size-3 shrink-0 text-content/40" strokeWidth={1.75} />
        <RailSelect value={target} placeholder="target" groups={groups} ariaLabel="Compare target" onChange={pick} />
        {compare ? (
          <span className="shrink-0 tabular-nums text-content/50">
            ↑{ahead} ↓{behind}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <StatefulButton
          size="sm"
          variant="secondary"
          state={updateState}
          disabled={busy || !target || behind === 0}
          loadingText={mode === "rebase" ? "Rebasing" : "Merging"}
          successText="Done"
          errorText="Stopped"
          onClick={() => void update()}
          className="shrink-0 px-3"
          title={
            target
              ? mode === "rebase"
                ? `Rebase ${current ?? "this branch"} onto ${target}`
                : `Merge ${target} into ${current ?? "this branch"}`
              : undefined
          }
        >
          {mode === "rebase" ? "Rebase" : "Update"}
        </StatefulButton>
        <button
          type="button"
          onClick={flipMode}
          disabled={busy}
          title={mode === "merge" ? "Switch to rebase" : "Switch to merge"}
          aria-label={mode === "merge" ? "Switch to rebase" : "Switch to merge"}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-content/50 transition-colors hover:bg-content/8 hover:text-content disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
        <StatefulButton
          size="sm"
          variant="primary"
          state={landState}
          disabled={busy || !isLocal || ahead === 0}
          loadingText="Merging"
          successText="Merged"
          errorText="Stopped"
          onClick={() => void land()}
          className="min-w-0 flex-1"
          title={
            !target
              ? undefined
              : !isLocal
                ? "Merging into a remote branch needs a local one"
                : `Merge ${current ?? "this branch"} into ${target}`
          }
        >
          {`Merge into ${target ? short(target) : "…"}`}
        </StatefulButton>
      </div>

      {outcome || error ? (
        <div className="shrink-0 px-4 pb-2 text-[11px] leading-snug">
          {outcome?.kind === "ok" ? <p className="text-content/50">{outcome.text}</p> : null}
          {outcome?.kind === "conflicts" ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2">
              <p className="text-danger">
                Conflicts in {outcome.files.length} {outcome.files.length === 1 ? "file" : "files"} · nothing
                changed
              </p>
              <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10.5px] text-danger/80">
                {outcome.files.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {outcome?.kind === "error" ? <p className="break-words text-danger">{outcome.text}</p> : null}
          {!outcome && error ? <p className="break-words text-danger">{error}</p> : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!compare && !error ? (
          <div className="flex h-16 items-center justify-center">
            <Spinner className="size-3.5 text-content/50" />
          </div>
        ) : compare && compare.files.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-content/40">
            {ahead === 0 && behind === 0
              ? `Up to date with ${compare.target}`
              : `No file differs from ${compare.target}`}
          </p>
        ) : (
          compare?.files.map((c) => (
            <motion.button
              key={c.path}
              type="button"
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              disabled={c.status === "deleted"}
              onClick={() => openAgainstBase(c.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-content/5 active:scale-[0.99] disabled:active:scale-100"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-content",
                  c.status === "deleted" && "text-content/50 line-through",
                )}
                title={c.path}
              >
                {c.path.split("/").pop()}
                <span className="ml-1.5 text-[11px] text-content/40">
                  {c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums">
                {c.status === "added" ? (
                  <span className="text-success">new</span>
                ) : (
                  <>
                    <span className="text-success">+{c.adds}</span>{" "}
                    <span className="text-danger">−{c.dels}</span>
                  </>
                )}
              </span>
            </motion.button>
          ))
        )}
      </div>

      {compare && (ahead > 0 || behind > 0) ? (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-content/10 px-4 py-1.5">
          <CommitList
            label={`${ahead} ahead`}
            commits={compare.ours}
            open={aheadOpen}
            onToggle={() => setAheadOpen(!aheadOpen)}
          />
          <CommitList
            label={`${behind} behind`}
            commits={compare.theirs}
            open={behindOpen}
            onToggle={() => setBehindOpen(!behindOpen)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CommitList({
  label,
  commits,
  open,
  onToggle,
}: {
  label: string;
  commits: CommitInfo[];
  open: boolean;
  onToggle: () => void;
}) {
  if (commits.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex h-6 w-full items-center gap-1 text-[11px] text-content/50 transition-colors hover:text-content"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={1.75} />
        <span className="tabular-nums">{label}</span>
      </button>
      {open
        ? commits.map((c) => (
            <div key={c.sha} className="flex items-baseline gap-2 py-1 pl-4">
              <span className="shrink-0 font-mono text-[10.5px] text-content/40">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-content" title={c.subject}>
                {c.subject}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-content/40">{timeAgo(c.authoredAt)}</span>
            </div>
          ))
        : null}
    </div>
  );
}
