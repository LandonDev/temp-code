import { useState, type JSX } from "react";
import { CheckRow } from "./DialogField";
import { DialogFooter } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { useSessionMetas } from "../lib/tcserver/store";
import {
  batchConfirm,
  batchTargets,
  cancelThreadBatch,
  confirmThreadBatch,
  isQueued,
  resourcesHeldBy,
  useBatchPending,
  type BatchRequest,
} from "../lib/threadBatch";
import { useBatchSelection } from "../lib/threadBatchSelection";

/**
 * The confirm behind Pause all, Stop all and Archive done: "Pause 15
 * running threads on the box?", the count read from the store as it
 * shows. OK closes at once; the toast reports when the batch lands.
 */
export function ThreadBatchDialog(): JSX.Element | null {
  const pending = useBatchPending();
  if (!pending) return null;
  return <Confirm key={`${pending.action}:${JSON.stringify(pending.scope)}`} request={pending} />;
}

function Confirm({ request }: { request: BatchRequest }): JSX.Element {
  const sel = useBatchSelection(request.scope);
  const metas = useSessionMetas();
  const targets = batchTargets(request.action, metas, sel);
  const ids = targets.map((t) => t.id);
  const resources = request.action === "archiveDone" ? resourcesHeldBy(ids) : null;
  const queued = targets.filter(isQueued).length;
  const copy = batchConfirm(request.action, targets.length, request.scope, resources, queued);
  const [cleanup, setCleanup] = useState(true);
  const confirm = () => {
    void confirmThreadBatch(sel, copy.cleanup && cleanup ? { cleanup: true } : {});
  };
  return (
    <Modal onClose={cancelThreadBatch} title={copy.title} size="sm">
      <div className="flex flex-col gap-4 px-5 py-4" data-batch-confirm={request.action}>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
        {copy.cleanup ? (
          <CheckRow label={copy.cleanup} checked={cleanup} onCheckedChange={setCleanup} />
        ) : null}
      </div>
      <DialogFooter
        onCancel={cancelThreadBatch}
        onConfirm={confirm}
        confirmLabel={copy.confirmLabel}
        danger={copy.danger}
        disabled={targets.length === 0}
      />
    </Modal>
  );
}
