import { useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { DevRun, DevTarget } from "@server/shared/contract-devservers";
import type { PortForwardInfo } from "@server/shared/contract-ports";
import { cn } from "../../motion/cn";
import { StatefulButton } from "../../motion/StatefulButton";
import { macBridgeStore } from "../../lib/macBridge";
import { openUrl, portOpen } from "../../lib/devPorts";
import {
  openDevLog,
  restartDevServer,
  startDevServer,
  stopDevServer,
  targetLabel,
  useAgentServers,
  useAllDevRuns,
  useDevHosts,
  useDevTargets,
  type AgentServer,
  type DevHost,
} from "../../lib/devServers";
import { removeThreadResources } from "../../lib/threadResources";
import { useProjects } from "../../lib/tcserver/workspaces";
import { Spinner } from "../../surfaces/threads/bits";
import { RefreshCw, Square } from "../icons";
import { RailSelect } from "./RailSelect";

const targetKey = (projectId: string): string => `dev-target:${projectId}`;
const hostKey = (projectId: string): string => `dev-host:${projectId}`;

/**
 * The rail's Dev tab (docs/box.md "Dev servers on the box"): what the project
 * can serve, on which host, and the short list of what runs now: the Dev
 * Server button's runs and the ports the project's threads opened, on every
 * host with a copy. Run starts another run of the target (several may run at
 * once, each on its own port) and opens its console in the terminal dock; a
 * row opens its console there, its port opens in the browser (the box's
 * through its forward), Stop takes the process down.
 */
export function DevServerPanel({ projectId }: { projectId: string }) {
  const project = useProjects().find((p) => p.id === projectId);
  const hosts = useDevHosts(project);
  const [hostPick, setHostPick] = useState<string | null>(() => localStorage.getItem(hostKey(projectId)));
  const host: DevHost | undefined = hosts.find((h) => h.environmentId === hostPick && h.projectId) ?? hosts[0];
  const envId = host?.environmentId ?? null;
  const copyId = host?.projectId ?? null;
  const targets = useDevTargets(envId, copyId);
  const runs = useAllDevRuns(hosts).filter((r) => r.status === "running");
  const agents = useAgentServers(hosts);
  const [targetPick, setTargetPick] = useState<string | null>(() => localStorage.getItem(targetKey(projectId)));
  const target: DevTarget | undefined = targets?.find((t) => t.id === targetPick) ?? targets?.[0];
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const run = async (): Promise<void> => {
    if (!envId || !copyId || !target) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startDevServer(envId, copyId, target.id);
      openDevLog({ environmentId: envId, runId: started.id }, targetLabel(target));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const items = (targets ?? []).map((t) => {
    const live = runs.filter((r) => r.environmentId === envId && r.targetId === t.id).length;
    return { value: t.id, label: `${targetLabel(t)}${live ? ` · ${live} running` : ""}`, title: t.dir || undefined };
  });
  const empty = runs.length === 0 && agents.length === 0;

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
        <StatefulButton
          size="sm"
          variant="primary"
          state={starting ? "loading" : "idle"}
          disabled={!target || !copyId || starting}
          onClick={() => void run()}
          className="shrink-0"
        >
          Run
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
      </div>
      {error ? <p className="shrink-0 break-words px-3 pb-2 text-[11px] leading-snug text-danger">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-content/10 py-1">
        {empty ? <p className="px-3 py-1.5 text-[12px] text-content/50">Nothing running</p> : null}
        {runs.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
        {agents.map((a) => (
          <AgentRow key={a.row.id} server={a} />
        ))}
      </div>
    </div>
  );
}

/** One running server: its name opens the console in the dock, its ports open in the browser, Stop ends it. */
function ServerRow({
  name,
  title,
  onOpen,
  ports,
  onRestart,
  onStop,
}: {
  name: string;
  title?: string;
  onOpen: () => void;
  ports: ReactNode;
  onRestart?: () => Promise<unknown>;
  onStop: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"stop" | "restart" | null>(null);
  const act = (kind: "stop" | "restart", fn: () => Promise<unknown>) => {
    setBusy(kind);
    void fn()
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };
  return (
    <div className="group flex h-7 items-center gap-1.5 px-2 text-[12px]">
      <button
        type="button"
        title={title}
        onClick={onOpen}
        className="pressable flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-content/80 hover:bg-content/5 hover:text-content"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
        <span className="truncate">{name}</span>
      </button>
      {ports}
      {onRestart ? (
        <button
          type="button"
          aria-label="Restart"
          title="Restart"
          disabled={busy !== null}
          onClick={() => act("restart", onRestart)}
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3.5", busy === "restart" && "motion-safe:animate-spin")} strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Stop"
        title="Stop"
        disabled={busy !== null}
        onClick={() => act("stop", onStop)}
        className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
      >
        {busy === "stop" ? <Spinner className="size-3" /> : <Square className="size-3" strokeWidth={2} />}
      </button>
    </div>
  );
}

function RunRow({ run }: { run: DevRun & { environmentId: string } }) {
  const name = `${run.name} · ${run.script}`;
  return (
    <ServerRow
      name={name}
      title={run.command}
      onOpen={() => openDevLog({ environmentId: run.environmentId, runId: run.id }, name)}
      ports={run.ports.map((p) => (
        <PortLink key={p.port} port={p.port} environmentId={run.environmentId} forwards={p.forwards} />
      ))}
      onRestart={() =>
        restartDevServer(run.environmentId, run.id).then((next) => openDevLog({ environmentId: run.environmentId, runId: next.id }, name))
      }
      onStop={() => stopDevServer(run.environmentId, run.id)}
    />
  );
}

function AgentRow({ server }: { server: AgentServer }) {
  const { row, environmentId, title } = server;
  return (
    <ServerRow
      name={title}
      title={row.label}
      onOpen={() => openDevLog({ environmentId, resourceId: row.id }, `${title} :${row.identifier}`)}
      ports={<PortLink port={Number(row.identifier)} environmentId={row.environmentId} forwards={row.forwards} />}
      onStop={() => removeThreadResources(row.sessionId, [row.id])}
    />
  );
}

/** The port as it opens here: ":5174" (the Mac's number for a box server), muted when it cannot. */
function PortLink({ port, environmentId, forwards }: { port: number; environmentId: string; forwards: PortForwardInfo[] | undefined }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  const open = portOpen(port, environmentId, forwards, localId);
  if (!open)
    return (
      <span className="shrink-0 tabular-nums text-[11px] text-content/40" title="Not forwarded here">
        :{port}
      </span>
    );
  return (
    <button
      type="button"
      data-dev-port={open.port}
      title={open.movedFrom ? `${open.url} · ${open.movedFrom} is taken here` : open.url}
      onClick={() => openUrl(open.url)}
      className="pressable shrink-0 rounded-[5px] px-1 text-[11px] tabular-nums text-content/60 hover:bg-content/8 hover:text-content"
    >
      :{open.port}
    </button>
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

