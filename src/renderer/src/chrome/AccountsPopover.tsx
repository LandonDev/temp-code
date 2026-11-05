import { cloneElement, type ReactElement, type SyntheticEvent } from "react";
import type { AccountProvider, ProviderAccounts } from "@server/shared/accounts";
import type { AccountScope } from "../lib/accountScope";
import { accountsChunk } from "../surfaces/chunks";
import { LoadingLine } from "../surfaces/SurfaceSkeleton";
import { LazyPopover } from "./menuRows";

// The list itself (chrome/AccountsList.tsx) rides its own chunk.
const AccountsList = accountsChunk.surface("AccountsList", <LoadingLine label="Loading accounts" />);

type Handler = ((event: SyntheticEvent) => void) | undefined;

/** The trigger, warming the list's chunk on hover or focus as well as doing its own. */
function warming(trigger: ReactElement): ReactElement {
  const own = trigger.props as { onPointerEnter?: Handler; onFocus?: Handler };
  return cloneElement(trigger as ReactElement<Record<string, Handler>>, {
    onPointerEnter: (event: SyntheticEvent) => {
      own.onPointerEnter?.(event);
      accountsChunk.preload();
    },
    onFocus: (event: SyntheticEvent) => {
      own.onFocus?.(event);
      accountsChunk.preload();
    },
  });
}

/**
 * Every saved account of one provider (AccountsList), floating from its
 * trigger (the failure card's Pick another account).
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
  return (
    <LazyPopover
      trigger={warming(trigger)}
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="start"
      label={`${provider} accounts`}
      className="max-h-(--available-height) w-auto max-w-(--available-width) gap-0 overflow-x-hidden overflow-y-auto p-1 [--scrollbar-inset:var(--radius-xl)]"
    >
      <AccountsList provider={provider} accounts={accounts} scope={scope} now={now} />
    </LazyPopover>
  );
}
