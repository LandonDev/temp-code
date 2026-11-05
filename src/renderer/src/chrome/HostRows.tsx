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
import { loadLastSeen, markSessionsSeen, seenFloor } from "../lib/sessionSeen";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { hostScope, requestThreadBatch } from "../lib/threadBatch";
import { batchActionOfMenuId, batchCounts, batchMenuRows } from "../lib/threadBatchMenu";
import { selectionFor } from "../lib/threadBatchSelection";
import { useCurrentEnvironmentId } from "../stores/environment";
import { shell } from "../stores/shell";
import { DropdownMenu, DropdownMenuContent } from "../components/ui/lazy-menus";
import { Spinner } from "../components/ui/spinner";
import { DeployDriftMark } from "./DeployDrift";
import { HostGlyph } from "./HostGlyph";
import { loadToast } from "./toastSync";
import { FolderPlus, LogIn, Server, Settings } from "./icons";
import { tidy, useMenuBody, type MenuRow } from "./menuRows";
import { RailRow } from "./RailRow";

/** A host's connection dot: quiet while open, amber while it tries or is slow, red refused. */
export function toneOf(status: EnvironmentStatus, slow = false): string {
  // A host that is well needs no colour: the dot is quiet, and only trouble tints it.
  if (status.transport === "open") return slow ? "bg-warning" : status.fresh ? "bg-muted-foreground" : "bg-muted-foreground/50";
  switch (status.transport) {
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "unauthorized":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/30";
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
          <span className="flex items-center">
            {/* Each host keeps one 10px box (the 6px dots 4px apart), so a dot
                turning into the spinner moves no other dot. */}
            {environments.map((environment) => {
              const status = statuses.get(environment.id);
              const trying = !!status && (status.transport === "connecting" || status.transport === "reconnecting");
              return (
                <span key={environment.id} data-host-dot className="grid size-2.5 place-items-center">
                  {trying ? (
                    <Spinner aria-hidden data-host-status={status.transport} className="size-2.5 text-warning" />
                  ) : (
                    <span
                      data-host-status={status?.transport ?? "none"}
                      className={`size-1.5 rounded-full ${status ? toneOf(status, slow.has(environment.id)) : "bg-muted-foreground/30"}`}
                    />
                  )}
                </span>
              );
            })}
          </span>
        }
      />
      <DropdownMenuContent side="right" align="end" aria-label="Hosts">
        <HostsMenuRows
          environments={environments}
          words={new Map(environments.map((e) => [e.id, statuses.get(e.id) ? statusText(statuses.get(e.id)!, now, slow.has(e.id)) : "not connected"]))}
          onAddWorkspace={onAddWorkspace}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Hosts menu as `MenuRow` data (DESIGN.md "Panels, modals, menus"):
 *  a submenu per host, its glyph, name, state and deploy drift, with Switch
 *  to, Add workspace here and the fleet switches (counted when the menu
 *  opens), then Host settings. Drawn by the menu body, which an open menu
 *  has always loaded. */
function HostsMenuRows({
  environments,
  words,
  onAddWorkspace,
}: {
  environments: readonly Environment[];
  words: ReadonlyMap<string, string>;
  onAddWorkspace: (environmentId: string) => void;
}) {
  const Body = useMenuBody();
  const currentId = useCurrentEnvironmentId();
  if (!Body) return null;
  const metas = sessionStore.metas();
  const sel = { catalog: workspaceStore.getSnapshot(), lastSeen: loadLastSeen(), floor: seenFloor() };
  const rows: MenuRow[] = [
    ...environments.map((environment): MenuRow => {
      const { id, name } = environment;
      const unread = threadsToMarkReadOnHost(metas, id);
      return {
        kind: "sub",
        id: `host:${id}`,
        label: name,
        // The row names the host: the glyph is bare (no tooltip, no name of
        // its own), centred in the menu's 14px glyph column.
        icon: () => (
          <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
            <HostGlyph environmentId={id} bare />
          </span>
        ),
        contentLabel: `${name} actions`,
        trailing: (
          <>
            {words.get(id)}
            <DeployDriftMark environmentId={id} />
          </>
        ),
        items: tidy([
          ...(id !== currentId ? [{ kind: "item", id: `switch:${id}`, label: `Switch to ${name}`, icon: LogIn } as const] : []),
          { kind: "item", id: `add:${id}`, label: "Add workspace here…", icon: FolderPlus },
          { kind: "sep" },
          ...batchMenuRows(batchCounts(metas, { ...sel, scope: hostScope(id) }), unread.ids.length).map((row) =>
            row.kind === "item" ? { ...row, id: `${row.id}:${id}` } : row,
          ),
        ]),
      };
    }),
    { kind: "sep" },
    { kind: "item", id: "settings", label: "Host settings", icon: Settings },
  ];
  const onPick = (pick: string) => {
    if (pick === "settings") return shell.openSettings("remote");
    const at = pick.lastIndexOf(":");
    const verb = pick.slice(0, at);
    const id = pick.slice(at + 1);
    if (verb === "switch") requestEnvironmentSwitch(id);
    else if (verb === "add") onAddWorkspace(id);
    else if (verb === "read") {
      const unread = threadsToMarkReadOnHost(sessionStore.metas(), id);
      markSessionsSeen(unread.ids, unread.at);
    } else if (batchActionOfMenuId(verb)) {
      const scope = hostScope(id);
      void requestThreadBatch(batchActionOfMenuId(verb)!, scope, () => selectionFor(scope));
    }
  };
  return <Body.MenuRows items={rows} onPick={onPick} kind="dropdown" />;
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
