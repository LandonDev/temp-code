import { useRef, useState } from "react";
import { ChevronDown, Pin, Users } from "./icons";
import { AccountsPopover } from "./AccountsPopover";
import { useNow } from "../lib/accounts";
import { controlLabel, scopeOf, sourceLine, type ScopeMeta } from "../lib/accountScope";
import { useProjects, useWorkspaces } from "../lib/tcserver/workspaces";
import { useAccounts } from "../stores/accounts";
import { isRoutedProvider } from "@server/shared/accounts";

/**
 * The composer's account: which Aliax account this thread spends from. A
 * thread is always auto (its project's or workspace's pin, else the best
 * account for its model), so this only reads: the account in use, and on
 * click the same account list the footer shows, with a check on that
 * account. Nothing renders for a provider without a gateway or a machine
 * without saved accounts.
 */
export function AccountControl({
  meta,
  onClose,
}: {
  /** The thread whose account this is. */
  meta: ScopeMeta | null;
  onClose?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { snapshot } = useAccounts();
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const now = useNow();
  const scope = scopeOf(meta, projects, workspaces);
  if (!scope || !meta || !isRoutedProvider(meta.provider)) return null;
  const accounts = snapshot.providers[scope.provider];
  if (accounts.profiles.length === 0) return null;
  const label = controlLabel(scope, accounts);
  const title = label ? `${sourceLine(scope)} · ${label}` : sourceLine(scope);
  const Icon = scope.inherited ? Pin : Users;

  const dismiss = (refocus: boolean) => {
    setOpen(false);
    if (refocus) onClose?.();
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={title}
        aria-label={`Account: ${label ?? "unknown"}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-account-picker
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? dismiss(true) : setOpen(true))}
        className={`flex h-6.5 max-w-40 items-center gap-1 rounded-md px-1.5 ${
          open ? "bg-content/10 text-content" : "bg-content/10 text-content hover:bg-content/15"
        }`}
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className={`min-w-0 truncate text-[11px] ${label ? "" : "text-content/50"}`}>{label ?? "Account"}</span>
        <ChevronDown
          className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <AccountsPopover
          anchor={root}
          provider={scope.provider}
          accounts={accounts}
          scope={scope}
          now={now}
          onDismiss={() => dismiss(true)}
        />
      ) : null}
    </div>
  );
}
