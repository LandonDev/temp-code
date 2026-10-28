import type { ReactElement } from "react";
import type { PlanInfo, ProfileView, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { Tip } from "../components/tip";
import { Skeleton } from "../components/ui/skeleton";
import { Check, Pin } from "./icons";
import { HeadroomLine } from "./HeadroomLine";
import { LazyPopover } from "./menuRows";
import {
  cycleMs,
  displayName,
  fillFor,
  onPaceLeft,
  percentLeft,
  reportOf,
  resetLabel,
  toneFor,
  untilLabel,
} from "../lib/accounts";
import { sourceLine, type AccountScope } from "../lib/accountScope";
import type { AccountHeadroom, AccountProvider, ProviderAccounts } from "@server/shared/accounts";

/** A usage column is 10rem plus a 1.5rem gutter; the name column takes 13rem. */
const CELL_REM = 10;
const GUTTER_REM = 1.5;
const NAME_REM = 13;
const MIN_SLOTS = 2;
const MAX_SLOTS = 4;
const REM = 16;

/**
 * Every saved account of one provider, in Aliax's own row order, each with
 * the same usage cells Aliax draws: percent left, a bar with the on-pace
 * tick, and when the window refills. Read-only: a thread is always auto,
 * and adding, editing, pinning or removing accounts stays in Aliax.
 *
 * With a thread in scope a line says where its account comes from, a check
 * marks the account it spends from and a pin marks its project's or
 * workspace's pin. Without a scope (Cursor, or no thread) the check is
 * Aliax's global pin. The list floats from its trigger (the failure card's
 * Pick another account).
 */
export function AccountsPopover({
  trigger,
  open,
  onOpenChange,
  provider,
  accounts,
  scope,
  now,
}: {
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: AccountProvider;
  accounts: ProviderAccounts;
  /** The thread the list describes; null shows the global pin. */
  scope: AccountScope | null;
  now: number;
}) {
  // Every row reserves the same columns so bars line up down the list.
  const slots = Math.min(
    MAX_SLOTS,
    Math.max(MIN_SLOTS, ...accounts.reports.map((r) => groupWindows(r.windows).length)),
  );
  const width = (NAME_REM + slots * CELL_REM + slots * GUTTER_REM + 1) * REM;
  const checked = scope ? scope.shown : accounts.pinned;

  return (
    <LazyPopover
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="start"
      label={`${provider} accounts`}
      className="max-h-(--available-height) w-auto gap-0 overflow-y-auto p-1.5"
    >
      <div role="listbox" aria-label={`${provider} accounts`} aria-readonly data-account-picker style={{ width: `${width / REM}rem` }}>
        {scope ? (
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">{sourceLine(scope)}</p>
        ) : null}
        {accounts.profiles.map((profile) => (
          <AccountRow
            key={profile.name}
            profile={profile}
            report={reportOf(accounts.reports, profile.name)}
            headroom={accounts.headroom?.[profile.name]}
            checked={profile.name === checked}
            inherited={scope && profile.name === scope.inherited?.name ? scope.inherited.level : null}
            now={now}
            slots={slots}
          />
        ))}
        {accounts.note ? (
          <p className="px-2.5 pb-1 pt-2 text-[11px] text-muted-foreground">{accounts.note}</p>
        ) : null}
      </div>
    </LazyPopover>
  );
}

function AccountRow({
  profile,
  report,
  headroom,
  checked,
  inherited,
  now,
  slots,
}: {
  profile: ProfileView;
  report: UsageReport | undefined;
  /** What the gateways have seen of the account's per-request limits; absent until the host keeps a picture. */
  headroom: AccountHeadroom | undefined;
  /** The account the thread spends from (or the global pin without a thread). */
  checked: boolean;
  /** The project or workspace pin that applies to the thread. */
  inherited: "project" | "workspace" | null;
  now: number;
  slots: number;
}) {
  const status = statusLine(report, now);
  return (
    <div
      role="option"
      aria-selected={checked}
      aria-disabled
      className="flex w-full items-center gap-6 rounded-lg px-2.5 py-2.5 text-left text-[12px] leading-none text-foreground"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2.5">
        <span
          aria-hidden
          className={`mt-0.5 size-2 shrink-0 rounded-full ${profile.color ? "" : "bg-foreground/30"}`}
          style={profile.color ? { background: profile.color } : undefined}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-1.5">
            <span className={`truncate ${checked ? "font-medium" : ""}`}>{displayName(profile)}</span>
            {profile.duplicate ? <span className="shrink-0 text-[10px] text-warning">duplicate</span> : null}
            {checked ? <Check className="size-3 shrink-0 text-muted-foreground" aria-label="In use" /> : null}
            {inherited ? (
              <Pin className="size-3 shrink-0 text-muted-foreground" aria-label={`Pinned by the ${inherited}`} />
            ) : null}
          </span>
          {report?.plan ? <PlanLine plan={report.plan} now={now} /> : null}
          {status ? <Facts parts={status.parts} className={`text-[11px] ${status.tone}`} /> : null}
          {report?.banked ? (
            <span className="text-[11px] text-muted-foreground">
              {report.banked} banked reset{report.banked === 1 ? "" : "s"}
            </span>
          ) : null}
          {headroom ? <HeadroomLine headroom={headroom} now={now} /> : null}
        </span>
      </span>
      <UsageBlock report={report} now={now} slots={slots} />
    </div>
  );
}

/** Facts on one line, 8px apart; the last one gives way when the line is short. */
function Facts({ parts, className }: { parts: readonly (string | { text: string; className?: string })[]; className?: string }) {
  return (
    <span className={`flex min-w-0 gap-2 ${className ?? ""}`}>
      {parts.map((part, i) => {
        const { text, className: tone } = typeof part === "string" ? { text: part, className: undefined } : part;
        return (
          <span key={i} className={`${i === parts.length - 1 ? "min-w-0 truncate" : "shrink-0"} ${tone ?? ""}`}>
            {text}
          </span>
        );
      })}
    </span>
  );
}

function statusLine(report: UsageReport | undefined, now: number): { parts: string[]; tone: string } | null {
  if (!report) return null;
  if (report.expired) return { parts: ["Session expired", "sign in again in Aliax"], tone: "text-warning" };
  if (report.rateLimit) {
    const until = report.rateLimit.until;
    const parts =
      until === undefined
        ? ["Usage rate limited"]
        : until <= now
          ? ["Usage rate limited", "retrying"]
          : ["Usage rate limited", `${untilLabel(until, now)} left`];
    return { parts, tone: "text-warning" };
  }
  return null;
}

const STATUS_TEXT: Record<string, string[]> = {
  canceled: ["canceled", "won't renew"],
  cancelled: ["canceled", "won't renew"],
  past_due: ["payment past due"],
  unpaid: ["payment failed"],
  incomplete: ["payment incomplete"],
  incomplete_expired: ["payment expired"],
  paused: ["paused"],
  trialing: ["trial"],
  lapsed: ["ended"],
};
const STATUS_OK = new Set(["active", "trialing"]);

const shortDate = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "Max 20x  $200/mo  renews Oct 3", the tail in amber when the plan is ending. */
function PlanLine({ plan, now }: { plan: PlanInfo; now: number }) {
  const parts: (string | { text: string; className: string })[] = [plan.name];
  if (plan.monthlyUsd !== undefined) parts.push(`$${plan.monthlyUsd}/mo`);
  const warn = (text: string) => ({ text, className: "text-warning" });
  if (plan.cancelsAt !== undefined) parts.push(warn("canceled"), warn(`ends ${shortDate(plan.cancelsAt)}`));
  else if (plan.status && !STATUS_OK.has(plan.status))
    parts.push(...(STATUS_TEXT[plan.status] ?? [plan.status.replace(/_/g, " ")]).map(warn));
  else if (plan.renewsAt !== undefined && plan.renewsAt > now) parts.push(`renews ${shortDate(plan.renewsAt)}`);
  return <Facts parts={parts} className="text-[11px] text-muted-foreground" />;
}

/** Group windows by the moment they refill, to the minute. */
export function groupWindows(windows: UsageWindow[]): UsageWindow[][] {
  const groups: UsageWindow[][] = [];
  for (const w of windows) {
    const key = w.resetsAt ? Math.round(w.resetsAt / 60_000) : null;
    const found =
      key === null
        ? undefined
        : groups.find((g) => g[0].resetsAt && Math.round(g[0].resetsAt / 60_000) === key);
    if (found) found.push(w);
    else groups.push([w]);
  }
  return groups;
}

function UsageBlock({ report, now, slots }: { report: UsageReport | undefined; now: number; slots: number }) {
  const style = {
    width: `${slots * CELL_REM + (slots - 1) * GUTTER_REM}rem`,
    gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))`,
  };
  if (!report) {
    return (
      <span className="flex shrink-0 items-center text-muted-foreground" style={style}>
        <Skeleton className="h-2 w-8" />
      </span>
    );
  }
  if (report.windows.length === 0) {
    return (
      <span className="flex shrink-0 items-center text-[11px] text-muted-foreground" style={style}>
        {report.rateLimit ? "No usage recorded yet" : (report.note ?? report.extra ?? "Usage unavailable")}
      </span>
    );
  }
  const groups = groupWindows(report.windows).slice(0, slots);
  return (
    <span className="grid shrink-0 gap-6" style={style}>
      {groups.map((g, i) => (
        // Fill from the right, so a single monthly cycle lines up with the weeklies.
        <span key={g[0].label} style={i === 0 ? { gridColumnStart: slots - groups.length + 1 } : undefined}>
          <UsageCell group={g} now={now} />
        </span>
      ))}
    </span>
  );
}

/**
 * One refill clock and every limit that shares it: a per-model cap that
 * resets with the weekly window stacks under it instead of repeating the
 * same countdown in a column of its own.
 */
function UsageCell({ group, now }: { group: UsageWindow[]; now: number }) {
  const head = group[0];
  const refills = head.resetsAt !== undefined && head.resetsAt > now;
  const period = head.periodMs ?? cycleMs(head.label);
  const pace = onPaceLeft(head, now);
  const cell = (
    <span className="flex flex-col gap-2" data-cell={head.label}>
      {group.map((w) => (
        <WindowLine key={w.label} w={w} now={now} />
      ))}
      <span className="flex h-3 items-center gap-1.5 text-[11px] text-muted-foreground">
        {refills ? (
          <>
            {period ? <CycleRing fraction={cycleFraction(head.resetsAt as number, period, now)} /> : null}
            {/* The countdown alone; the moment is the tooltip's, so the cell says the refill once. */}
            <span className="tabular-nums">in {untilLabel(head.resetsAt as number, now)}</span>
          </>
        ) : null}
      </span>
    </span>
  );
  if (!refills) return cell;
  return (
    <Tip
      label={
        <span className="flex flex-col gap-0.5">
          <span>Refills {resetLabel(head.resetsAt as number)}</span>
          {pace !== null ? <span>An even burn leaves {Math.round(pace)}% by now</span> : null}
        </span>
      }
    >
      {cell}
    </Tip>
  );
}

function WindowLine({ w, now }: { w: UsageWindow; now: number }) {
  const left = percentLeft(w);
  return (
    <span className="flex flex-col gap-1.5" data-window={w.label}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{w.label}</span>
        <span className={`text-[12px] font-medium tabular-nums ${toneFor(w, now)}`}>{formatPercent(left)}</span>
      </span>
      <Bar w={w} now={now} height="h-1.5" />
    </span>
  );
}

/** Whole numbers stay whole; a fractional report keeps one decimal so nothing is hidden. */
export const formatPercent = (n: number): string =>
  `${Number.isInteger(n) ? n : Math.round(n * 10) / 10}%`;

/** How far into the current cycle we are, 0 at refill and 1 just before the next. */
export const cycleFraction = (resetsAt: number, period: number, now: number): number =>
  Math.min(1, Math.max(0, 1 - (resetsAt - now) / period));

function CycleRing({ fraction }: { fraction: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="size-3.5 shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" className="stroke-foreground/15" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0.04, fraction))}
        className="stroke-foreground/70"
      />
    </svg>
  );
}

/** A fill of what is left, with a tick where an even burn would sit. */
export function Bar({ w, now, height }: { w: UsageWindow; now: number; height: string }) {
  const left = percentLeft(w);
  const budget = onPaceLeft(w, now);
  const ahead = budget !== null && left >= budget;
  return (
    <span
      role="progressbar"
      aria-valuenow={Math.round(left)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${w.label}: ${Math.round(left)} percent left`}
      className={`relative block w-full overflow-visible rounded-full bg-foreground/10 ${height}`}
    >
      <span
        className={`block h-full rounded-full ${fillFor(w, now)}`}
        style={{ width: `${left}%` }}
      />
      {budget !== null && budget > 2 && budget < 98 ? (
        <span
          aria-hidden
          data-tick
          className={`absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full ${ahead ? "bg-foreground/35" : "bg-foreground/70"}`}
          style={{ left: `calc(${budget}% - 1px)` }}
        />
      ) : null}
    </span>
  );
}
