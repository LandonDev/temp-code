import { ChartBar, Users } from "../chrome/icons";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { IS_MAC } from "../lib/platform";
import type { AliaxPageId } from "../stores/shell";
import { AccountsPage, StatsPage } from "@aliax/pages";

type Props = {
  page: AliaxPageId;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

const TITLES: Record<AliaxPageId, { label: string; icon: typeof Users }> = {
  accounts: { label: "Accounts", icon: Users },
  stats: { label: "Stats", icon: ChartBar },
};

/**
 * The embedded Aliax pages behind the rail's Accounts section: the same
 * header strip Notes uses, then Aliax's own page (src/renderer/src/aliax)
 * filling the rest. The page keeps Aliax's look; only the strip is ours.
 */
export function AliaxPagesView({ page, besideRail = false, onClose, onToggleSidebar }: Props) {
  const { label, icon: Icon } = TITLES[page];
  return (
    <div
      role="region"
      aria-label={label}
      data-app-aliax={page}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-content/10"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Icon className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">{label}</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {page === "accounts" ? <AccountsPage /> : <StatsPage />}
      </div>
    </div>
  );
}
