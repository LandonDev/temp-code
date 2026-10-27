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
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { DeployDriftMark } from "../../../chrome/DeployDrift";
import { HostGlyph } from "../../../chrome/HostGlyph";
import { MoreHorizontal } from "../../../chrome/icons";
import { registry, useEnvironmentStatus, useLastSeenAt, type EnvironmentStatus } from "../../../lib/connection";
import { capsText, originText, statusText } from "../../../lib/hostConnection";
import { ago } from "../../harnessLine";
import { Facts } from "./Facts";

export type HostMenuAction = "repair" | "rename" | "routes" | "remove";

/** "Connected", "Reconnecting, next try in 5 s", "Key refused": the link's state in one phrase, sentence case. */
export function connectionWord(status: EnvironmentStatus, now: number): string {
  const text = statusText(status, now);
  return text.charAt(0).toUpperCase() + text.slice(1);
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

/**
 * One host on Settings → Hosts: a header (the glyph, the name, the link's
 * state for a paired host, the deploy drift `+N`, the paired host's menu)
 * and that host's groups under it, 16px apart.
 */
export function HostSection({
  id,
  name,
  saved,
  children,
  onMenu,
}: {
  id: string;
  name: string;
  /** The saved row of a paired host: its header says how it is reached and carries its menu. */
  saved?: SavedEnvironment | null;
  children?: ReactNode;
  onMenu?: (action: HostMenuAction) => void;
}) {
  return (
    <section aria-label={name} className="flex min-w-0 flex-col gap-4" data-host-section={id}>
      {saved ? <PairedHeader id={id} name={name} saved={saved} onMenu={onMenu} /> : <Header id={id} name={name} />}
      {children}
    </section>
  );
}

function Title({ id, name, children }: { id: string; name: string; children?: ReactNode }) {
  return (
    <>
      <HostGlyph environmentId={id} />
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{name}</h2>
      {children}
    </>
  );
}

function Header({ id, name }: { id: string; name: string }) {
  return (
    <header className="flex min-h-8 items-center gap-2" data-environment-row={id}>
      <Title id={id} name={name} />
      <span className="flex-1" />
      <DeployDriftMark environmentId={id} />
    </header>
  );
}

function PairedHeader({
  id,
  name,
  saved,
  onMenu,
}: {
  id: string;
  name: string;
  saved: SavedEnvironment;
  onMenu?: (action: HostMenuAction) => void;
}) {
  const status = useEnvironmentStatus(id);
  const now = useRetryClock(status);
  const lastSeen = useLastSeenAt(id);
  const env = registry.environment(id);
  const live = registry.link(id)?.transport?.url ?? env?.routes[status.route ?? 0]?.url ?? saved.routes[0]?.url;
  const caps = status.lastHello?.caps ?? saved.caps ?? [];
  const facts = [...(live ? [originText(live)] : []), capsText(caps)];
  if (status.transport !== "open" && lastSeen) facts.push(`seen ${ago(lastSeen, now)}`);
  const refused = status.transport === "unauthorized";
  const word = connectionWord(status, now);
  return (
    <div className="flex flex-col gap-0.5" data-environment-row={id}>
      <header className="flex min-h-8 items-center gap-2">
        <Title id={id} name={name}>
          <span data-connection={status.transport} className={refused ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {status.lastError && status.transport !== "open" ? (
              <Tooltip>
                <TooltipTrigger render={<span className="cursor-default" />}>{word}</TooltipTrigger>
                <TooltipContent className="max-w-sm">{status.lastError}</TooltipContent>
              </Tooltip>
            ) : (
              word
            )}
          </span>
        </Title>
        <span className="flex-1" />
        <DeployDriftMark environmentId={id} />
        {refused && onMenu ? (
          <Button variant="secondary" size="sm" onClick={() => onMenu("repair")}>
            Pair again
          </Button>
        ) : null}
        {status.transport === "reconnecting" || status.transport === "offline" ? (
          <Button variant="secondary" size="sm" onClick={() => registry.retry(id)}>
            Retry
          </Button>
        ) : null}
        {onMenu ? <HostMenu name={name} open={status.transport === "open"} onRetry={() => registry.retry(id)} onMenu={onMenu} /> : null}
      </header>
      <p className="text-xs text-muted-foreground">
        <Facts parts={facts} />
      </p>
    </div>
  );
}

function HostMenu({
  name,
  open,
  onRetry,
  onMenu,
}: {
  name: string;
  open: boolean;
  onRetry: () => void;
  onMenu: (action: HostMenuAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${name} actions`} className="text-muted-foreground" />}>
        <MoreHorizontal strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" size="sm">
        <DropdownMenuItem disabled={open} onClick={onRetry}>
          Retry now
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMenu("repair")}>Pair again…</DropdownMenuItem>
        <DropdownMenuSeparator />
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
