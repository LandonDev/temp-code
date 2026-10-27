import { useEffect, useState } from "react";
import {
  useEnvironments,
  useEnvironmentStatuses,
  useSlowEnvironments,
  type Environment,
  type EnvironmentStatus,
} from "../lib/connection";
import { bootResumeLine, dismissBootResume, useBootResumeNotices } from "../lib/bootResume";
import { requestEnvironmentSwitch } from "../lib/environmentSwitch";
import { statusText } from "../lib/hostConnection";
import { threadsToMarkReadOnHost } from "../lib/markRead";
import { markSessionsSeen, useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import { useSessionMetas } from "../lib/tcserver/store";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { BATCH_ACTIONS, BATCH_LABEL, hostScope, requestThreadBatch } from "../lib/threadBatch";
import { batchCounts } from "../lib/threadBatchMenu";
import { selectionFor } from "../lib/threadBatchSelection";
import { useCurrentEnvironmentId } from "../stores/environment";
import { shell } from "../stores/shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../components/ui/dropdown-menu";
import { Spinner } from "../components/ui/spinner";
import { DeployDriftMark } from "./DeployDrift";
import { HostGlyph } from "./HostGlyph";
import { loadToast } from "./toastSync";
import { Server } from "./icons";
import { RailRow } from "./RailRow";

/** A host's connection dot: green open, amber while it tries, red refused. */
export function toneOf(status: EnvironmentStatus, degraded: boolean, slow = false): string {
  if (status.transport === "open") return slow ? "bg-warning" : status.fresh ? "bg-success" : "bg-success/50";
  if (!degraded) return "bg-success";
  switch (status.transport) {
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "unauthorized":
      return "bg-danger";
    default:
      return "bg-muted-foreground/40";
  }
}

/** "This Mac connected", one host's words for the row's aria-label. */
function hostWord(environment: Environment, status: EnvironmentStatus | undefined, slow: boolean, now: number): string {
  return `${environment.name} ${status ? statusText(status, now, slow) : "not connected"}`;
}

/**
 * The hosts at the rail's foot: one row, drawn only with two or more
 * hosts, ending in one dot per host. Its menu has a submenu per host (the
 * glyph, the name, the state and the `+N` deploy drift), each with Switch
 * to, Add workspace here and the fleet switches, then Host settings.
 */
export function HostsRow({ onAddWorkspace }: { onAddWorkspace: (environmentId: string) => void }) {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const slow = useSlowEnvironments();
  const [open, setOpen] = useState(false);
  if (environments.length < 2) return null;
  const now = Date.now();
  const label = `Hosts: ${environments.map((e) => hostWord(e, statuses.get(e.id), slow.has(e.id), now)).join(", ")}`;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <RailRow
        icon={Server}
        label="Hosts"
        ariaLabel={label}
        menuTrigger
        trailing={
          <span className="flex items-center gap-1">
            {environments.map((environment) => {
              const status = statuses.get(environment.id);
              if (status && (status.transport === "connecting" || status.transport === "reconnecting")) {
                return <Spinner key={environment.id} aria-hidden data-host-status={status.transport} className="size-2.5 text-warning" />;
              }
              return (
                <span
                  key={environment.id}
                  data-host-status={status?.transport ?? "none"}
                  className={`size-1.5 rounded-full ${
                    status ? toneOf(status, status.transport !== "open", slow.has(environment.id)) : "bg-muted-foreground/40"
                  }`}
                />
              );
            })}
          </span>
        }
      />
      <DropdownMenuContent side="right" align="end" aria-label="Hosts">
        {environments.map((environment) => (
          <HostSubmenu
            key={environment.id}
            environment={environment}
            word={statuses.get(environment.id) ? statusText(statuses.get(environment.id)!, now, slow.has(environment.id)) : "not connected"}
            onAddWorkspace={onAddWorkspace}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => shell.openSettings("remote")}>Host settings</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HostSubmenu({
  environment,
  word,
  onAddWorkspace,
}: {
  environment: Environment;
  word: string;
  onAddWorkspace: (environmentId: string) => void;
}) {
  const { id, name } = environment;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-host-menu={id}>
        <HostGlyph environmentId={id} />
        <span className="min-w-0 truncate">{name}</span>
        <span className="ms-auto flex shrink-0 items-center gap-2 ps-4 text-[12px] text-muted-foreground">
          {word}
          <DeployDriftMark environmentId={id} />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent aria-label={`${name} actions`}>
        <HostActions environmentId={id} name={name} onAddWorkspace={onAddWorkspace} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A host's verbs; counted only while its submenu is open. */
function HostActions({
  environmentId,
  name,
  onAddWorkspace,
}: {
  environmentId: string;
  name: string;
  onAddWorkspace: (environmentId: string) => void;
}) {
  const currentId = useCurrentEnvironmentId();
  const metas = useSessionMetas();
  const catalog = useWorkspaceCatalog();
  const lastSeen = useLastSeen();
  const floor = useSeenFloor();
  const scope = hostScope(environmentId);
  const counts = batchCounts(metas, { catalog, lastSeen, floor, scope });
  const unread = threadsToMarkReadOnHost(metas, environmentId);
  return (
    <>
      {environmentId !== currentId ? (
        <DropdownMenuItem onClick={() => requestEnvironmentSwitch(environmentId)}>Switch to {name}</DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={() => onAddWorkspace(environmentId)}>Add workspace here…</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={unread.ids.length === 0} onClick={() => markSessionsSeen(unread.ids, unread.at)}>
        Mark all read
      </DropdownMenuItem>
      {BATCH_ACTIONS.map((action) => (
        <DropdownMenuItem
          key={action}
          disabled={counts[action] === 0}
          variant={action === "stop" ? "destructive" : "default"}
          onClick={() => void requestThreadBatch(action, scope, () => selectionFor(scope))}
        >
          {BATCH_LABEL[action]}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * "7 threads resumed after restart", once per boot of a host, as a toast
 * (with the host's name under it when there are two or more). Mounted once,
 * by the rail.
 */
export function useBootResumeToasts(): void {
  const notices = useBootResumeNotices();
  const environments = useEnvironments();
  useEffect(() => {
    if (notices.length === 0) return;
    const lines = notices.map((notice) => ({
      line: bootResumeLine(notice.count),
      host: environments.length > 1 ? environments.find((e) => e.id === notice.environmentId)?.name : undefined,
    }));
    for (const notice of notices) dismissBootResume(notice.environmentId);
    void loadToast().then((toast) => {
      for (const { line, host } of lines) toast(line, host ? { description: host } : undefined);
    });
  }, [environments, notices]);
}
