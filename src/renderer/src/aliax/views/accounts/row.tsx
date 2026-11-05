import { useState } from "react";
import { maskedKey, type AccountHeadroom, type KeyProfileView, type MintState } from "@shared/accounts";
import type { ProfileView, ServiceId, UsageReport } from "aliax-core/shared/types";
import { MoreHorizontal } from "@renderer/chrome/icons";
import { PageRow } from "@renderer/components/page";
import { Button } from "@renderer/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu";
import { Switch } from "@renderer/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { DEFAULT_COLOR, displayName } from "@aliax/lib/accounts";
import { EditAccountDialog } from "@aliax/views/edit-account-dialog";
import { limitOf, rowLine, type OwnerView, type RowAction } from "./rowLine";
import { barResets, planFacts, RowFacts, UsageBars, type BarColumns } from "./usage";

export { barColumns, MAX_BARS, planFacts, ResetTime, RowFacts, UsageBars, type BarColumns, type PlanFact, type PlanLine } from "./usage";

export interface AccountRowProps {
  serviceId: ServiceId;
  profile: ProfileView;
  report?: UsageReport;
  /** The row's last report while a Refresh masks `report` (the page's `layout`). */
  last?: UsageReport;
  headroom?: AccountHeadroom;
  columns: BarColumns;
  now: number;
  owner: OwnerView | null;
  mint?: MintState;
  billingUrl?: string;
  /** A switch to this account is under way. */
  switching: boolean;
  onUse: () => void;
  onAction: (kind: RowAction["kind"]) => void;
  onSetupToken: () => void;
  /** Remove…: the page asks, holding its confirm past this row (a removed row leaves before the confirm's exit plays). */
  onRemove: () => void;
  onEdited: () => void;
}

export function AccountRow({ serviceId, profile, report, last, headroom, columns, now, owner, mint, billingUrl, switching, onUse, onAction, onSetupToken, onRemove, onEdited }: AccountRowProps) {
  const [editing, setEditing] = useState(false);
  const name = displayName(profile);
  const line = rowLine(profile, report, owner, mint, now, limitOf(report, headroom, now));
  const keyed = profile.kind === "key";
  // A key shows as `LLM_1607…`, built from the account id the main process adds; the key never reaches the page.
  const accountId = (profile as KeyProfileView).accountId;
  const mask = keyed && accountId ? maskedKey(accountId) : null;
  const plan = planFacts(report?.plan, report?.banked);
  return (
    <PageRow
      // From 48rem of page the row is a table line: the name takes what the
      // fixed usage columns and the controls leave. Under it the actions box
      // unwraps, the controls stay on the name's line and the columns wrap
      // to a line of their own under the name.
      className="@max-3xl/accounts:gap-y-2 @max-3xl/accounts:[&>[data-slot=item-actions]]:contents [&>[data-slot=item-actions]]:gap-3"
      media={<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: profile.color ?? DEFAULT_COLOR }} />}
      title={<span className={cn("truncate", profile.active ? null : "font-normal text-muted-foreground")}>{name}</span>}
      description={plan.name || plan.detail.length || line || mask ? <RowFacts line={line} plan={plan} mask={mask} now={now} shownResets={barResets(report, columns, now)} onAction={onAction} /> : undefined}
    >
      <UsageBars
        name={name}
        report={report}
        last={last}
        headroom={headroom}
        columns={columns}
        now={now}
        keyed={keyed}
        className="order-last basis-full ps-5 @3xl/accounts:order-none @3xl/accounts:basis-auto @3xl/accounts:ps-0"
      />
      <span data-slot="account-controls" className="flex items-center gap-2">
        {/* A key is not switched to: routing picks among the keys per thread; its place stays, so the columns line up. */}
        {keyed ? (
          <span aria-hidden className="w-8" />
        ) : (
          <Switch aria-label={`Use ${name}`} checked={profile.active || switching} disabled={profile.active || switching} onCheckedChange={(on) => on && onUse()} />
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`} className="text-muted-foreground" />} />}
            >
              <MoreHorizontal />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {keyed ? null : <DropdownMenuItem onClick={() => setEditing(true)}>Edit account…</DropdownMenuItem>}
            {serviceId === "claude-code" && !keyed ? (
              <DropdownMenuItem disabled={mint?.state === "minting"} onClick={onSetupToken}>
                {profile.static ? "New one-year token" : "Replace with a one-year token"}
              </DropdownMenuItem>
            ) : null}
            {billingUrl && !keyed ? <DropdownMenuItem onClick={() => void window.aliax.openExternal(billingUrl)}>Manage plan</DropdownMenuItem> : null}
            {keyed ? null : <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <EditAccountDialog open={editing} onOpenChange={setEditing} serviceId={serviceId} profile={profile} onSaved={onEdited} />
    </PageRow>
  );
}
