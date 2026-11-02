import type { ReactNode } from "react";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { COLUMN_GUTTER_CLASS, columnClass } from "./threads/chatSlots";

/**
 * A thread with no messages: the composer alone, a little above the pane's
 * centre, in the docked footer's gutter and column, so the first send moves
 * the box into its place without resizing it.
 */
export function EmptySession({ composer }: { composer?: ReactNode }) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  return (
    <div
      ref={lockOverscroll}
      data-empty-session
      className="flex h-full min-h-0 overflow-y-auto overscroll-none"
    >
      {composer ? (
        <div className={`${COLUMN_GUTTER_CLASS} flex flex-1 flex-col justify-center pt-8 pb-16`}>
          <div data-empty-column className={columnClass()}>
            {composer}
          </div>
        </div>
      ) : null}
    </div>
  );
}
