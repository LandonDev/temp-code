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
  return (
    <div className="flex flex-col gap-1.5 p-2 pb-1">
      {update && onOpenWhatsNew && onDismissUpdate ? (
        <UpdateRailCard
          update={update}
          onOpen={onOpenWhatsNew}
          onDismiss={onDismissUpdate}
        />
      ) : null}
      <SidebarUpdate onOpenWhatsNew={onOpenWhatsNew} />
    </div>
  );
}

export function SidebarUpdate({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew?: (version: string, markdown?: string) => void;
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
    <div
      className={`flex flex-col rounded-lg ${
        hasUpdate ? "bg-accent/15 text-content" : "bg-content/5 text-content/70"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
          hasUpdate ? "hover:bg-accent/20" : "hover:bg-content/10 hover:text-content"
        } disabled:cursor-default disabled:opacity-70`}
      >
        <span className="grid size-[18px] shrink-0 place-items-center">
          {busy ? (
            <Loader className="size-4 motion-safe:animate-spin opacity-70" aria-hidden />
          ) : hasUpdate ? (
            <ArrowDownCircle className="size-4 text-accent" aria-hidden />
          ) : (
            <RefreshCw
              className="size-4 opacity-70"
              strokeWidth={1.75}
              aria-hidden
            />
          )}
        </span>
        <span className="min-w-0 flex-1 flex items-center">
          <span className="block truncate text-[12px] font-medium leading-tight">
            {label}
          </span>
          <span className="ml-auto block text-[11px] text-content/40">
            v{snapshot.currentVersion}
          </span>
        </span>
      </button>
      {showNotes ? (
        <button
          type="button"
          onClick={() =>
            onOpenWhatsNew?.(snapshot.availableVersion!, snapshot.notes)
          }
          className="-mt-1 rounded-b-lg px-2 pb-1.5 pl-[34px] text-left text-[11px] text-content/50 transition-colors hover:text-content"
        >
          What's new
        </button>
      ) : null}
    </div>
  );
}
