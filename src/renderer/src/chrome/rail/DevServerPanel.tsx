import { useState } from "react";
import type { DevTarget } from "@server/shared/contract-devservers";
import { ChoiceSelect } from "../../components/choice-select";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { devPane } from "../../lib/devPane";
import { startDevServer, targetLabel, useDevHosts, useDevTargets, type DevHost } from "../../lib/devServers";
import { useProjects } from "../../lib/tcserver/workspaces";

const targetKey = (projectId: string): string => `dev-target:${projectId}`;
const hostKey = (projectId: string): string => `dev-host:${projectId}`;

export type DevStarterState = {
  hosts: DevHost[];
  /** The host the next run starts on. */
  envId: string | null;
  pickHost: (id: string) => void;
  /** undefined while loading, null when the host cannot say. */
  targets: DevTarget[] | null | undefined;
  target: DevTarget | undefined;
  pickTarget: (id: string) => void;
  starting: boolean;
  error: string | null;
  run: () => Promise<void>;
};

/**
 * What the project can serve and on which host (docs/box.md "Dev servers on
 * the box"). Run starts another run of the target (several may run at once,
 * each on its own port) and picks it in the Dev servers pane.
 */
export function useDevStarter(projectId: string | null): DevStarterState {
  const project = useProjects().find((p) => p.id === projectId);
  const hosts = useDevHosts(project);
  const [hostPick, setHostPick] = useState<string | null>(() => (projectId ? localStorage.getItem(hostKey(projectId)) : null));
  const host = hosts.find((h) => h.environmentId === hostPick && h.projectId) ?? hosts[0];
  const envId = host?.environmentId ?? null;
  const copyId = host?.projectId ?? null;
  const targets = useDevTargets(envId, copyId);
  const [targetPick, setTargetPick] = useState<string | null>(() => (projectId ? localStorage.getItem(targetKey(projectId)) : null));
  const target = targets?.find((t) => t.id === targetPick) ?? targets?.[0];
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return {
    hosts,
    envId,
    targets,
    target,
    starting,
    error,
    pickHost: (id) => {
      if (projectId) localStorage.setItem(hostKey(projectId), id);
      setHostPick(id);
      setError(null);
    },
    pickTarget: (id) => {
      if (projectId) localStorage.setItem(targetKey(projectId), id);
      setTargetPick(id);
      setError(null);
    },
    run: async () => {
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
    },
  };
}

/** The Dev servers pane's starter: the target, Run, and with two or more hosts the host to run on. */
export function DevStarter({ starter }: { starter: DevStarterState }) {
  const { hosts, envId, targets, target, starting, error } = starter;
  const options = (targets ?? []).map((t) => ({ value: t.id, label: targetLabel(t) }));
  return (
    <div data-dev-starter="" className="flex shrink-0 flex-col border-b border-border">
      <div className="flex h-9 items-center gap-2 px-3">
        {targets === undefined ? (
          <Skeleton data-dev-target-skeleton="" className="h-7 min-w-0 flex-1 rounded-md" />
        ) : options.length > 0 ? (
          <ChoiceSelect
            label="Dev server target"
            size="sm"
            value={target?.id ?? options[0].value}
            options={options}
            disabled={options.length < 2}
            onChange={starter.pickTarget}
            className="min-w-0 flex-1"
          />
        ) : (
          <ChoiceSelect label="Dev server target" size="sm" value="" options={NO_TARGETS} disabled onChange={noop} className="min-w-0 flex-1" />
        )}
        <Button size="sm" disabled={!target || !envId || starting} onClick={() => void starter.run()}>
          {starting ? <Spinner className="size-3.5" /> : null}
          Run
        </Button>
      </div>
      {hosts.length > 1 ? <HostChoice hosts={hosts} value={envId} onChange={starter.pickHost} /> : null}
      {error ? <p className="break-words px-3 pb-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** The starter alone for a project, where something other than the pane mounts it. */
export function DevServerPanel({ projectId }: { projectId: string }) {
  return <DevStarter starter={useDevStarter(projectId)} />;
}

const NO_TARGETS = [{ value: "", label: "No targets" }];
const noop = () => {};

/** Mac or box: the hosts with a copy of the project; one with no project for it shows held, saying why. */
function HostChoice({ hosts, value, onChange }: { hosts: DevHost[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className="px-3 pb-2">
      <ToggleGroup
        aria-label="Run on"
        size="sm"
        spacing={0}
        value={value ? [value] : []}
        onValueChange={(next: unknown[]) => {
          const id = next[0];
          if (typeof id === "string") onChange(id);
        }}
      >
        {hosts.map((h) =>
          h.projectId ? (
            <ToggleGroupItem key={h.environmentId} value={h.environmentId}>
              {h.name}
            </ToggleGroupItem>
          ) : (
            <Tooltip key={h.environmentId}>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <ToggleGroupItem value={h.environmentId} disabled>
                  {h.name}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{h.name} has the folder but no project for it</TooltipContent>
            </Tooltip>
          ),
        )}
      </ToggleGroup>
    </div>
  );
}
