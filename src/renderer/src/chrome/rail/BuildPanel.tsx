import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BuildRun, BuildTarget, EffectiveBuild, RemoteStatus } from "@server/shared/build";
import { cn } from "../../motion/cn";
import { StatefulButton } from "../../motion/StatefulButton";
import { FileRefMenu } from "../../surfaces/FileRefMenu";
import { duration } from "../../lib/format";
import { client } from "../../lib/tcserver/client";
import { useProjects } from "../../lib/tcserver/workspaces";
import {
  cancelBuild,
  fetchBuildStatus,
  pullBranch,
  runBuild,
  useBuild,
  useSync,
} from "../../lib/projectRailStore";
import { openBuildSettings } from "./buildSettings";
import { RailSelect } from "./RailSelect";

const targetKey = (projectId: string): string => `build-target:${projectId}`;

/** Re-render every `ms` while `active` — drives the live elapsed label. */
function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/**
 * The Build tab: one button that runs the project's build command in
 * its checkout, the log streaming live underneath, and the files the
 * build produced at the bottom (click → Finder). The command comes from
 * the project override, the workspace setting, or detection.
 */
export function BuildPanel({ projectId }: { projectId: string }) {
  const build = useBuild(projectId);
  const sync = useSync(projectId);
  const project = useProjects().find((p) => p.id === projectId);
  const workspaceId = project?.workspaceId;
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
  const lines = build?.lines ?? [];
  const running = run?.status === "running";
  const now = useNow(running);
  const own = targets[0]?.branch ?? project?.branch ?? null;
  const chosen = target && targets.some((t) => t.branch === target) ? target : own;
  const branchArg = chosen && chosen !== own ? chosen : undefined;

  useEffect(() => {
    void fetchBuildStatus(projectId).catch(() => undefined);
    void client
      .request("build.targets", { projectId })
      .then((t) => setTargets(t as BuildTarget[]))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    setEffective(undefined);
    void client
      .request("build.effective", { projectId, ...(branchArg ? { branch: branchArg } : {}) })
      .then((e) => setEffective(e as EffectiveBuild | null))
      .catch(() => setEffective(null));
  }, [projectId, branchArg]);

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setRemote(undefined);
    setPullError(null);
    void client
      .request("build.remote", { projectId, ...(branchArg ? { branch: branchArg } : {}) })
      .then((r) => live && setRemote(r as RemoteStatus | null))
      .catch(() => live && setRemote(null));
    return () => {
      live = false;
    };
  }, [projectId, chosen, branchArg]);

  const pull = async (): Promise<void> => {
    if (!chosen) return;
    setPulling(true);
    setPullError(null);
    try {
      setRemote(await pullBranch(projectId, branchArg));
    } catch (err) {
      setPullError(err instanceof Error ? err.message : String(err));
      void client
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

  const groups = (["project", "checkout", "branch"] as const).map((kind) => ({
    label: kind === "checkout" ? "Other checkouts" : kind === "branch" ? "Branches" : undefined,
    items: targets
      .filter((t) => t.kind === kind)
      .map((t) => ({ value: t.branch, label: t.branch, title: t.cwd ?? undefined })),
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-1">
        <RailSelect
          value={chosen}
          groups={groups}
          disabled={running || targets.length < 2}
          ariaLabel="Build branch"
          title={
            targets.find((t) => t.branch === chosen)?.cwd ??
            (chosen ? `${chosen} — built in its own worktree` : undefined)
          }
          onChange={pick}
        />
        {running && run ? (
          <span className="shrink-0 text-[11px] tabular-nums text-content/50">{duration(now - run.startedAt)}</span>
        ) : null}
        <StatefulButton
          size="sm"
          variant={running ? "secondary" : "primary"}
          disabled={!effective || pulling}
          onClick={() => void (running ? cancelBuild(projectId).catch(() => undefined) : start())}
          className="shrink-0"
        >
          {running ? "Cancel" : "Build"}
        </StatefulButton>
      </div>
      <RemoteLine
        remote={remote}
        pulling={pulling}
        progress={pulling ? sync : undefined}
        error={pullError}
        disabled={running}
        onPull={() => void pull()}
      />
      <div className="shrink-0 px-4 pb-2 text-[11px] leading-4">
        {effective ? (
          <div className="truncate font-mono text-content/50" title={effective.command}>
            {effective.command}
            {effective.source !== "project" ? <span className="text-content/40"> · {effective.source}</span> : null}
          </div>
        ) : effective === null ? (
          <span className="text-content/50">
            No build command yet ·{" "}
            <button
              type="button"
              onClick={() => workspaceId && openBuildSettings(workspaceId)}
              className="text-content/70 underline-offset-2 transition-colors hover:text-content hover:underline"
            >
              set one
            </button>
          </span>
        ) : (
          <span className="invisible">…</span>
        )}
      </div>
      {error ? <p className="shrink-0 break-words px-4 pb-2 text-[11px] leading-snug text-danger">{error}</p> : null}
      <Log lines={lines} runId={run?.id ?? null} />
      {run && run.status !== "running" ? <StatusLine run={run} own={own} /> : null}
      {run && run.outputs.length > 0 ? <Outputs outputs={run.outputs} /> : null}
    </div>
  );
}

/** The chosen branch against origin, and the way to catch it up. Quiet
 *  when current; a count and a Fetch button when origin is ahead; git's
 *  own progress while fetching. */
function RemoteLine({
  remote,
  pulling,
  progress,
  error,
  disabled,
  onPull,
}: {
  remote: RemoteStatus | null | undefined;
  pulling: boolean;
  progress: { line: string; percent: number | null } | undefined;
  error: string | null;
  disabled: boolean;
  onPull: () => void;
}) {
  if (remote === undefined && !pulling) return <div className="h-6 shrink-0" />;
  const needs = !!remote && (remote.behind > 0 || remote.stale === true);
  const text = pulling
    ? (progress?.line ?? "Fetching…")
    : !remote
      ? null
      : !remote.upstream
        ? "Not on origin"
        : remote.behind > 0
          ? `↓${remote.behind} behind origin${remote.ahead > 0 ? ` · ↑${remote.ahead}` : ""}${remote.stale ? " · more on origin" : ""}`
          : remote.stale
            ? "Origin has new commits"
            : remote.ahead > 0
              ? `↑${remote.ahead} ahead of origin`
              : "Up to date with origin";
  if (text === null) return null;
  return (
    <div className="shrink-0 px-4 pb-2">
      <div className="flex h-6 items-center gap-2 text-[11px]">
        <span
          className={cn(
            "min-w-0 flex-1 truncate tabular-nums",
            pulling ? "font-mono text-[10.5px] text-content/50" : needs ? "text-content" : "text-content/50",
          )}
          title={text}
        >
          {text}
        </span>
        {needs || pulling ? (
          <StatefulButton
            size="sm"
            variant="secondary"
            state={pulling ? "loading" : "idle"}
            disabled={disabled}
            loadingText="Fetching"
            onClick={onPull}
            className="h-6 shrink-0 px-2 text-[11px]"
          >
            Fetch
          </StatefulButton>
        ) : null}
      </div>
      {pulling ? (
        <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-content/10">
          <div
            className={cn(
              "h-full bg-content/50 transition-[width] duration-200",
              progress?.percent == null && "w-1/4 motion-safe:animate-pulse",
            )}
            style={progress?.percent != null ? { width: `${progress.percent}%` } : undefined}
          />
        </div>
      ) : null}
      {error && !pulling ? <p className="mt-1 break-words text-[11px] leading-snug text-danger">{error}</p> : null}
    </div>
  );
}

/** Autoscrolls while the user sits at the bottom; scrolling up parks it,
 *  scrolling back down re-arms it. */
function Log({ lines, runId }: { lines: string[]; runId: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length, runId]);
  return (
    <div
      ref={ref}
      onScroll={() => {
        const el = ref.current;
        if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-content/50"
    >
      {lines.length === 0 && !runId ? (
        <p className="py-6 text-center font-sans text-[11px] text-content/40">No builds yet</p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {line}
          </div>
        ))
      )}
    </div>
  );
}

function StatusLine({ run, own }: { run: BuildRun; own: string | null }) {
  const took = duration((run.endedAt ?? Date.now()) - run.startedAt);
  const where = run.branch && run.branch !== own ? ` · ${run.branch}` : "";
  return (
    <p
      className={cn(
        "shrink-0 border-t border-content/10 px-4 py-2 text-[11px] tabular-nums",
        run.status === "ok" && "text-content/50",
        run.status === "failed" && "text-danger",
        run.status === "cancelled" && "text-content/40",
      )}
    >
      {run.status === "ok"
        ? `Built in ${took}${where}`
        : run.status === "failed"
          ? `Failed${run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ""} · ${took}${where}`
          : `Cancelled${where}`}
    </p>
  );
}

const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

function Outputs({ outputs }: { outputs: BuildRun["outputs"] }) {
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-t border-content/10 px-2 py-1.5">
      {outputs.map((o) => (
        <FileRefMenu key={o.abs} target={o.abs}>
          <button
            type="button"
            onClick={() => void window.api.revealInFinder(o.abs)}
            title={o.abs}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-content/5 active:scale-[0.99]"
          >
            <span className={cn("min-w-0 flex-1 truncate text-xs text-content", !o.fresh && "text-content/50")}>
              {o.path.split("/").pop()}
              <span className="ml-1.5 text-[11px] text-content/40">
                {o.path.includes("/") ? o.path.slice(0, o.path.lastIndexOf("/")) : ""}
              </span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-content/40">
              {o.fresh ? fmtSize(o.size) : "not rebuilt"}
            </span>
          </button>
        </FileRefMenu>
      ))}
    </div>
  );
}
