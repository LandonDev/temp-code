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
      const more = rest.length > 0 ? ` and ${rest.length} more` : "";
      toast.error(title, {
        id,
        description: `${notice.failed.length} failed: ${first.title} (${first.error})${more}`,
        duration: Infinity,
        onDismiss: done,
        action: { label: "Open", onClick: () => onOpen(first.sessionId, first.environmentId) },
      });
    },
  );
  return null;
}
