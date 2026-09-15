import type { RefObject } from "react";
import type { ProfileView, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { Check, Loader } from "./icons";
import { Popover } from "./Popover";
import {
  displayName,
  fillFor,
  onPaceLeft,
  percentLeft,
  reportOf,
  untilLabel,
  windowLabel,
} from "../lib/accounts";
import type { AccountProvider, ProviderAccounts } from "@server/shared/accounts";

/**
 * Every saved account of one provider, in Aliax's own row order. Clicking a
 * row that is not the pinned one switches to it; nothing here adds, edits or
 * removes an account — that stays in Aliax.
 */
export function AccountsPopover({
  anchor,
  provider,
  accounts,
  busy,
  now,
  onSwitch,
  onDismiss,
}: {
  anchor: RefObject<HTMLElement | null>;
  provider: AccountProvider;
  accounts: ProviderAccounts;
  busy: boolean;
  now: number;
  onSwitch: (provider: AccountProvider, name: string) => void;
  onDismiss: () => void;
}) {
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      width={416}
      autoFocus
      onDismiss={onDismiss}
      role="listbox"
      aria-label={`${provider} accounts`}
      className="p-1"
    >
      {accounts.profiles.map((profile) => (
        <AccountRow
          key={profile.name}
          profile={profile}
          report={reportOf(accounts.reports, profile.name)}
          pinned={profile.name === accounts.pinned}
          busy={busy}
          now={now}
          onPick={() => onSwitch(provider, profile.name)}
        />
      ))}
      {accounts.note ? (
        <p className="px-2 pb-1 pt-1.5 text-[11px] text-content/50">{accounts.note}</p>
      ) : null}
    </Popover>
  );
}

function AccountRow({
  profile,
  report,
  pinned,
  busy,
  now,
  onPick,
}: {
  profile: ProfileView;
  report: UsageReport | undefined;
  pinned: boolean;
  busy: boolean;
  now: number;
  onPick: () => void;
}) {
  const sub = subline(report, now);
  return (
    <button
      type="button"
      role="option"
      aria-selected={pinned}
      disabled={pinned || busy}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[12px] leading-none text-content hover:bg-content/5 active:bg-content/10 disabled:hover:bg-transparent"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${profile.color ? "" : "bg-content/30"}`}
        style={profile.color ? { background: profile.color } : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{displayName(profile)}</span>
          {pinned ? (
            busy ? (
              <Loader className="size-3 shrink-0 motion-safe:animate-spin text-content/50" aria-label="Switching" />
            ) : (
              <Check className="size-3 shrink-0 text-content/50" aria-label="Active" />
            )
          ) : null}
        </span>
        {sub ? <span className="text-[11px] text-content/50">{sub}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {(report?.windows ?? []).map((w) => (
          <MiniBar key={w.label} w={w} now={now} />
        ))}
      </span>
    </button>
  );
}

function subline(report: UsageReport | undefined, now: number): string | null {
  if (!report) return null;
  if (report.expired) return "sign in again in Aliax";
  if (report.rateLimit) {
    const until = report.rateLimit.until;
    return until ? `rate limited · ${untilLabel(until, now)} left` : "rate limited";
  }
  return null;
}

function MiniBar({ w, now }: { w: UsageWindow; now: number }) {
  const left = percentLeft(w);
  return (
    <span
      className="flex w-12 flex-col gap-0.5"
      title={`${w.label}: ${Math.round(left)}% left`}
    >
      <span className="text-[9px] leading-none text-content/40">{windowLabel(w.label)}</span>
      <Bar w={w} now={now} height="h-1" />
    </span>
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
      className={`relative block w-full overflow-visible rounded-full bg-content/10 ${height}`}
    >
      <span
        className={`block h-full rounded-full ${fillFor(w, now)}`}
        style={{ width: `${left}%` }}
      />
      {budget !== null && budget > 2 && budget < 98 ? (
        <span
          aria-hidden
          data-tick
          className={`absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full ${ahead ? "bg-content/35" : "bg-content/70"}`}
          style={{ left: `calc(${budget}% - 1px)` }}
        />
      ) : null}
    </span>
  );
}
