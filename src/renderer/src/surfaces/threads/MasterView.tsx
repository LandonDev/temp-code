import { chatOf } from "./chatSlots";
import type { ThreadViewProps } from "./ThreadView";

/**
 * The project's master thread (CLAUDE.md "Master threads"): the thread that
 * starts, watches and steers a batch of root threads. Wave 0 paints the chat
 * alone, the way an orchestration thread does before its first agent.
 * wave 1 ("The MasterView"): the board on the left (children grouped Needs
 * you / Running / Queued / Done, the batch's three steps under the list),
 * the chat on the right, on the SplitShell recipe (docs/LAYOUT.md "Master").
 */
export function MasterView(props: ThreadViewProps) {
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{chatOf(props)}</div>;
}
