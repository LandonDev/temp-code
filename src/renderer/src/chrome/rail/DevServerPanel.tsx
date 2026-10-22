import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { devRunWord, type DevRun, type DevTarget } from "@server/shared/contract-devservers";
import { cn } from "../../motion/cn";
import { StatefulButton } from "../../motion/StatefulButton";
import { duration } from "../../lib/format";
import { useClock } from "../../lib/turnClock";
import { macBridgeStore } from "../../lib/macBridge";
import { openUrl, portOpen } from "../../lib/devPorts";
import {
  loadDevLog,
  restartDevServer,
  startDevServer,
  stopDevServer,
  targetLabel,
  useDevHosts,
  useDevLog,
  useDevRuns,
  useDevTargets,
  type DevHost,
} from "../../lib/devServers";
import { useProjects } from "../../lib/tcserver/workspaces";
import { Spinner } from "../../surfaces/threads/bits";
import { RefreshCw } from "../icons";
import { RailSelect } from "./RailSelect";

const targetKey = (projectId: string): string => `dev-target:${projectId}`;
const hostKey = (projectId: string): string => `dev-host:${projectId}`;

/**
 * The rail's Dev tab (docs/box.md "Dev servers on the box"): what the project
 * can serve, on which host, and the run's console. The target menu reads as a
 * label until there is more than one; the host choice shows only when the
 * project has a copy on another linked host. Run starts the target on that
 * host, the log streams underneath, the server's ports open from here (the
 * box's through their forward), and Stop takes the whole process tree.
 */
