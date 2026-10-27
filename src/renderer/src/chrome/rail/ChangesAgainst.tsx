import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { CommitInfo, CompareResult, MergeResult } from "@server/shared/domain";
import { Alert, AlertDescription, AlertTitle } from "@renderer/components/ui/alert";
import { Button } from "@renderer/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@renderer/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu";
import { Item, ItemActions, ItemContent, ItemMedia } from "@renderer/components/ui/item";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { timeAgo } from "../../lib/format";
import { notifyGitChanged } from "../../lib/fs";
import { onFileEvent } from "../../lib/projectWatch";
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
import { dirPrefix } from "../../lib/tcserver/projects";
import { useProjects } from "../../lib/tcserver/workspaces";
import { FileTypeIcon } from "../FileTypeIcon";
import { ChevronRight, MoreHorizontal } from "../icons";
import { Counts, FileName } from "./changeRows";

/**
 * The Changes section's lower group: this checkout against a target
 * branch (what the Branch section was). The target picker, ahead and
 * behind, the files this branch changed since the merge base (click → the
 * diff against that base), the commits on each side behind one fold, and
 * the moves in a ⋯ menu: bring the target in (merge or rebase) or land the
 * branch on it. Conflicts never leave a half-merged tree; the group lists
 * the files instead. A move that lands says so in a toast.
 */

const targetKey = (projectId: string): string => `compare-target:${projectId}`;

export type AgainstMove = "update" | "rebase" | "land";

