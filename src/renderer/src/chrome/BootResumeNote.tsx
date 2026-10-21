import { useEffect } from "react";
import { bootResumeLine, dismissBootResume, useBootResumeNotice } from "../lib/bootResume";

const SHOWN_MS = 15_000;

/**
 * One quiet line under a host's rail section, once per boot of that host:
 * "7 threads resumed after restart". It goes on its own after a while, or
 * on a click; there is nothing to open, the threads are in the rows below.
 */
export function BootResumeNote({ environmentId }: { environmentId: string | undefined }) {
  const notice = useBootResumeNotice(environmentId);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissBootResume(notice.environmentId), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <button
      type="button"
      role="status"
      data-boot-resume={notice.count}
      onClick={() => dismissBootResume(notice.environmentId)}
      className="pressable mx-2 mb-1 flex h-6 w-[calc(100%-16px)] items-center gap-1.5 rounded-md px-2 text-left text-[11px] leading-tight text-content/50 hover:bg-content/5 hover:text-content"
      title="Dismiss"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
      <span className="min-w-0 flex-1 truncate">{bootResumeLine(notice.count)}</span>
    </button>
  );
}
