import { useState } from "react";
import { CheckRow } from "../../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal, useModalClose } from "../../../chrome/Modal";
import { archiveCopy, type ArchiveWhich } from "./boardActions";

type Props = {
  which: ArchiveWhich;
  count: number;
  resources: number | null;
  onCancel: () => void;
  onConfirm: (removeResources: boolean) => Promise<void>;
};

/**
 * "Archive 3 done threads?" / "Archive all 7 threads?" with the live
 * count, and the resources checkbox the fleet's Archive done offers when
 * the host counts worktrees or simulators the threads hold. Confirm is
 * `batch.archive`; the rows leave the board from the sessions push.
 */
export function ArchiveBatchDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const copy = archiveCopy(props.which, props.count, props.resources);
  return (
    <Modal onClose={props.onCancel} busy={pending} title={copy.title} size="sm">
      <Body {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Body({ which, count, resources, onCancel, onConfirm, pending, setPending }: Props & { pending: boolean; setPending: (on: boolean) => void }) {
  const copy = archiveCopy(which, count, resources);
  const close = useModalClose();
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm(!!copy.cleanup && cleanup);
      setPending(false);
      if (close) close(onCancel);
      else onCancel();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-4 px-4 py-4" data-archive-batch={which}>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        {copy.cleanup ? (
          <CheckRow label={copy.cleanup} checked={cleanup} onCheckedChange={setCleanup} />
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onCancel} onConfirm={() => void confirm()} confirmLabel={copy.confirmLabel} pending={pending} disabled={count === 0} />
    </>
  );
}