export function ChangesAgainst({
  projectId,
  selectedPath,
  onOpenDiff,
}: {
  projectId: string;
  /** the review file the focused tab shows, relative to the git root */
  selectedPath?: string;
  /** opens the file as a review tab; the base ref is parked beforehand */
  onOpenDiff: (path: string) => void;
}) {
  const project = useProjects().find((p) => p.id === projectId);
  const compare = useCompare(projectId);
  const branchList = useBranchList(project?.workspaceId ?? null);
  const headSha = useGitLog(projectId)?.[0]?.sha;
  const buildRunning = useBuild(projectId)?.run?.status === "running";
  const [target, setTarget] = useState<string | null>(() => localStorage.getItem(targetKey(projectId)));
  const [error, setError] = useState<string | null>(null);
  // A move's refusal ("commit or stash first") outlives the refresh after it.
  const [moveError, setMoveError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [moving, setMoving] = useState<AgainstMove | null>(null);

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

  const current = project?.branch ?? branchList?.current ?? null;
  const locals = useMemo(() => (branchList?.locals ?? []).filter((b) => b !== current), [branchList, current]);
  const remotes = branchList?.remotes ?? [];

  const pick = (t: string): void => {
    localStorage.setItem(targetKey(projectId), t);
    setConflicts(null);
    setMoveError(null);
    setTarget(t);
  };

  const move = async (kind: AgainstMove): Promise<void> => {
    if (!target || moving) return;
    setMoving(kind);
    setConflicts(null);
    setMoveError(null);
    try {
      const r: MergeResult = kind === "land" ? await mergeInto(projectId, target) : await mergeFrom(projectId, target, kind === "rebase" ? "rebase" : "merge");
      if (r.ok) {
        const sha = r.sha.slice(0, 7);
        const words =
          kind === "rebase" ? `Rebased onto ${target}` : kind === "land" ? `${r.fastForward ? "Fast-forwarded" : "Merged into"} ${target}` : `${r.fastForward ? "Fast-forwarded to" : "Merged"} ${target}`;
        toast.success(`${words}  ${sha}`, r.where ? { description: `In ${r.where.replace(/^\/(Users|home)\/[^/]+/, "~")}` } : undefined);
      } else {
        setConflicts(r.conflicts);
      }
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
    }
    notifyGitChanged();
    await Promise.all([refresh(target), fetchLog(projectId).catch(() => undefined)]);
    setMoving(null);
  };

  const openAgainstBase = (path: string): void => {
    if (!compare || !project) return;
    const abs = `${dirPrefix(project.cwd)}${path}`;
    requestReview(abs, compare.mergeBase);
    onOpenDiff(abs);
  };

  return (
    <AgainstView
      current={current}
      target={target}
      locals={locals}
      remotes={remotes}
      compare={compare ?? null}
      selectedPath={selectedPath}
      moving={moving}
      blocked={buildRunning}
      conflicts={conflicts}
      error={moveError ?? error}
      onPick={pick}
      onMove={(kind) => void move(kind)}
      onOpen={openAgainstBase}
    />
  );
}

/** The Against group given its data (ChangesAgainst; tests; ui:preview fixtures). */
export function AgainstView({
  current,
  target,
  locals,
  remotes,
  compare,
  selectedPath,
  moving,
  blocked,
  conflicts,
  error,
  onPick,
  onMove,
  onOpen,
}: {
  current: string | null;
  target: string | null;
  locals: string[];
  remotes: string[];
  compare: CompareResult | null;
  selectedPath?: string;
  moving: AgainstMove | null;
  /** a build is running in the checkout: no move may start */
  blocked: boolean;
  conflicts: string[] | null;
  error: string | null;
  onPick: (target: string) => void;
  onMove: (kind: AgainstMove) => void;
  onOpen: (path: string) => void;
}) {
  const ahead = compare?.ahead ?? 0;
  const behind = compare?.behind ?? 0;
  const known = [...locals, ...remotes];
  const extra = target && !known.includes(target) ? [target] : [];
  const isLocal = !!target && locals.includes(target);
  const busy = !!moving || blocked;
  const branch = current ?? "this branch";

  return (
    <section aria-label="Against" className="flex flex-col">
      <div className="flex h-8 items-center gap-2 pr-1 pl-2">
        <h3 className="shrink-0 text-xs font-medium text-muted-foreground">Against</h3>
        <Select
          value={target}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== target) onPick(next);
          }}
        >
          <SelectTrigger size="sm" aria-label="Compare against" className="min-w-0 flex-1 justify-between">
            <SelectValue placeholder="Choose a branch" />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {[...extra, ...locals].map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
            {remotes.length > 0 ? (
              <SelectGroup>
                <SelectLabel>Remote</SelectLabel>
                {remotes.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
        {compare ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={`${ahead} ahead, ${behind} behind`}>
            ↑{ahead} ↓{behind}
          </span>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  aria-label="Branch moves"
                  disabled={!target}
                  render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" />}
                />
              }
            >
              {moving ? <Spinner className="size-3" /> : <MoreHorizontal className="size-3.5" />}
            </TooltipTrigger>
            <TooltipContent>Merge or rebase</TooltipContent>
          </Tooltip>
          <DropdownMenuContent size="sm" align="end" aria-label="Branch moves">
            <DropdownMenuItem disabled={busy || behind === 0} onClick={() => onMove("update")}>
              Update from {target}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy || behind === 0} onClick={() => onMove("rebase")}>
              Rebase onto {target}
            </DropdownMenuItem>
            {isLocal ? (
              <DropdownMenuItem disabled={busy || ahead === 0} onClick={() => onMove("land")}>
                Merge {branch} into {target}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error ? <p className="px-2 pb-1 text-xs break-words text-destructive">{error}</p> : null}
      {conflicts ? (
        <Alert variant="error" className="my-1">
          <AlertTitle>
            Conflicts in {conflicts.length} {conflicts.length === 1 ? "file" : "files"}, nothing changed
          </AlertTitle>
          <AlertDescription className="max-h-32 overflow-y-auto font-mono text-xs">
            {conflicts.map((f) => (
              <div key={f} className="truncate">
                {f}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {!compare && !error ? (
        <div className="flex flex-col gap-1 px-2 pt-1" aria-busy="true" aria-label="Loading the comparison">
          {["w-1/2", "w-2/5"].map((w) => (
            <div key={w} className="flex h-7 items-center gap-2">
              <Skeleton className="size-4" />
              <Skeleton className={cn("h-3.5", w)} />
            </div>
          ))}
        </div>
      ) : compare && compare.files.length === 0 ? (
        <p className="flex h-7 items-center px-2 text-xs text-muted-foreground">
          {ahead === 0 && behind === 0 ? `Up to date with ${compare.target}` : `No file differs from ${compare.target}`}
        </p>
      ) : compare ? (
        <div className="flex flex-col">
          {compare.files.map((c) => {
            const deleted = c.status === "deleted";
            const active = selectedPath === c.path;
            return (
              <Item
                key={c.path}
                size="xs"
                render={<button type="button" disabled={deleted} onClick={() => onOpen(c.path)} />}
                aria-current={active || undefined}
                aria-label={deleted ? `${c.path}, deleted` : `Open the diff of ${c.path} against ${compare.target}`}
                className={cn("min-h-7 flex-nowrap gap-2 py-0 text-left", !deleted && "hover:bg-foreground/5", active && "bg-muted hover:bg-muted")}
              >
                <ItemMedia className="size-4">
                  <FileTypeIcon name={c.path} isDir={false} size={16} />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <FileName relative={c.path} muted={deleted} />
                </ItemContent>
                <ItemActions>
                  <Counts status={c.status} additions={c.adds} deletions={c.dels} />
                </ItemActions>
              </Item>
            );
          })}
        </div>
      ) : null}

      {compare && (compare.ours.length > 0 || compare.theirs.length > 0) ? (
        <Commits ours={compare.ours} theirs={compare.theirs} ahead={ahead} behind={behind} />
      ) : null}
    </section>
  );
}

function Commits({ ours, theirs, ahead, behind }: { ours: CommitInfo[]; theirs: CommitInfo[]; ahead: number; behind: number }) {
  const [open, setOpen] = useState(false);
  const both = ours.length > 0 && theirs.length > 0;
  const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
  // "3 commits ahead  1 behind": the noun once, on the first fact.
  const words = ahead > 0 ? [`${commits(ahead)} ahead`, behind > 0 ? `${behind} behind` : ""] : [`${commits(behind)} behind`];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={<button type="button" />}
        className="flex h-7 w-full items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-(--dur-fast) motion-reduce:transition-none", open && "rotate-90")} />
        {words.filter(Boolean).map((w, i) => (
          <span key={w} className={cn("tabular-nums", i > 0 && "ml-2")}>
            {w}
          </span>
        ))}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 pt-1">
          {ours.length > 0 ? <CommitRows heading={both ? "Ahead" : null} commits={ours} /> : null}
          {theirs.length > 0 ? <CommitRows heading={both ? "Behind" : null} commits={theirs} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CommitRows({ heading, commits }: { heading: string | null; commits: CommitInfo[] }) {
  return (
    <div className="flex flex-col">
      {heading ? <h4 className="flex h-6 items-center px-2 text-xs font-medium text-muted-foreground">{heading}</h4> : null}
      {commits.map((c) => (
        <div key={c.sha} className="flex h-7 items-center gap-2 px-2">
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{c.sha.slice(0, 7)}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-[13px] text-foreground" />}>{c.subject}</TooltipTrigger>
            <TooltipContent>{c.subject}</TooltipContent>
          </Tooltip>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgo(c.authoredAt)}</span>
        </div>
      ))}
    </div>
  );
}
