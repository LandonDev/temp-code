import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BuildRun, BuildTarget, EffectiveBuild, RemoteStatus } from "@server/shared/build";
import { ChoiceSelect, type Choice } from "@renderer/components/choice-select";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { Item, ItemActions, ItemContent } from "@renderer/components/ui/item";
import { Progress } from "@renderer/components/ui/progress";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { StatusMark, type ThreadState } from "@renderer/components/ui/status";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { FileRefMenu } from "../../surfaces/FileRefMenu";
import { duration, useNow } from "../../lib/duration";
import { invoke } from "../../lib/native";
import { registry } from "../../lib/connection";
import { useProjects } from "../../lib/tcserver/workspaces";
import {
  cancelBuild,
  fetchBuildStatus,
  pullBranch,
  runBuild,
  useBuild,
  useSync,
  type SyncProgress,
} from "../../lib/projectRailStore";
import { openBuildSettings } from "./buildSettings";

const targetKey = (projectId: string): string => `build-target:${projectId}`;

/**
 * The right panel's Build section: one button that runs the project's
 * build command in its checkout, one status row for the run, the log
 * streaming live under it, and the files the build produced (click →
 * Finder). The command comes from the project override, the workspace
 * setting, or detection. This is the container: hooks and requests;
 * `BuildView` draws.
 */
export function BuildPanel({ projectId }: { projectId: string }) {
  const build = useBuild(projectId);
  const sync = useSync(projectId);
  const project = useProjects().find((p) => p.id === projectId);
  const workspaceId = project?.workspaceId;
  const environmentId = project?.environmentId;
  const [effective, setEffective] = useState<EffectiveBuild | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Which branch to build: the project's own by default; another checkout
  // or local branch builds there without switching this checkout.
  const [targets, setTargets] = useState<BuildTarget[]>([]);
  // The chosen branch vs origin; undefined while loading, null when it
  // has no local ref (nothing to compare).
  const [remote, setRemote] = useState<RemoteStatus | null | undefined>(undefined);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(() => localStorage.getItem(targetKey(projectId)));

  const run = build?.run ?? null;
  const own = targets[0]?.branch ?? project?.branch ?? null;
  const chosen = target && targets.some((t) => t.branch === target) ? target : own;
  const branchArg = chosen && chosen !== own ? chosen : undefined;

  useEffect(() => {
    if (!environmentId) return;
    void fetchBuildStatus(projectId).catch(() => undefined);
    void registry.linkOf(environmentId)
      .request("build.targets", { projectId })
      .then((t) => setTargets(t as BuildTarget[]))
      .catch(() => undefined);
  }, [environmentId, projectId]);

  useEffect(() => {
    if (!environmentId) return;
    setEffective(undefined);
    void registry.linkOf(environmentId)
      .request("build.effective", { projectId, ...(branchArg ? { branch: branchArg } : {}) })
      .then((e) => setEffective(e as EffectiveBuild | null))
      .catch(() => setEffective(null));
  }, [environmentId, projectId, branchArg]);

  useEffect(() => {
    if (!chosen || !environmentId) return;
    let live = true;
    setRemote(undefined);
    setPullError(null);
    void registry.linkOf(environmentId)
      .request("build.remote", { projectId, ...(branchArg ? { branch: branchArg } : {}) })
      .then((r) => live && setRemote(r as RemoteStatus | null))
      .catch(() => live && setRemote(null));
    return () => {
      live = false;
    };
  }, [environmentId, projectId, chosen, branchArg]);

  const pull = async (): Promise<void> => {
    if (!chosen || !environmentId) return;
    setPulling(true);
    setPullError(null);
    try {
      setRemote(await pullBranch(projectId, branchArg));
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err));
      void registry.linkOf(environmentId)
        .request("build.remote", { projectId, ...(branchArg ? { branch: branchArg } : {}) })
        .then((r) => setRemote(r as RemoteStatus | null))
        .catch(() => undefined);
    } finally {
      setPulling(false);
    }
  };

  const pick = (branch: string): void => {
    localStorage.setItem(targetKey(projectId), branch);
    setTarget(branch);
  };

  const start = async (): Promise<void> => {
    setError(null);
    try {
      await runBuild(projectId, branchArg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <BuildView
      targets={targets}
      chosen={chosen}
      own={own}
      effective={effective}
      run={run}
      lines={build?.lines ?? []}
      remote={remote}
      pulling={pulling}
      progress={pulling ? sync : undefined}
      pullError={pullError}
      error={error}
      onPick={pick}
      onBuild={() => void start()}
      onCancel={() => void cancelBuild(projectId).catch(() => undefined)}
      onFetch={() => void pull()}
      onSetCommand={() => workspaceId && openBuildSettings(workspaceId)}
      onReveal={(path) => void invoke("reveal_path", { path })}
    />
  );
}

const STATE: Record<BuildRun["status"], ThreadState> = {
  running: "working",
  ok: "done",
  failed: "failed",
  cancelled: "stopped",
};

const TARGET_GROUP: Record<BuildTarget["kind"], string | undefined> = {
  project: undefined,
  checkout: "Other checkouts",
  branch: "Branches",
};

/** The Build section drawn from its data: the tests and ui:preview render this without a host. */
export function BuildView({
  targets,
  chosen,
  own,
  effective,
  run,
  lines,
  remote,
  pulling,
  progress,
  pullError,
  error,
  onPick,
  onBuild,
  onCancel,
  onFetch,
  onSetCommand,
  onReveal,
}: {
  targets: BuildTarget[];
  /** the branch the next build runs on */
  chosen: string | null;
  /** the project's own branch */
  own: string | null;
  /** the command; undefined while it loads, null when none is set or detected */
  effective: EffectiveBuild | null | undefined;
  run: BuildRun | null;
  lines: string[];
  remote: RemoteStatus | null | undefined;
  pulling: boolean;
  progress: SyncProgress | undefined;
  pullError: string | null;
  error: string | null;
  onPick: (branch: string) => void;
  onBuild: () => void;
  onCancel: () => void;
  onFetch: () => void;
  onSetCommand: () => void;
  onReveal: (path: string) => void;
}) {
  const running = run?.status === "running";
  const options: Choice<string>[] = targets.map((t) => ({ value: t.branch, label: t.branch, group: TARGET_GROUP[t.kind] }));
  if (chosen && !options.some((o) => o.value === chosen)) options.unshift({ value: chosen, label: chosen });
  const where = targets.find((t) => t.branch === chosen)?.cwd ?? (chosen ? `${chosen} builds in its own worktree` : null);

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col" data-slot="build-section">
        <div className="flex h-9 shrink-0 items-center gap-2 px-3">
          {chosen ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 flex-1" />}>
                <ChoiceSelect
                  label="Build branch"
                  size="sm"
                  value={chosen}
                  options={options}
                  disabled={running || targets.length < 2}
                  onChange={onPick}
                  className="w-full min-w-0"
                />
              </TooltipTrigger>
              {where ? <TooltipContent>{where}</TooltipContent> : null}
            </Tooltip>
          ) : (
            <span className="flex-1" />
          )}
          {running ? (
            <Button size="sm" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" disabled={!effective || pulling} onClick={onBuild}>
              Build
            </Button>
          )}
        </div>
        {error ? <p className="shrink-0 px-3 pb-2 text-xs break-words text-destructive">{error}</p> : null}
        <OriginLine remote={remote} pulling={pulling} progress={progress} error={pullError} disabled={running} onFetch={onFetch} />
        {effective === null ? (
          <Empty className={cn("p-4", run && "flex-none")}>
            <EmptyHeader>
              <EmptyTitle className="text-[13px]">No build command</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="link" size="sm" onClick={onSetCommand}>
                Set one
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="shrink-0 px-1">
            <StatusRow run={run} own={own} effective={effective} />
          </div>
        )}
        {run || lines.length > 0 ? <Log lines={lines} runId={run?.id ?? null} /> : null}
        {run && run.outputs.length > 0 ? <Outputs outputs={run.outputs} onReveal={onReveal} /> : null}
      </div>
    </TooltipProvider>
  );
}

