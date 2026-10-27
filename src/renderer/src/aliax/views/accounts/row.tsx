import { useState } from "react";
import type { AccountHeadroom, MintState } from "@shared/accounts";
import { windowName } from "@shared/usageMeter";
import type { PlanInfo, ProfileView, ServiceId, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { MoreHorizontal } from "@renderer/chrome/icons";
import { PageRow } from "@renderer/components/page";
import { Button } from "@renderer/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Progress, type ProgressFill } from "@renderer/components/ui/progress";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { Switch } from "@renderer/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { headroomLook, type HeadroomLook } from "@renderer/lib/headroom";
import { DEFAULT_COLOR, displayName, fillFor, onPaceLeft, percentLeft, resetLabel, toneFor, untilLabel } from "@aliax/lib/accounts";
import { EditAccountDialog } from "@aliax/views/edit-account-dialog";
import { rowLine, shortDay, type OwnerView, type RowAction } from "./rowLine";

/** A row shows at most this many bars: the windows, then Rate. */
export const MAX_BARS = 4;

const RATE_FILL: Record<HeadroomLook["tone"], ProgressFill> = { muted: "muted", ok: "muted", low: "warning", limited: "warning" };
const RATE_TEXT: Record<HeadroomLook["tone"], string> = {
  muted: "text-muted-foreground",
  ok: "text-muted-foreground",
  low: "text-warning",
  limited: "text-warning",
};

/** The bar columns a section reserves: as many window columns as its busiest row, then one Rate column when any row has one. */
export type BarColumns = { windows: number; rate: boolean };

export function barColumns(rows: { report: UsageReport | undefined; headroom: AccountHeadroom | undefined }[]): BarColumns {
  const rate = rows.some((r) => r.headroom !== undefined);
  const windows = Math.min(MAX_BARS - (rate ? 1 : 0), Math.max(0, ...rows.map((r) => r.report?.windows.length ?? 0)));
  return { windows, rate };
}

function Bar({ label, value, valueClass, percent, fill, tick, name }: { label: string; value: string; valueClass: string; percent: number; fill: ProgressFill; tick?: number | null; name: string }) {
  return (
    <span className="flex w-[72px] flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-xs leading-none">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", valueClass)}>{value}</span>
      </span>
      <span className="relative">
        <Progress value={percent} fill={fill} aria-label={name} />
        {/* Where an even burn would put you: fill past the tick means ahead. */}
        {tick != null && tick > 2 && tick < 98 ? <span aria-hidden className="absolute -top-0.5 h-2 w-px bg-foreground/50" style={{ left: `${tick}%` }} /> : null}
      </span>
    </span>
  );
}

function WindowDetail({ w, now }: { w: UsageWindow; now: number }) {
  const pace = onPaceLeft(w, now);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium">{windowName(w.label)}</span>
        <span className={cn("tabular-nums", toneFor(w, now))}>{Math.round(percentLeft(w))}% left</span>
      </div>
      {w.resetsAt && w.resetsAt > now ? (
        <p className="text-xs text-muted-foreground">
          Refills {resetLabel(w.resetsAt)}, in {untilLabel(w.resetsAt, now)}
        </p>
      ) : null}
      {pace !== null ? <p className="text-xs text-muted-foreground">An even burn leaves {Math.round(pace)}% by now</p> : null}
    </div>
  );
}

/**
 * One compact bar per usage window, then the gateway's Rate bar. The bars of
 * a row sit inside one button whose popover holds every detail, so the
 * detail is drawn once and reachable by keyboard. `columns` is what the
 * section reserves; each row fills its window columns from the right and
 * keeps Rate last, so the weekly bars line up down the section.
 */
