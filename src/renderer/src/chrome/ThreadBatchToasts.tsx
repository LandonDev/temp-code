import { dismissBatchNotice, useBatchNotices, type BatchNotice } from "../lib/threadBatch";
import { useToastSync } from "./toastSync";

const NOTICE_MS = 8_000;

type Props = {
  /** Opens the thread a failure names. */
  onOpen: (sessionId: string, environmentId: string) => void;
};

const VERB: Record<BatchNotice["action"], string> = { pause: "Paused", resume: "Resumed", stop: "Stopped", archiveDone: "Archived" };

/** One sonner toast per batch: "Paused 14", and under a failure "1 failed:
 *  Search (harness not responding)" with Open for that thread. A clean
 *  result leaves on its own; one with a failure waits to be read. */
export function ThreadBatchToasts({ onOpen }: Props): null {
  useToastSync(
    useBatchNotices(),
    (notice) => `batch:${notice.key}`,
    (toast, notice, id) => {
      const [first, ...rest] = notice.failed;
      const title = `${VERB[notice.action]} ${notice.succeeded}`;
      const done = () => dismissBatchNotice(notice.key);
      if (!first) {
        toast(title, { id, duration: NOTICE_MS, onDismiss: done, onAutoClose: done });
        return;
      }
      // Every failed thread stays reachable: the lead toast names the first,
      // each remaining failure is its own toast under it with its error and
      // Open; dismissing the lead takes the rest with it.
      const restIds = rest.map((f) => `${id}:${f.sessionId}`);
      toast.error(title, {
        id,
        description: `${notice.failed.length} failed: ${first.title} (${first.error})`,
        duration: Infinity,
        onDismiss: () => {
          for (const restId of restIds) toast.dismiss(restId);
          done();
        },
        action: { label: "Open", onClick: () => onOpen(first.sessionId, first.environmentId) },
      });
      rest.forEach((f, index) => {
        toast.error(f.title, {
          id: restIds[index],
          description: f.error,
          duration: Infinity,
          action: { label: "Open", onClick: () => onOpen(f.sessionId, f.environmentId) },
        });
      });
    },
  );
  return null;
}
