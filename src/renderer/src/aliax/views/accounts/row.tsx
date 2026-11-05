import { useState, type CSSProperties, type ReactNode } from "react";
import { maskedKey, type AccountHeadroom, type KeyProfileView, type MintState } from "@shared/accounts";
import { windowName } from "@shared/usageMeter";
import type { PlanInfo, ProfileView, ServiceId, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { MoreHorizontal } from "@renderer/chrome/icons";
import { PageRow } from "@renderer/components/page";
import { Tip } from "@renderer/components/tip";
import { StatusMark } from "@renderer/components/ui/status";
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
import { DEFAULT_COLOR, displayName, fillFor, onPaceLeft, percentLeft, toneFor, untilLabel } from "@aliax/lib/accounts";
import { EditAccountDialog } from "@aliax/views/edit-account-dialog";
import { keyStatus, limitOf, resetWords, rowLine, shortDay, type OwnerView, type RowAction } from "./rowLine";

/** A row shows at most this many bars: the windows, then Rate. */
export const MAX_BARS = 4;

/**
 * The page's container (accounts.tsx): from 48rem wide the rows are a table,
 * every usage column 8.5rem (a bar over "Resets Thu 12:00 PM") with the
 * account's name taking what is left; under it each row stacks its columns
 * under the name across the row's width.
 */
const CELL = "flex min-w-0 flex-1 basis-0 flex-col gap-1 @3xl/accounts:w-34 @3xl/accounts:flex-none";
/** The status words of a row with no windows, over the window columns it stands in for (`--span`). */
const SPAN = "min-w-0 flex-[var(--span)_1_0%] @3xl/accounts:flex-none @3xl/accounts:w-[calc(var(--span)*8.5rem+(var(--span)-1)*0.75rem)]";

const RATE_FILL: Record<HeadroomLook["tone"], ProgressFill> = { muted: "muted", ok: "muted", low: "warning", limited: "warning" };
const RATE_TEXT: Record<HeadroomLook["tone"], string> = {
  muted: "text-muted-foreground",
  ok: "text-muted-foreground",
  low: "text-warning",
  limited: "text-warning",
};

/** The bar columns the page reserves: as many window columns as its busiest row, then one Rate column when any row has one. */
export type BarColumns = { windows: number; rate: boolean };

export function barColumns(rows: { report: UsageReport | undefined; headroom: AccountHeadroom | undefined }[]): BarColumns {
  const rate = rows.some((r) => r.headroom !== undefined);
  const windows = Math.min(MAX_BARS - (rate ? 1 : 0), Math.max(0, ...rows.map((r) => r.report?.windows.length ?? 0)));
  return { windows, rate };
}

/** When a window refills, its clock time on the row and how long until then on hover. */
export function ResetTime({ at, now }: { at: number; now: number }) {
  return (
    <Tip label={`in ${untilLabel(at, now)}`}>
      <span data-slot="reset-time" className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
        {resetWords(at, now)}
      </span>
    </Tip>
  );
}

function Bar({
  label,
  value,
  valueClass,
  percent,
  fill,
  tick,
  name,
  reset,
}: {
  label: string;
  value: string;
  valueClass: string;
  percent: number;
  fill: ProgressFill;
  tick?: number | null;
  name: string;
  /** The window's reset line under the bar. */
  reset?: ReactNode;
}) {
  return (
    <span data-slot="usage-cell" className={CELL}>
      <span className="flex items-baseline justify-between gap-2 text-xs leading-4">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", valueClass)}>{value}</span>
      </span>
      <span className="relative">
        <Progress value={percent} fill={fill} aria-label={name} />
        {/* Where an even burn would put you: fill past the tick means ahead. */}
        {tick != null && tick > 2 && tick < 98 ? <span aria-hidden className="absolute -top-0.5 h-2 w-px bg-foreground/50" style={{ left: `${tick}%` }} /> : null}
      </span>
      {reset}
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
      {/* The refill is on the row under the bar; the popover adds the pace. */}
      {pace !== null ? <p className="text-xs text-muted-foreground">An even burn leaves {Math.round(pace)}% by now</p> : null}
    </div>
  );
}

const spacer = (key: string) => <span key={key} aria-hidden data-slot="usage-cell" className={CELL} />;

/**
 * One column per usage window, each its bar over the time it resets, then
 * the gateway's Rate bar. The bars of a row sit inside one button whose
 * popover holds every detail, so the detail is drawn once and reachable by
 * keyboard. `columns` is what the page reserves; each row fills its window
 * columns from the left and keeps Rate last, so the 5h and weekly columns
 * line up down the page.
 */
export function UsageBars({
  name,
  report,
  headroom,
  columns,
  now,
  keyed = false,
  className,
}: {
  className?: string;
  name: string;
  report: UsageReport | undefined;
  headroom: AccountHeadroom | undefined;
  columns: BarColumns;
  now: number;
  /** A key account: no windows to draw, its state in their place (Pay as you go, Key revoked). */
  keyed?: boolean;
}) {
  const span = Math.max(1, columns.windows);
  if (report === undefined) {
    const cells = keyed ? 1 : span + (columns.rate ? 1 : 0);
    return (
      <span data-slot="usage-cells" className={cn("flex items-start gap-3", className)} aria-busy="true">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} data-slot="usage-cell" className={CELL}>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-1 w-full" />
          </span>
        ))}
      </span>
    );
  }
  const windows = report.windows.slice(0, columns.windows);
  const rate = headroom ? headroomLook(headroom, now) : null;
  const count = windows.length + (rate ? 1 : 0);
  const status = keyed ? keyStatus(report) : null;
  const note = keyed ? null : report.windows.length === 0 ? (report.rateLimit ? "No usage yet" : (report.note ?? report.extra ?? "Usage unavailable")) : null;
  const words = note ?? status?.text ?? null;
  return (
    <span data-slot="usage-cells" className={cn("flex items-start gap-3", className)}>
      {words !== null ? (
        <span
          className={cn(SPAN, "truncate py-1.5 text-xs leading-4", status?.tone === "warning" ? "text-warning" : "text-muted-foreground")}
          style={{ "--span": span } as CSSProperties}
        >
          {words}
        </span>
      ) : null}
      {count > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                aria-label={`Usage details for ${name}`}
                aria-haspopup="dialog"
                className="-mx-2 h-auto min-w-0 flex-[var(--grow)_1_0%] items-start justify-start gap-3 px-2 py-1.5 text-start font-normal @3xl/accounts:flex-none"
                style={{ "--grow": (windows.length > 0 ? span : 0) + (columns.rate ? 1 : 0) } as CSSProperties}
              />
            }
          >
            {windows.map((w) => {
              const left = Math.round(percentLeft(w));
              const label = windowName(w.label);
              const resets = w.resetsAt !== undefined && w.resetsAt > now ? w.resetsAt : null;
              return (
                <Bar
                  key={w.label}
                  label={label}
                  value={`${left}%`}
                  valueClass={toneFor(w, now)}
                  percent={left}
                  fill={fillFor(w, now)}
                  tick={onPaceLeft(w, now)}
                  name={`${label}: ${left} percent left${resets !== null ? `, ${resetWords(resets, now).toLowerCase()}` : ""}`}
                  reset={resets !== null ? <ResetTime at={resets} now={now} /> : null}
                />
              );
            })}
            {windows.length > 0 ? Array.from({ length: Math.max(0, columns.windows - windows.length) }, (_, i) => spacer(`w${i}`)) : null}
            {rate ? (
              <Bar
                label="Rate"
                value={rate.tone === "limited" ? "Limited" : rate.tone === "muted" ? "" : `${rate.percent}%`}
                valueClass={RATE_TEXT[rate.tone]}
                percent={rate.percent}
                fill={RATE_FILL[rate.tone]}
                name={`Rate: ${rate.until ? `${rate.text} for ${rate.until}` : rate.text}`}
              />
            ) : columns.rate ? (
              spacer("rate")
            ) : null}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-3 p-3">
            {/* Every window, even one past the bar cap: the popover is where all of them live. */}
            {report.windows.map((w) => (
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
      ) : columns.rate ? (
        spacer("rate")
      ) : null}
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
      description={
        line || plan.length || mask ? (
          <>
            {mask ? <span className="tabular-nums">{mask}</span> : null}
            {line?.limited ? (
              <StatusMark state="waiting" glyph={false} word={line.text} detail={line.limited.resetsAt !== null ? <ResetTime at={line.limited.resetsAt} now={now} /> : undefined} />
            ) : line ? (
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
      <UsageBars
        name={name}
        report={report}
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
            <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <EditAccountDialog open={editing} onOpenChange={setEditing} serviceId={serviceId} profile={profile} onSaved={onEdited} />
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>{keyed ? "The key is deleted from every host. Adding it again brings it back." : "Its saved sign-in is deleted. Signing in again brings it back."}</AlertDialogDescription>
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