export function UsageBars({ name, report, headroom, columns, now }: { name: string; report: UsageReport | undefined; headroom: AccountHeadroom | undefined; columns: BarColumns; now: number }) {
  if (report === undefined) {
    return (
      <span className="flex items-center gap-3" aria-busy="true">
        <Skeleton className="h-6 w-[72px]" />
        <Skeleton className="h-6 w-[72px]" />
      </span>
    );
  }
  const windows = report.windows.slice(0, columns.windows);
  const rate = headroom ? headroomLook(headroom, now) : null;
  const count = windows.length + (rate ? 1 : 0);
  const spacer = (key: string) => <span key={key} aria-hidden className="w-[72px]" />;
  const note = report.windows.length === 0 ? (report.rateLimit ? "No usage yet" : (report.note ?? report.extra ?? "Usage unavailable")) : null;
  return (
    <span className="flex items-center gap-3">
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      {Array.from({ length: Math.max(0, columns.windows - windows.length) }, (_, i) => spacer(`w${i}`))}
      {count > 0 ? (
        <Popover>
          <PopoverTrigger
            render={<Button variant="ghost" aria-label={`Usage details for ${name}`} aria-haspopup="dialog" className="-mx-2 h-auto gap-3 px-2 py-1.5 font-normal" />}
          >
            {windows.map((w) => {
              const left = Math.round(percentLeft(w));
              const label = windowName(w.label);
              return (
                <Bar key={w.label} label={label} value={`${left}%`} valueClass={toneFor(w, now)} percent={left} fill={fillFor(w, now)} tick={onPaceLeft(w, now)} name={`${label}: ${left} percent left`} />
              );
            })}
            {rate ? (
              <Bar
                label="Rate"
                value={rate.tone === "limited" ? "Limited" : rate.tone === "muted" ? "" : `${rate.percent}%`}
                valueClass={RATE_TEXT[rate.tone]}
                percent={rate.percent}
                fill={RATE_FILL[rate.tone]}
                name={`Rate: ${rate.until ? `${rate.text} for ${rate.until}` : rate.text}`}
              />
            ) : null}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-3 p-3">
            {windows.map((w) => (
              <WindowDetail key={w.label} w={w} now={now} />
            ))}
            {rate ? (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="font-medium">Rate</span>
                  <span className={cn("tabular-nums", RATE_TEXT[rate.tone])}>{rate.text}</span>
                </div>
                {rate.lines.map((line) => (
                  <p key={line} className="text-xs text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
      {columns.rate && !rate ? spacer("rate") : null}
    </span>
  );
}

/** Plain words for the subscription statuses the providers report; 'lapsed' is ours (Codex, past its paid-through date). */
const STATUS_TEXT: Record<string, string> = {
  canceled: "Canceled",
  cancelled: "Canceled",
  past_due: "Payment past due",
  unpaid: "Payment failed",
  incomplete: "Payment incomplete",
  incomplete_expired: "Payment expired",
  paused: "Paused",
  lapsed: "Ended",
};
/** Statuses that are fine: nothing to say. */
const STATUS_OK = new Set(["active", "trialing"]);

export type PlanFact = { text: string; warning?: boolean };

/** The plan line's facts, in order: name, price, renewal or the trouble, banked resets. */
export function planFacts(plan: PlanInfo | undefined, banked: number | undefined): PlanFact[] {
  const facts: PlanFact[] = [];
  if (plan) {
    facts.push({ text: plan.name });
    if (plan.monthlyUsd !== undefined) facts.push({ text: `$${plan.monthlyUsd}/mo` });
    if (plan.cancelsAt !== undefined) facts.push({ text: "Canceled", warning: true }, { text: `ends ${shortDay(plan.cancelsAt)}`, warning: true });
    else if (plan.status && !STATUS_OK.has(plan.status)) {
      const raw = plan.status.replace(/_/g, " ");
      facts.push({ text: STATUS_TEXT[plan.status] ?? raw.charAt(0).toUpperCase() + raw.slice(1), warning: true });
    } else if (plan.renewsAt !== undefined) facts.push({ text: `renews ${shortDay(plan.renewsAt)}` });
  }
  if (banked && banked > 0) facts.push({ text: `${banked} reset${banked === 1 ? "" : "s"} banked` });
  return facts;
}

export interface AccountRowProps {
  serviceId: ServiceId;
  profile: ProfileView;
  report?: UsageReport;
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
  onRemove: () => void;
  onEdited: () => void;
}

export function AccountRow({ serviceId, profile, report, headroom, columns, now, owner, mint, billingUrl, switching, onUse, onAction, onSetupToken, onRemove, onEdited }: AccountRowProps) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const name = displayName(profile);
  const line = rowLine(profile, report, owner, mint, now);
  const plan = planFacts(report?.plan, report?.banked);
  return (
    <PageRow
      media={<span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: profile.color ?? DEFAULT_COLOR }} />}
      title={<span className={cn("truncate", profile.active ? null : "font-normal text-muted-foreground")}>{name}</span>}
      description={
        line || plan.length ? (
          <>
            {line ? (
              <span className={cn("flex items-center gap-2", line.tone === "warning" ? "text-warning" : null)}>
                {line.busy ? <Spinner className="size-3" /> : null}
                <span>{line.text}</span>
                {line.detail ? <span>{line.detail}</span> : null}
                {line.action ? (
                  <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => onAction(line.action!.kind)}>
                    {line.action.label}
                  </Button>
                ) : null}
              </span>
            ) : null}
            {plan.length ? (
              <span className="flex flex-wrap gap-x-2">
                {plan.map((f) => (
                  <span key={f.text} className={f.warning ? "text-warning" : undefined}>
                    {f.text}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        ) : undefined
      }
    >
      <UsageBars name={name} report={report} headroom={headroom} columns={columns} now={now} />
      <Switch aria-label={`Use ${name}`} checked={profile.active || switching} disabled={profile.active || switching} onCheckedChange={(on) => on && onUse()} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`} className="text-muted-foreground" />} />}
          >
            <MoreHorizontal strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" size="sm">
          <DropdownMenuItem onClick={() => setEditing(true)}>Edit account…</DropdownMenuItem>
          {serviceId === "claude-code" ? (
            <DropdownMenuItem disabled={mint?.state === "minting"} onClick={onSetupToken}>
              {profile.static ? "New one-year token" : "Replace with a one-year token"}
            </DropdownMenuItem>
          ) : null}
          {billingUrl ? <DropdownMenuItem onClick={() => void window.aliax.openExternal(billingUrl)}>Manage plan</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditAccountDialog open={editing} onOpenChange={setEditing} serviceId={serviceId} profile={profile} onSaved={onEdited} />
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>Its saved sign-in is deleted. Signing in again brings it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                onRemove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageRow>
  );
}