/** The run's state in the status vocabulary with its detail, the command under it. Before a run, the command alone. */
function StatusRow({ run, own, effective }: { run: BuildRun | null; own: string | null; effective: EffectiveBuild | undefined }) {
  const running = run?.status === "running";
  const now = useNow(running);
  const command = effective?.command ?? run?.command;
  const commandLine = command ? (
    <span className="flex min-w-0 items-baseline text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate font-mono" />}>{command}</TooltipTrigger>
        <TooltipContent>{command}</TooltipContent>
      </Tooltip>
      {effective && effective.source !== "project" ? <span className="ml-2 shrink-0">{effective.source}</span> : null}
    </span>
  ) : (
    <Skeleton className="h-3 w-40" />
  );
  if (!run) {
    return (
      <Item size="xs" className="min-h-7 flex-nowrap py-0">
        <ItemContent className="min-w-0">{commandLine}</ItemContent>
      </Item>
    );
  }
  const took = duration((run.endedAt ?? (running && now > 0 ? now : Date.now())) - run.startedAt);
  const facts: ReactNode[] = [];
  if (run.status === "running" || run.status === "ok") facts.push(took);
  if (run.status === "failed") {
    if (run.exitCode !== undefined) facts.push(`exit ${run.exitCode}`);
    facts.push(took);
  }
  if (run.branch && run.branch !== own) facts.push(run.branch);
  return (
    <Item size="xs" className="min-h-7 flex-nowrap py-1" data-build-status={run.status}>
      <ItemContent className="min-w-0">
        <StatusMark
          state={STATE[run.status]}
          className="text-[13px]"
          detail={
            facts.length > 0 ? (
              <>
                {facts.map((fact, i) => (
                  <span key={i} className={i > 0 ? "ml-2" : undefined}>
                    {fact}
                  </span>
                ))}
              </>
            ) : undefined
          }
        />
        <span className="mt-0.5 block">{commandLine}</span>
      </ItemContent>
    </Item>
  );
}

