import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { IS_MAC } from "../lib/platform";
import { isWebMode } from "../lib/native";
import { DESKTOP_ONLY_LINE } from "../lib/nativeWeb";
import { Empty, EmptyTitle } from "../components/ui/empty";
import { PAGE_SCROLLER } from "../components/page";
import { cn } from "../lib/cn";
import type { AliaxPageId } from "../stores/shell";
import { AccountsPage, StatsPage } from "@aliax/pages";

type Props = {
  page: AliaxPageId;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

const LABELS: Record<AliaxPageId, string> = { accounts: "Accounts", stats: "Stats" };

/**
 * The Accounts and Stats pages behind the rail's Accounts section: a bare
 * strip (drag region, back, window controls) and the page under it, which
 * carries its own title as Settings does.
 */
export function AliaxPagesView({ page, besideRail = false, onClose, onToggleSidebar }: Props) {
  const label = LABELS[page];
  return (
    <div
      role="region"
      aria-label={label}
      data-app-aliax={page}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-border"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="min-w-0 flex-1" />
        {IS_MAC ? null : <WindowControls />}
      </div>
      {/* Keyed by the page, so Stats opens at its top; the stable gutter keeps
          the column still when a page gains a scrollbar. */}
      <div key={page} className={cn(PAGE_SCROLLER, "flex flex-col")}>
        {isWebMode() ? (
          <Empty>
            <EmptyTitle>{DESKTOP_ONLY_LINE}</EmptyTitle>
          </Empty>
        ) : page === "accounts" ? (
          <AccountsPage />
        ) : (
          <StatsPage />
        )}
      </div>
    </div>
  );
}
