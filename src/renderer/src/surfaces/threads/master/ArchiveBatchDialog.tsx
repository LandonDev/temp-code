import { useState } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal } from "../../../chrome/Modal";
import { archiveCopy, type ArchiveWhich } from "./boardActions";

/**
 * "Archive 3 done threads?" / "Archive all 7 threads?" with the live
 * count, and the resources checkbox the fleet's Archive done offers when
 * the host counts worktrees or simulators the threads hold. Confirm is
 * `batch.archive`; the rows leave the board from the sessions push.
 */
export function ArchiveBatchDialog({
  which,
  count,
  resources,
  onCancel,
  onConfirm,
}: {
  which: ArchiveWhich;
  count: number;
  resources: number | null;
  onCancel: () => void;
  onConfirm: (removeResources: boolean) => Promise<void>;
}) {
  const copy = archiveCopy(which, count, resources);
  const [cleanup, setCleanup] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm(!!copy.cleanup && cleanup);
      onCancel();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <Modal onClose={onCancel} busy={pending} title={copy.title} size="sm">
      <div className="flex flex-col gap-2 px-4 py-3" data-archive-batch={which}>
        <p className="text-[12px] leading-snug text-content/50">{copy.body}</p>
        {copy.cleanup ? (
          <label className="flex items-center gap-2 text-[12px] text-content/70">
            <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} />
            <span className="min-w-0 truncate">{copy.cleanup}</span>
          </label>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onCancel} onConfirm={() => void confirm()} confirmLabel={copy.confirmLabel} pending={pending} disabled={count === 0} />
    </Modal>
  );
}
