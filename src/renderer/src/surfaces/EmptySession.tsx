import type { ReactNode } from "react";
import { useLockOverscroll } from "../hooks/useLockOverscroll";

/** A thread with no messages: the composer alone, a little above the pane's centre. */
export function EmptySession({ composer }: { composer?: ReactNode }) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  return (
    <div
      ref={lockOverscroll}
      data-empty-session
      className="flex h-full min-h-0 overflow-y-auto overscroll-none"
    >
      {composer ? (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-8 pt-8 pb-16">
          {composer}
        </div>
      ) : null}
    </div>
  );
}
