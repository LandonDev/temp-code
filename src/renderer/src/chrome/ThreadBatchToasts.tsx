import { useEffect, useRef, type JSX } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";
import { dismissBatchNotice, useBatchNotices, type BatchNotice } from "../lib/threadBatch";

const NOTICE_MS = 8_000;

type Props = {
  /** Opens the thread a failure names. */
  onOpen: (sessionId: string, environmentId: string) => void;
};

/** One line per batch, bottom right: "Paused 14 · 1 failed: Search (harness
 *  not responding)", the failed thread a link. A clean result fades on its
 *  own; one with a failure waits to be read. */
export function ThreadBatchToasts({ onOpen }: Props): JSX.Element | null {
  const notices = useBatchNotices();
  if (notices.length === 0) return null;
  return createPortal(
    <div aria-live="polite" style={{ zIndex: LAYER.toast }} className="pointer-events-none fixed bottom-3 right-3 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2">
      {notices.map((n) => (
        <BatchToast key={n.key} notice={n} onOpen={onOpen} />
      ))}
    </div>,
    document.body,
  );
}

const VERB: Record<BatchNotice["action"], string> = { pause: "Paused", resume: "Resumed", stop: "Stopped", archiveDone: "Archived" };

function BatchToast({ notice, onOpen }: { notice: BatchNotice } & Props): JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failed = notice.failed.length > 0;
  useEffect(() => {
    if (failed) return;
    timer.current = setTimeout(() => dismissBatchNotice(notice.key), NOTICE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [notice.key, failed]);
  const [first, ...rest] = notice.failed;
  const link = (f: BatchNotice["failed"][number]) => (
    <button
      type="button"
      className="pressable rounded-sm font-semibold text-content underline decoration-content/30 underline-offset-2 hover:decoration-content"
      onClick={() => {
        onOpen(f.sessionId, f.environmentId);
        dismissBatchNotice(notice.key);
      }}
    >
      {f.title}
    </button>
  );
  return (
    <article role="status" data-batch-notice={failed ? "failed" : "ok"} className="pointer-events-auto overflow-hidden rounded-xl px-3.5 py-3 shadow-xl glass-surface floating-surface">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-content">
          <span className="font-semibold">
            {VERB[notice.action]} {notice.succeeded}
          </span>
          {first ? (
            <span className="text-danger">
              {" · "}
              {notice.failed.length} failed:{" "}
            </span>
          ) : null}
          {first ? (
            <>
              {link(first)}
              <span className="text-content/70"> ({first.error})</span>
              {rest.length > 0 ? <span className="text-content/70"> and {rest.length} more</span> : null}
            </>
          ) : null}
        </span>
        <button type="button" className="pressable shrink-0 text-[11px] text-content/40 hover:text-content" onClick={() => dismissBatchNotice(notice.key)}>
          Dismiss
        </button>
      </div>
      {rest.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px] leading-relaxed text-content/70">
          {rest.map((f) => (
            <li key={f.sessionId} className="truncate">
              {link(f)} ({f.error})
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
