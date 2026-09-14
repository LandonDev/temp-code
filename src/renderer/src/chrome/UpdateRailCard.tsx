import { X } from "./icons";
import type { InstalledUpdate } from "../lib/updateNotice";

type Props = {
  update: InstalledUpdate | null;
  onOpen: (version: string) => void;
  onDismiss: () => void;
};

/** One rail row after an update lands: the version, a "What's new" hint
 *  in the shortcut slot, and a dismiss control. */
export function UpdateRailCard({ update, onOpen, onDismiss }: Props) {
  if (!update) return null;

  return (
    <section role="status" className="relative">
      <button
        type="button"
        onClick={() => onOpen(update.version)}
        className="pressable flex h-7 w-full items-center gap-2 rounded-md px-2 pr-8 text-left text-content/50 hover:bg-content/5 hover:text-content"
      >
        <img
          src={`${import.meta.env.BASE_URL}monocode.png`}
          alt=""
          aria-hidden
          className="size-3.5 shrink-0 object-contain"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-none text-content">
          Updated to {update.version}
        </span>
        <span aria-hidden className="shrink-0 text-[11px] text-content/40">
          What's new
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={onDismiss}
        className="pressable absolute right-0.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content"
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </section>
  );
}
