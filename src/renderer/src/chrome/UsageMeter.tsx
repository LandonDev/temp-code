import { useRef, useState } from "react";
import { registry } from "../lib/connection";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { AccountsPopover } from "./AccountsPopover";
import { HarnessIcon } from "./HarnessIcon";
import { scopeOf } from "../lib/accountScope";
import { useSlowClock } from "../lib/turnClock";
import { HARNESS_TITLE } from "../lib/session";
import { sessionStore, useSessionMeta } from "../lib/tcserver/store";
import { useProjects, useWorkspaces } from "../lib/tcserver/workspaces";
import { useAccounts } from "../stores/accounts";
import { ACCOUNT_PROVIDERS, type AccountProvider, type ProviderAccounts } from "@server/shared/accounts";
import { meterFor, untilShort, type UsageMeter as Meter } from "@server/shared/usageMeter";

/**
 * The rail's foot: one row per provider with accounts, the room the next
 * pick would land on and when it refills. The row opens the account list.
 * It reads the accounts of the active thread's host, else this machine's.
 */
export function UsageMeter({ sessionId }: { sessionId?: string }) {
  const now = useSlowClock(true);
  const meta = useSessionMeta(sessionId);
  const environmentId =
    (sessionId ? sessionStore.environmentOf(sessionId) : undefined) ??
    meta?.environmentId ??
    registry.primary().environmentId;
  const { snapshot } = useAccounts(environmentId);
  const rows = ACCOUNT_PROVIDERS.flatMap((provider) => {
    const meter = meterFor(provider, snapshot, now);
    return meter ? [{ provider, meter }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div aria-label="Usage" className="flex shrink-0 flex-col gap-px px-2 pb-2">
      {rows.map(({ provider, meter }) => (
        <MeterRow
          key={provider}
          provider={provider}
          meter={meter}
          accounts={snapshot.providers[provider]}
          sessionId={sessionId}
          now={now}
        />
      ))}
    </div>
  );
}

function MeterRow({
  provider,
  meter,
  accounts,
  sessionId,
  now,
}: {
  provider: AccountProvider;
  meter: Meter;
  accounts: ProviderAccounts;
  sessionId?: string;
  now: number;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const meta = useSessionMeta(sessionId);
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const scope = meta && meta.provider === provider ? scopeOf(meta, projects, workspaces) : null;
  const left = meter.share === null ? null : Math.round(meter.share * 100);
  const resets = meter.resetsAt !== null && meter.resetsAt > now ? `resets in ${untilShort(meter.resetsAt, now)}` : null;

  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        className="h-9 w-full justify-start gap-2 rounded-md px-2.5 font-normal"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={left === null ? `${HARNESS_TITLE[provider]} usage` : `${HARNESS_TITLE[provider]} usage, ${left}% left`}
        data-provider={provider}
        onClick={() => setOpen((v) => !v)}
      >
        <HarnessIcon harness={provider} className="size-4 shrink-0" />
        <Progress value={left} aria-label={`${HARNESS_TITLE[provider]} usage left`} className="w-20 shrink-0" />
        {resets ? (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground tabular-nums">{resets}</span>
        ) : null}
      </Button>
      {open ? (
        <AccountsPopover
          anchor={anchor}
          provider={provider}
          accounts={accounts}
          scope={scope}
          now={now}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
