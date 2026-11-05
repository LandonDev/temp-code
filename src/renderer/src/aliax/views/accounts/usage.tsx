import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { AccountHeadroom } from "@shared/accounts";
import { windowName } from "@shared/usageMeter";
import type { PlanInfo, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { Tip } from "@renderer/components/tip";
import { StatusMark } from "@renderer/components/ui/status";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Progress, type ProgressFill } from "@renderer/components/ui/progress";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { cn } from "@renderer/lib/cn";
import { headroomLook, type HeadroomLook } from "@renderer/lib/headroom";
import { fillFor, onPaceLeft, percentLeft, toneFor, untilLabel } from "@aliax/lib/accounts";
import { keyStatus, resetWords, shortDay, type RowAction, type RowLine } from "./rowLine";

/*
 * What an account row says, drawn once: its usage columns (UsageBars), its
 * state line and plan facts (RowFacts). The Accounts page's rows and the
 * failure card's account picker (chrome/AccountsList.tsx, read-only) both
 * render these, so one account reads the same in both places.
 */

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
/** The bars' box: the window columns and Rate, growing by how many it holds under 48rem. */
const GROW = "min-w-0 flex-[var(--grow)_1_0%] @3xl/accounts:flex-none";
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
 * keyboard; `readOnly` draws the bars alone. `columns` is what the page reserves; each row fills its window
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
  readOnly = false,
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
  /** The bars alone, with no button or detail popover (the failure card's picker, itself a popover). */
  readOnly?: boolean;
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
  const grow = { "--grow": (windows.length > 0 ? span : 0) + (columns.rate ? 1 : 0) } as CSSProperties;
  const cells = (
    <>
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
    </>
  );
  return (
    <span data-slot="usage-cells" className={cn("flex items-start gap-3", className)}>
      {words !== null ? (
        <span
          className={cn(SPAN, "truncate text-xs leading-4", readOnly ? null : "py-1.5", status?.tone === "warning" ? "text-warning" : "text-muted-foreground")}
          style={{ "--span": span } as CSSProperties}
        >
          {words}
        </span>
      ) : null}
      {count > 0 ? (
        readOnly ? (
          <span className={cn(GROW, "flex items-start gap-3")} style={grow}>
            {cells}
          </span>
        ) : (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={`Usage details for ${name}`}
                  aria-haspopup="dialog"
                  className={cn(GROW, "-mx-2 h-auto items-start justify-start gap-3 px-2 py-1.5 text-start font-normal")}
                  style={grow}
                />
              }
            >
              {cells}
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
        )
      ) : columns.rate ? (
        spacer("rate")
      ) : null}
    </span>
  );
}

/** Plain words for the subscription statuses the providers report; 'lapsed' is ours (Codex, past its paid-through date). */
const STATUS_TEXT: Record<string, string> = {
  canceled: "canceled",
  cancelled: "canceled",
  past_due: "payment past due",
  unpaid: "payment failed",
  incomplete: "payment incomplete",
  incomplete_expired: "payment expired",
  paused: "paused",
  lapsed: "ended",
};
/** Statuses that are fine: nothing to say. */
const STATUS_OK = new Set(["active", "trialing"]);

export type PlanFact = { text: string; warning?: boolean };

/** The plan line: its name, then the rest as one detail sentence ("$200/mo, renews Nov 12"). */
export type PlanLine = { name: string | null; detail: PlanFact[] };

const capital = (f: PlanFact): PlanFact => ({ ...f, text: f.text.charAt(0).toUpperCase() + f.text.slice(1) });

/** The plan line's facts, in order: name, price, renewal or the trouble, banked resets. The detail is one sentence, so only its first word takes a capital. */
export function planFacts(plan: PlanInfo | undefined, banked: number | undefined): PlanLine {
  const detail: PlanFact[] = [];
  if (plan) {
    if (plan.monthlyUsd !== undefined) detail.push({ text: `$${plan.monthlyUsd}/mo` });
    if (plan.cancelsAt !== undefined) detail.push({ text: "canceled", warning: true }, { text: `ends ${shortDay(plan.cancelsAt)}`, warning: true });
    else if (plan.status && !STATUS_OK.has(plan.status)) detail.push({ text: STATUS_TEXT[plan.status] ?? plan.status.replace(/_/g, " "), warning: true });
    else if (plan.renewsAt !== undefined) detail.push({ text: `renews ${shortDay(plan.renewsAt)}` });
  }
  if (banked && banked > 0) detail.push({ text: `${banked} reset${banked === 1 ? "" : "s"} banked` });
  if (detail.length > 0) detail[0] = capital(detail[0]);
  return { name: plan?.name ?? null, detail };
}

/** Whether a plan line has anything to say. */
const hasPlan = (plan: PlanLine): boolean => plan.name !== null || plan.detail.length > 0;

/**
 * The lines under an account's name: a key's mask, the state line (rowLine:
 * Limited with its reset, a sign-in's state, its one action) and the plan's
 * facts. Read-only without `onAction`: the action's link is not drawn.
 */
export function RowFacts({
  line,
  plan,
  mask,
  now,
  onAction,
}: {
  line: RowLine | null;
  plan: PlanLine;
  mask?: string | null;
  now: number;
  onAction?: (kind: RowAction["kind"]) => void;
}) {
  if (!line && !hasPlan(plan) && !mask) return null;
  return (
    <>
      {mask ? <span className="tabular-nums">{mask}</span> : null}
      {line?.limited ? (
        <StatusMark state="waiting" glyph={false} word={line.text} detail={line.limited.resetsAt !== null ? <ResetTime at={line.limited.resetsAt} now={now} /> : undefined} />
      ) : line ? (
        // Two facts, as a status says them: the state in medium weight and its tone, the detail regular and muted 4px after it.
        <span data-slot="row-line" className="flex flex-wrap items-center gap-x-1">
          {line.busy ? <Spinner className="me-1 size-3" /> : null}
          <span className={cn("font-medium", line.tone === "warning" ? "text-warning" : "text-muted-foreground")}>{line.text}</span>
          {line.detail ? <span className="text-muted-foreground">{line.detail}</span> : null}
          {line.action && onAction ? (
            <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => onAction(line.action!.kind)}>
              {line.action.label}
            </Button>
          ) : null}
        </span>
      ) : null}
      {hasPlan(plan) ? (
        // Inline, so a long detail wraps word by word under the name; the space is its 4px.
        <span data-slot="plan-line" className="block">
          {plan.name ? <span className="font-medium">{plan.name}</span> : null}
          {plan.name && plan.detail.length ? " " : null}
          {plan.detail.length ? (
            <span>
              {plan.detail.map((f, i) => (
                <Fragment key={f.text}>
                  {i > 0 ? ", " : null}
                  <span className={f.warning ? "text-warning" : undefined}>{f.text}</span>
                </Fragment>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}
