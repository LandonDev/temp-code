import { useState } from "react";
import type { DevTarget } from "@server/shared/contract-devservers";
import { cn } from "../../motion/cn";
import { StatefulButton } from "../../motion/StatefulButton";
import { devPane } from "../../lib/devPane";
import { startDevServer, targetLabel, useDevHosts, useDevTargets, type DevHost } from "../../lib/devServers";
import { useProjects } from "../../lib/tcserver/workspaces";
import { Spinner } from "../../surfaces/threads/bits";
import { RailSelect } from "./RailSelect";

const targetKey = (projectId: string): string => `dev-target:${projectId}`;
const hostKey = (projectId: string): string => `dev-host:${projectId}`;

/**
 * The rail's Dev tab (docs/box.md "Dev servers on the box"): what the project
 * can serve and on which host. Run starts another run of the target (several
 * may run at once, each on its own port) and shows it in the Dev servers pane,
 * which lists what runs and stops it.
 */
export function DevServerPanel({ projectId }: { projectId: string }) {
  const project = useProjects().find((p) => p.id === projectId);
  const hosts = useDevHosts(project);
  const [hostPick, setHostPick] = useState<string | null>(() => localStorage.getItem(hostKey(projectId)));
  const host: DevHost | undefined = hosts.find((h) => h.environmentId === hostPick && h.projectId) ?? hosts[0];
  const envId = host?.environmentId ?? null;
  const copyId = host?.projectId ?? null;
  const targets = useDevTargets(envId, copyId);
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
      devPane.open(`${envId}/${started.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const items = (targets ?? []).map((t) => ({ value: t.id, label: targetLabel(t), title: t.dir || undefined }));

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