export function DevServerPanel({ projectId }: { projectId: string }) {
  const project = useProjects().find((p) => p.id === projectId);
  const hosts = useDevHosts(project);
  const [hostPick, setHostPick] = useState<string | null>(() => localStorage.getItem(hostKey(projectId)));
  const host: DevHost | undefined = hosts.find((h) => h.environmentId === hostPick && h.projectId) ?? hosts[0];
  const envId = host?.environmentId ?? null;
  const copyId = host?.projectId ?? null;
  const targets = useDevTargets(envId, copyId);
  const runs = useDevRuns(envId, copyId);
  const [targetPick, setTargetPick] = useState<string | null>(() => localStorage.getItem(targetKey(projectId)));
  const target: DevTarget | undefined = targets?.find((t) => t.id === targetPick) ?? targets?.[0];
  const run: DevRun | undefined = target ? runs.find((r) => r.targetId === target.id) : undefined;
  const running = run?.status === "running";
  const lines = useDevLog(run?.id ?? null);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useClock(running);

  // A run this window did not watch start: fetch its buffered log once.
  const runId = run?.id;
  useEffect(() => {
    if (envId && runId) void loadDevLog(envId, runId).catch(() => undefined);
  }, [envId, runId]);

  const pickHost = (id: string): void => {
    localStorage.setItem(hostKey(projectId), id);
    setHostPick(id);
    setError(null);
  };
  const pickTarget = (id: string): void => {
    localStorage.setItem(targetKey(projectId), id);
    setTargetPick(id);
    setError(null);
  };

  const act = async (kind: "start" | "stop" | "restart"): Promise<void> => {
    if (!envId || !copyId || !target) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "start") await startDevServer(envId, copyId, target.id);
      else if (run) await (kind === "stop" ? stopDevServer(envId, run.id) : restartDevServer(envId, run.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const items = (targets ?? []).map((t) => {
    const live = runs.some((r) => r.targetId === t.id && r.status === "running");
    return { value: t.id, label: `${targetLabel(t)}${live ? " · running" : ""}`, title: t.dir || undefined };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-content/10 px-2 pr-1.5">
        <RailSelect
          value={target ? targetLabel(target) : null}
          placeholder={targets === undefined ? "…" : "Nothing to serve"}
          groups={[{ items }]}
          disabled={items.length < 2}
          ariaLabel="Dev server target"
          title={target?.dir || undefined}
          onChange={pickTarget}
        />
        {running && run ? (
          <span className="shrink-0 text-[11px] tabular-nums text-content/50">{duration(now - run.startedAt)}</span>
        ) : null}
        {running ? (
          <button
            type="button"
            aria-label="Restart"
            title="Restart"
            disabled={busy !== null}
            onClick={() => void act("restart")}
            className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
          >
            <RefreshCw className={cn("size-3.5", busy === "restart" && "motion-safe:animate-spin")} strokeWidth={1.75} />
          </button>
        ) : null}
        <StatefulButton
          size="sm"
          variant={running ? "secondary" : "primary"}
          state={busy === "start" || busy === "stop" ? "loading" : "idle"}
          disabled={!target || !copyId || busy !== null}
          onClick={() => void act(running ? "stop" : "start")}
          className="shrink-0"
        >
          {running ? "Stop" : "Run"}
        </StatefulButton>
      </div>
      {hosts.length > 1 ? <HostChoice hosts={hosts} value={envId} onChange={pickHost} /> : null}
      <div className="shrink-0 px-3 py-2 text-[11px] leading-4">
        {targets === undefined ? (
          <span className="flex h-4 items-center">
            <Spinner className="size-3 text-content/40" />
          </span>
        ) : targets === null ? (
          <span className="text-content/50">This host does not run dev servers yet</span>
        ) : target ? (
          <div className="truncate font-mono text-content/50" title={target.command}>
            {target.command.split("\n").find((l) => l.startsWith("xcodebuild")) ? `xcodebuild · ${target.script}` : target.command}
          </div>
        ) : (
          <span className="text-content/50">No dev script, Expo app or Xcode project here</span>
        )}
        {running && run && envId ? <RunPorts run={run} environmentId={envId} /> : null}
      </div>
      {error ? <p className="shrink-0 break-words px-3 pb-2 text-[11px] leading-snug text-danger">{error}</p> : null}
      <Console lines={lines} runId={run?.id ?? null} />
      {run && run.status !== "running" ? <RunEnd run={run} /> : null}
    </div>
  );
}

/** Mac or box: the hosts with a copy of the project; one with no project for it shows held. */
function HostChoice({ hosts, value, onChange }: { hosts: DevHost[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Run on" className="flex shrink-0 gap-0.5 px-2 pt-2 text-[11px]">
      {hosts.map((h) => (
        <button
          key={h.environmentId}
          type="button"
          role="radio"
          aria-checked={value === h.environmentId}
          disabled={!h.projectId}
          title={h.projectId ? undefined : `${h.name} has the folder but no project for it`}
          onClick={() => onChange(h.environmentId)}
          className={cn(
            "pressable h-6 rounded-md px-2 disabled:cursor-default disabled:opacity-40",
            value === h.environmentId ? "bg-content/10 text-content" : "text-content/50 hover:bg-content/5 hover:text-content",
          )}
        >
          {h.name}
        </button>
      ))}
    </div>
  );
}

/** Where the run's servers open from here: "Open on the Mac :5174" per port. */
function RunPorts({ run, environmentId }: { run: DevRun; environmentId: string }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  if (!run.ports.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-2">
      {run.ports.map((p) => {
        const open = portOpen(p.port, environmentId, p.forwards, localId);
        if (!open) return (
          <span key={p.port} className="tabular-nums text-content/40">
            :{p.port} not forwarded here
          </span>
        );
        return (
          <button
            key={p.port}
            type="button"
            data-dev-port={open.port}
            title={open.movedFrom ? `${open.url} · ${open.movedFrom} is taken here` : open.url}
            onClick={() => openUrl(open.url)}
            className="pressable -mx-1 rounded-[5px] px-1 text-content/70 hover:bg-content/8 hover:text-content"
          >
            {open.label}
            <span className="ml-1 tabular-nums text-content/40">:{open.port}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The run's output, following while the reader sits at the bottom (the Build log's rule). */
function Console({ lines, runId }: { lines: string[]; runId: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length, runId]);
  return (
    <div
      ref={ref}
      data-dev-console={runId ?? ""}
      onScroll={() => {
        const el = ref.current;
        if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
      }}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto border-t border-content/10 font-mono text-[11px] leading-relaxed text-content/50",
        (lines.length > 0 || runId) && "px-3 py-2",
      )}
    >
      {lines.length === 0 && !runId ? (
        <p className="px-3 py-2 font-sans text-[12px] text-content/50">Not running</p>
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

function RunEnd({ run }: { run: DevRun }) {
  const took = duration((run.endedAt ?? Date.now()) - run.startedAt);
  return (
    <p
      className={cn(
        "shrink-0 border-t border-content/10 px-3 py-2 text-[11px] tabular-nums",
        run.status === "failed" ? "text-danger" : "text-content/50",
      )}
    >
      {devRunWord(run)} · {took}
    </p>
  );
}
