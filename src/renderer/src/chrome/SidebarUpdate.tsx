import { ArrowDownCircle, Loader, RefreshCw } from "./icons";
import { installing, updateStore, useUpdateSnapshot } from "../lib/updateStore";
import type { InstalledUpdate } from "../lib/updateNotice";
import { UpdateRailCard } from "./UpdateRailCard";

export function SidebarUpdateFooter({
  update,
  onOpenWhatsNew,
  onDismissUpdate,
}: {
  update?: InstalledUpdate | null;
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
  onDismissUpdate?: () => void;
}) {
  const card = !!update && !!onOpenWhatsNew && !!onDismissUpdate;
  return (
    <div className="flex flex-col gap-px px-2">
      {card ? (
        <UpdateRailCard
          update={update}
          onOpen={onOpenWhatsNew}
          onDismiss={onDismissUpdate}
        />
      ) : null}
      {/* The card above already names the running version. */}
      <SidebarUpdate onOpenWhatsNew={onOpenWhatsNew} showVersion={!card} />
    </div>
  );
}

export function SidebarUpdate({
  onOpenWhatsNew,
  showVersion = true,
}: {
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
  showVersion?: boolean;
}) {
  const snapshot = useUpdateSnapshot();

  const busy = snapshot.phase === "checking" || installing(snapshot);
  const hasUpdate = snapshot.phase === "available";
  const label = hasUpdate
    ? `Update to ${snapshot.availableVersion}`
    : snapshot.phase === "building"
      ? `Updating${snapshot.step ? ` · ${snapshot.step}` : "…"}`
      : snapshot.phase === "restarting"
        ? "Restarting…"
        : busy
          ? "Checking…"
          : "Check for updates";

  const onClick = () => {
    if (busy) return;
    void (hasUpdate ? updateStore.install() : updateStore.check(true));
  };

  const showNotes =
    hasUpdate && !!snapshot.notes && !!onOpenWhatsNew && !!snapshot.availableVersion;

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={`pressable flex h-7 w-full items-center gap-2 rounded-md px-2 text-left ${
          hasUpdate
            ? "bg-accent/10 text-content hover:bg-accent/15"
            : "text-content/50 hover:bg-content/5 hover:text-content"
        } disabled:cursor-default disabled:opacity-70`}
      >
        {busy ? (
          <Loader className="size-3.5 shrink-0 motion-safe:animate-spin" strokeWidth={1.75} aria-hidden />
        ) : hasUpdate ? (
          <ArrowDownCircle className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
        ) : (
          <RefreshCw className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] leading-none">{label}</span>
        {showVersion ? (
          <span className="shrink-0 text-[11px] tabular-nums text-content/40">
            v{snapshot.currentVersion}
          </span>
        ) : null}
      </button>
      {showNotes ? (
        <button
          type="button"
          onClick={() => onOpenWhatsNew?.(snapshot.availableVersion!, snapshot.notes)}
          className="pressable flex h-6 w-full items-center rounded-md pr-2 text-left text-[11px] text-content/50 hover:bg-content/5 hover:text-content"
          style={{ paddingLeft: 8 + 12 }}
        >
          What's new
        </button>
      ) : null}
    </>
  );
}
