import type { ProfileView, UsageReport } from "aliax-core/shared/types";
import { Check, Pin } from "./icons";
import { displayName } from "../aliax/lib/accounts";
import { limitOf, rowLine } from "../aliax/views/accounts/rowLine";
import { barColumns, planFacts, RowFacts, UsageBars, type BarColumns } from "../aliax/views/accounts/usage";
import { sourceLine, type AccountScope } from "../lib/accountScope";
import type { AccountHeadroom, AccountProvider, MintState, ProviderAccounts } from "@server/shared/accounts";

/** A usage column is 8.5rem with 0.75rem between two (the Accounts page's table); the name column takes 13rem. */
const CELL_REM = 8.5;
const GAP_REM = 0.75;
const NAME_REM = 13;

/** The width the bars take: every column the list reserves, as UsageBars lays them out. */
const barsRem = (columns: BarColumns): number => {
  const n = Math.max(1, columns.windows) + (columns.rate ? 1 : 0);
  return n * CELL_REM + (n - 1) * GAP_REM;
};

/**
 * Every saved account of one provider, in Aliax's own row order, each said
 * as the Accounts page says it: the page's state line and plan facts under
 * the name (RowFacts) and its usage columns (UsageBars), read-only. A
 * thread is always auto, and adding, editing, pinning or removing accounts
 * stays on the page.
 *
 * With a thread in scope a line says where its account comes from, a check
 * marks the account it spends from and a pin marks its project's or
 * workspace's pin. Without a scope (Cursor, or no thread) the check is
 * Aliax's global pin. The body of AccountsPopover, in its own chunk
 * (`accountsChunk`): it loads with the popover's first open, or the
 * trigger's hover, never in the first paint.
 */
export function AccountsList({
  provider,
  accounts,
  scope,
  now,
}: {
  provider: AccountProvider;
  accounts: ProviderAccounts;
  /** The thread the list describes; null shows the global pin. */
  scope: AccountScope | null;
  now: number;
}) {
  const reportOf = (name: string) => accounts.reports.find((r) => r.profileName === name);
  // Every row reserves the same columns so bars line up down the list.
  const columns = barColumns(accounts.profiles.map((p) => ({ report: reportOf(p.name), headroom: accounts.headroom?.[p.name] })));
  const bars = barsRem(columns);
  // The rows' 12px insets either side, the name column, 24px to the bars, the bars.
  const width = 1.5 + NAME_REM + 1.5 + bars;
  const checked = scope ? scope.shown : accounts.pinned;

  return (
    <div role="listbox" aria-label={`${provider} accounts`} aria-readonly data-account-picker style={{ width: `${width}rem` }}>
      {scope ? <p className="px-3 py-1 text-xs text-muted-foreground">{sourceLine(scope)}</p> : null}
      {accounts.profiles.map((profile) => (
        <AccountRow
          key={profile.name}
          profile={profile}
          report={reportOf(profile.name)}
          headroom={accounts.headroom?.[profile.name]}
          mint={provider === "claude" ? accounts.mint?.rows[profile.name] : undefined}
          checked={profile.name === checked}
          inherited={scope && profile.name === scope.inherited?.name ? scope.inherited.level : null}
          now={now}
          columns={columns}
          barsWidth={bars}
        />
      ))}
      {accounts.note ? <p className="px-3 pb-1 pt-2 text-xs text-muted-foreground">{accounts.note}</p> : null}
    </div>
  );
}

function AccountRow({
  profile,
  report,
  headroom,
  mint,
  checked,
  inherited,
  now,
  columns,
  barsWidth,
}: {
  profile: ProfileView;
  report: UsageReport | undefined;
  /** What the gateways have seen of the account's per-request limits; absent until the host keeps a picture. */
  headroom: AccountHeadroom | undefined;
  /** A one-year token being made or waiting on a sign-in (Claude). */
  mint: MintState | undefined;
  /** The account the thread spends from (or the global pin without a thread). */
  checked: boolean;
  /** The project or workspace pin that applies to the thread. */
  inherited: "project" | "workspace" | null;
  now: number;
  columns: BarColumns;
  barsWidth: number;
}) {
  const name = displayName(profile);
  // The host that refreshes it is the page's to say; here only what limits a pick.
  const line = rowLine(profile, report, null, mint, now, limitOf(report, headroom, now));
  const plan = planFacts(report?.plan, report?.banked);
  return (
    <div role="option" aria-selected={checked} aria-disabled className="flex w-full items-start gap-6 rounded-lg px-3 py-2 text-left">
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${profile.color ? "" : "bg-foreground/30"}`}
          style={profile.color ? { background: profile.color } : undefined}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 items-center gap-1 text-[13px] text-foreground">
            <span className={`truncate ${checked ? "font-medium" : ""}`}>{name}</span>
            {checked ? <Check className="size-3 shrink-0 text-muted-foreground" aria-label="In use" /> : null}
            {inherited ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label={`Pinned by the ${inherited}`} /> : null}
          </span>
          {line || plan.name || plan.detail.length ? (
            <span data-slot="account-facts" className="flex min-w-0 flex-col text-xs leading-4 text-muted-foreground">
              <RowFacts line={line} plan={plan} now={now} />
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0" style={{ width: `${barsWidth}rem` }}>
        <UsageBars name={name} report={report} headroom={headroom} columns={columns} now={now} keyed={profile.kind === "key"} readOnly className="w-full" />
      </span>
    </div>
  );
}
