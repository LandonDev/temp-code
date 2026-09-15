import { RefreshCw } from "./icons";
import { useRef, useState } from "react";
import type { UsageWindow } from "aliax-core/shared/types";
import { AccountsPopover, Bar } from "./AccountsPopover";
import { HarnessIcon } from "./HarnessIcon";
import { Popover } from "./Popover";
import {
  displayName,
  othersWithRoom,
  percentLeft,
  reportOf,
  resetPoint,
  toneFor,
  untilLabel,
  useNow,
  windowLabel,
} from "../lib/accounts";
import { HARNESS_LABEL, HARNESS_TITLE, type HarnessId } from "../lib/session";
import {
  runningTerminalChipLabel,
  type RunningTerminal,
} from "../lib/terminalTab";
import { accountsStore, useAccounts } from "../stores/accounts";
import { isAccountProvider, type AccountProvider, type ProviderAccounts } from "@server/shared/accounts";

export function UsageFooter({
  harness,
  terminals = [],
  terminalOpen = false,
  onToggleTerminal,
}: {
  /** The active thread's harness; accounts show for claude, codex and cursor. */
  harness?: HarnessId;
  terminals?: RunningTerminal[];
  terminalOpen?: boolean;
  onToggleTerminal?: (fileId: string) => void;
}) {
  const { snapshot, loaded, busy } = useAccounts();
  const now = useNow();
  const provider = harness && isAccountProvider(harness) ? harness : null;
  const accounts = provider ? snapshot.providers[provider] : null;
  const showTerminals = terminals.length > 0;
  const showRight = provider !== null || showTerminals;

  return (
    <footer
      aria-label={provider ? "Provider usage" : showTerminals ? "Terminals" : harness ? "Session" : undefined}
      className="flex h-10 shrink-0 items-center gap-4 overflow-x-auto border-t border-content/10 px-3 text-[11px] text-content/50"
    >
      {provider && accounts ? (
        <AccountCells
          provider={provider}
          accounts={accounts}
          loaded={loaded}
          busy={busy === provider}
          now={now}
        />
      ) : harness ? (
        <SessionChip harness={harness} />
      ) : null}
      {showRight ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showTerminals ? (
            <RunningTerminalChip
              terminals={terminals}
              open={terminalOpen}
              onToggle={onToggleTerminal}
            />
          ) : null}
          {provider ? (
            <button
              type="button"
              className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-40"
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={busy !== null}
              onClick={() => void accountsStore.refresh(provider)}
            >
              <RefreshCw
                className={`size-3.5 ${busy === provider ? "motion-safe:animate-spin" : ""}`}
                strokeWidth={1.75}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

/**
 * The pinned account and one cell per usage window. The name opens the
 * account list for Claude and Codex; Cursor has no switch, so it stays text.
 */
function AccountCells({
  provider,
  accounts,
  loaded,
  busy,
  now,
}: {
  provider: AccountProvider;
  accounts: ProviderAccounts;
  loaded: boolean;
  busy: boolean;
  now: number;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pinned = accounts.profiles.find((p) => p.name === accounts.pinned) ?? null;
  const report = reportOf(accounts.reports, accounts.pinned);
  const switchable = provider !== "cursor" && accounts.profiles.length > 0;
  const name = pinned ? displayName(pinned) : null;
  const nameClass = "inline-flex h-6 min-w-0 max-w-[14rem] items-center gap-1.5 whitespace-nowrap rounded-md px-1 -mx-1";

  return (
    <>
      {switchable ? (
        <button
          ref={anchor}
          type="button"
          className={`pressable ${nameClass} hover:bg-content/5 hover:text-content`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={HARNESS_TITLE[provider]}
          onClick={() => setOpen((v) => !v)}
        >
          <HarnessIcon harness={provider} className="size-3.5 shrink-0" />
          <span className="truncate text-content/70">{name ?? "no account"}</span>
        </button>
      ) : (
        <span className={nameClass} title={HARNESS_TITLE[provider]}>
          <HarnessIcon harness={provider} className="size-3.5 shrink-0" />
          <span className="truncate text-content/70">{name ?? HARNESS_LABEL[provider]}</span>
        </span>
      )}
      {!loaded ? (
        <span className="motion-safe:animate-pulse text-content/40">···</span>
      ) : report?.expired ? (
        <span className="text-content/40">sign in again in Aliax</span>
      ) : report ? (
        report.windows.map((w) => (
          <WindowCell
            key={w.label}
            w={w}
            now={now}
            others={othersWithRoom(accounts.reports, accounts.pinned, w.label)}
          />
        ))
      ) : (
        <span className="text-content/40" title={accounts.note}>
          {accounts.note ?? "—"}
        </span>
      )}
      {open && switchable ? (
        <AccountsPopover
          anchor={anchor}
          provider={provider}
          accounts={accounts}
          busy={busy}
          now={now}
          onSwitch={(p, n) => {
            void accountsStore.switch(p, n).then((r) => {
              if (r.ok) setOpen(false);
            });
          }}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function WindowCell({ w, now, others }: { w: UsageWindow; now: number; others: number }) {
  const left = Math.round(percentLeft(w));
  const sub = [
    w.resetsAt ? `resets in ${untilLabel(w.resetsAt, now)}` : null,
    others > 0 ? `${others} more with room` : null,
  ].filter(Boolean).join(" · ");
  return (
    <span
      data-window={w.label}
      className="flex min-w-[7rem] shrink-0 flex-col gap-1 whitespace-nowrap"
      title={w.resetsAt ? `${w.label} refills ${resetPoint(w.resetsAt, now)}` : w.label}
    >
      <span className="flex items-baseline justify-between leading-none">
        <span>{windowLabel(w.label)}</span>
        <span className={`tabular-nums ${toneFor(w, now)}`}>{left}%</span>
      </span>
      <Bar w={w} now={now} height="h-1.5" />
      {sub ? <span className="text-[10px] leading-none text-content/40">{sub}</span> : null}
    </span>
  );
}

function TerminalLiveMark() {
  return (
    <span className="terminal-live shrink-0" aria-hidden>
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
      <span className="terminal-live-bar" />
    </span>
  );
}

function SessionChip({ harness }: { harness: HarnessId }) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap"
      title={HARNESS_TITLE[harness]}
    >
      <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
      <span>{HARNESS_LABEL[harness]}</span>
    </span>
  );
}
function RunningTerminalChip({
  terminals,
  open: panelOpen,
  onToggle,
}: {
  terminals: RunningTerminal[];
  open: boolean;
  onToggle?: (fileId: string) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const label = runningTerminalChipLabel(terminals);
  const many = terminals.length > 1;
  const title = terminals
    .map((terminal) => `"${terminal.process}" in ${terminal.label}`)
    .join("\n");
  const ariaLabel =
    terminals.length === 1
      ? panelOpen
        ? `Hide ${terminals[0]?.process}`
        : `Show ${terminals[0]?.process}`
      : panelOpen
        ? "Hide running terminals"
        : `${terminals.length} terminals are running processes`;

  const toggle = (fileId: string) => {
    setMenuOpen(false);
    onToggle?.(fileId);
  };

  return (
    <>
      <button
        ref={root}
        type="button"
        className="pressable inline-flex h-6 min-w-0 max-w-[16rem] items-center gap-1.5 whitespace-nowrap rounded-md px-1 -mx-1 hover:bg-content/5 hover:text-content"
        aria-label={ariaLabel}
        aria-pressed={panelOpen}
        aria-expanded={many && !panelOpen ? menuOpen : undefined}
        aria-haspopup={many && !panelOpen ? "menu" : undefined}
        title={title}
        onClick={() => {
          if (panelOpen || !many) {
            const target = terminals[0];
            if (target) toggle(target.id);
            return;
          }
          setMenuOpen((value) => !value);
        }}
      >
        <TerminalLiveMark />
        <span className="truncate font-mono text-[11px] tabular-nums">
          {label}
        </span>
      </button>
      {menuOpen && many && !panelOpen ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          autoFocus
          onDismiss={() => setMenuOpen(false)}
          role="menu"
          aria-label="Running terminals"
          className="min-w-[12rem] p-1"
        >
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              role="menuitem"
              className="flex h-7 w-full items-center gap-3 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5 active:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(terminal.id)}
            >
              <span className="min-w-0 flex-1 truncate">{terminal.process}</span>
              <span className="max-w-[7rem] shrink-0 truncate text-[11px] text-content/40">
                {terminal.label}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