/** The chosen branch against origin, said only when origin has commits
 *  this checkout lacks; git's own progress while fetching. */
function OriginLine({
  remote,
  pulling,
  progress,
  error,
  disabled,
  onFetch,
}: {
  remote: RemoteStatus | null | undefined;
  pulling: boolean;
  progress: SyncProgress | undefined;
  error: string | null;
  disabled: boolean;
  onFetch: () => void;
}) {
  const behind = !!remote && remote.upstream && remote.behind > 0;
  const stale = !!remote && remote.stale === true;
  if (!behind && !stale && !pulling) {
    return error ? <p className="shrink-0 px-3 pb-2 text-xs break-words text-destructive">{error}</p> : null;
  }
  const text = pulling ? (progress?.line ?? "Fetching…") : behind ? `${remote!.behind} behind origin` : "Origin has new commits";
  return (
    <div className="shrink-0 px-3 pb-2" data-slot="build-origin">
      <div className="flex h-7 items-center gap-2">
        <span className={cn("min-w-0 flex-1 truncate text-xs tabular-nums", pulling ? "font-mono text-muted-foreground" : "text-foreground")}>
          {text}
        </span>
        <Button size="xs" variant="secondary" disabled={disabled || pulling} aria-busy={pulling || undefined} onClick={onFetch}>
          {pulling ? <Spinner className="size-3" aria-hidden="true" role="presentation" aria-label={undefined} /> : null}
          Fetch
        </Button>
      </div>
      {pulling && progress?.percent != null ? <Progress value={progress.percent} fill="muted" aria-label="Fetching" className="mt-1" /> : null}
      {error && !pulling ? <p className="mt-1 text-xs break-words text-destructive">{error}</p> : null}
    </div>
  );
}

/** Follows the tail while the reader sits at the bottom; scrolling up parks it, scrolling back down re-arms it. */
function Log({ lines, runId }: { lines: string[]; runId: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const viewport = (): HTMLElement | null => box.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null;

  useEffect(() => {
    const el = viewport();
    if (!el) return;
    const onScroll = (): void => {
      stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = viewport();
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, runId]);

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col" data-slot="build-log">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {lines.map((line, i) => (
            <div key={i} className="break-words whitespace-pre-wrap">
              {line}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

function Outputs({ outputs, onReveal }: { outputs: BuildRun["outputs"]; onReveal: (path: string) => void }) {
  return (
    <div className="flex max-h-44 shrink-0 flex-col pt-2 pb-3" data-slot="build-outputs">
      <h3 className="flex h-6 shrink-0 items-center px-3 text-xs font-medium text-muted-foreground">
        Outputs
      </h3>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col px-1">
          {outputs.map((o) => (
            <OutputRow key={o.abs} output={o} onReveal={onReveal} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function OutputRow({ output, onReveal }: { output: BuildRun["outputs"][number]; onReveal: (path: string) => void }) {
  const slash = output.path.lastIndexOf("/");
  const name = output.path.slice(slash + 1);
  const folder = slash > 0 ? output.path.slice(0, slash) : "";
  const reveal = (): void => onReveal(output.abs);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    reveal();
  };
  return (
    <FileRefMenu target={output.abs}>
      <Item
        size="xs"
        role="button"
        tabIndex={0}
        data-output={output.path}
        onClick={reveal}
        onKeyDown={onKeyDown}
        className="min-h-7 flex-nowrap py-0 hover:bg-foreground/5"
      >
        <ItemContent className="min-w-0">
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 items-baseline" />}>
              <span className={cn("min-w-0 truncate text-[13px]", output.fresh ? "text-foreground" : "text-muted-foreground")}>{name}</span>
              {folder ? <span className="ml-2 min-w-0 shrink-[1000] truncate text-xs text-muted-foreground">{folder}</span> : null}
            </TooltipTrigger>
            <TooltipContent>{output.abs}</TooltipContent>
          </Tooltip>
        </ItemContent>
        <ItemActions>
          <span className="text-xs text-muted-foreground tabular-nums">{output.fresh ? fmtSize(output.size) : "Not rebuilt"}</span>
        </ItemActions>
      </Item>
    </FileRefMenu>
  );
}
