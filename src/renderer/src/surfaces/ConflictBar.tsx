import { Kbd } from "../components/ui/kbd";
import { MOD } from "../lib/platform";
import { EditorAlert } from "./FileNoteBar";

/** ⌘S keeps mine while the bar shows; the tooltip says so. */
const SAVE_KEYS = <Kbd size="sm">{`${MOD}S`}</Kbd>;

/**
 * The line above a buffer whose file changed on disk under unsaved edits
 * to the same lines (lib/diskRace.ts), or was deleted. Nothing is written
 * until the person chooses, so it interrupts: `alert`, warning.
 */
export function ConflictBar({
  kind,
  onReload,
  onKeep,
}: {
  kind: "external" | "deleted";
  onReload: () => void;
  onKeep: () => void;
}) {
  return kind === "external" ? (
    <EditorAlert
      tone="warning"
      role="alert"
      text="Changed on disk where you were editing"
      actions={[
        { label: "Reload", onClick: onReload },
        { label: "Keep mine", onClick: onKeep, tooltip: SAVE_KEYS },
      ]}
    />
  ) : (
    <EditorAlert tone="warning" role="alert" text="Deleted on disk" actions={[{ label: "Restore", onClick: onKeep, tooltip: SAVE_KEYS }]} />
  );
}
