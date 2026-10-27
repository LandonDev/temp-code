import { useEffect, useState, type ReactNode } from "react";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { Button } from "../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { StatusMark, linkMarkOf } from "../../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { DeployDriftMark } from "../../../chrome/DeployDrift";
import { HostGlyph } from "../../../chrome/HostGlyph";
import { MoreHorizontal } from "../../../chrome/icons";
import { registry, useEnvironmentStatus, useLastSeenAt, type EnvironmentStatus } from "../../../lib/connection";
import { capsText, originText } from "../../../lib/hostConnection";
import { ago } from "../../harnessLine";
import { Facts } from "./Facts";
import { Group } from "./Group";

export type HostMenuAction = "rename" | "routes" | "remove" | "repair";

/** The link's state as a mark ("Connected", "Reconnecting", "Sign in needed"), and the retry countdown when there is one. */
export function connectionMark(status: EnvironmentStatus, now: number): { state: ReturnType<typeof linkMarkOf>["state"]; word: string; detail: string | null } {
  const mark = linkMarkOf(status.transport);
  const wait = status.transport === "reconnecting" && status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0;
  return { ...mark, detail: wait > 0 ? `next try in ${wait} s` : null };
}

/** A 1 s clock while the host counts down to a retry. */
function useRetryClock(status: EnvironmentStatus): number {
  const counting = status.nextRetryAt !== null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!counting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting, status]);
  return now;
}

function Title({ id, name }: { id: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <HostGlyph environmentId={id} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * One host on Settings → Hosts as a page section: the host's name as the
 * heading, its rows under it. This machine's heading carries the drift
 * mark and a menu with Copy environment id; a paired host's carries its
 * link state, the drift mark, Retry or Pair again when the link needs it,
 * and its menu (Rename, Routes, Remove), with how it is reached under the
 * heading.
 */
export function HostSection({
  id,
  name,
  saved,
  environmentId,
  children,
  onMenu,
}: {
  id: string;
  name: string;
  /** The saved row of a paired host. */
  saved?: SavedEnvironment | null;
  /** This machine's environment id, for its menu's Copy environment id. */
  environmentId?: string;
  children?: ReactNode;
  onMenu?: (action: HostMenuAction) => void;
}) {
  if (saved) return <PairedSection id={id} name={name} saved={saved} onMenu={onMenu}>{children}</PairedSection>;
  return (
    <Group
      data-host-section={id}
      data-environment-row={id}
      title={<Title id={id} name={name} />}
      action={
        <div className="flex items-center gap-2">
          <DeployDriftMark environmentId={id} />
          {environmentId ? <LocalMenu name={name} environmentId={environmentId} /> : null}
        </div>
      }
    >
      {children}
    </Group>
  );
}

function PairedSection({
  id,
  name,
  saved,
  onMenu,
  children,
}: {
  id: string;
  name: string;
  saved: SavedEnvironment;
  onMenu?: (action: HostMenuAction) => void;
  children?: ReactNode;
}) {
  const status = useEnvironmentStatus(id);
  const now = useRetryClock(status);
  const lastSeen = useLastSeenAt(id);
  const env = registry.environment(id);
  const live = registry.link(id)?.transport?.url ?? env?.routes[status.route ?? 0]?.url ?? saved.routes[0]?.url;
  const caps = status.lastHello?.caps ?? saved.caps ?? [];
  const facts = [...(live ? [originText(live)] : []), capsText(caps)];
  if (status.transport !== "open" && lastSeen) facts.push(`seen ${ago(lastSeen, now)}`);
  const mark = connectionMark(status, now);
  const markNode = <StatusMark data-connection={status.transport} state={mark.state} word={mark.word} detail={mark.detail ?? undefined} />;
  return (
    <Group
      data-host-section={id}
      data-environment-row={id}
      title={<Title id={id} name={name} />}
      description={<Facts parts={facts} />}
      action={
        <div className="flex items-center gap-2">
          {status.lastError && status.transport !== "open" ? (
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default" />}>{markNode}</TooltipTrigger>
              <TooltipContent className="max-w-sm">{status.lastError}</TooltipContent>
            </Tooltip>
          ) : (
            markNode
          )}
          <DeployDriftMark environmentId={id} />
          {status.transport === "unauthorized" && onMenu ? (
            <Button variant="ghost" size="sm" onClick={() => onMenu("repair")}>
              Pair again
            </Button>
          ) : null}
          {status.transport === "reconnecting" || status.transport === "offline" ? (
            <Button variant="ghost" size="sm" onClick={() => registry.retry(id)}>
              Retry
            </Button>
          ) : null}
          {onMenu ? <HostMenu name={name} onMenu={onMenu} /> : null}
        </div>
      }
    >
      {children}
    </Group>
  );
}

function MenuTrigger({ name }: { name: string }) {
  return (
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${name} actions`} className="text-muted-foreground" />}>
      <MoreHorizontal strokeWidth={1.75} />
    </DropdownMenuTrigger>
  );
}

function HostMenu({ name, onMenu }: { name: string; onMenu: (action: HostMenuAction) => void }) {
  return (
    <DropdownMenu>
      <MenuTrigger name={name} />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onMenu("rename")}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMenu("routes")}>Routes…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onMenu("remove")}>
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LocalMenu({ name, environmentId }: { name: string; environmentId: string }) {
  return (
    <DropdownMenu>
      <MenuTrigger name={name} />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(environmentId)}>Copy environment id</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
