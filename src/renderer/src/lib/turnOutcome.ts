import type { Failure } from "@server/shared/events";
import { fallbackFailure } from "@server/shared/failureFallback";
import type { Block, Session } from "./session";

/**
 * Stopped versus Failed. The fold keeps a harness error as a system row
 * with an `err:` id; the user's own Stop lands the same way with the
 * thread's `stopped` flag (and, once the fold stamps it, the row's). A stop
 * is a quiet gray note. Every failure carries a verdict: the host's, else
 * the shared fallback (src/shared/failureFallback.ts), so the transcript
 * draws one FailureCard for all of them and never the harness's raw words.
 */

/** A stop, or a failure with its verdict (the host's, else the fallback): the card prints its lines and actions. */
export type ErrorRow =
  | { stopped: true; message: string; failure: null }
  | { stopped: false; message: string; failure: Failure; canRetry: boolean };

/** `treeCanContinue` is the server's tree-wide verdict; `stopped` on the row is stamped by the fold. */
export type OutcomeSession = Pick<Session, "blocks" | "status" | "thread"> & { treeCanContinue?: boolean };
type StoppableBlock = Block & { stopped?: boolean };

export function isErrorBlock(block: Block): boolean {
  return block.role === "system" && block.id.startsWith("err:");
}

export function lastErrorBlock(blocks: Block[]): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isErrorBlock(blocks[i])) return blocks[i];
  }
  return undefined;
}

/** The row records the user's Stop, or it is the trailing error of a stopped thread. */
export function isStoppedRow(session: OutcomeSession, block: Block): boolean {
  if (!isErrorBlock(block)) return false;
  if ((block as StoppableBlock).stopped) return true;
  return !!session.thread?.stopped && lastErrorBlock(session.blocks)?.id === block.id;
}

/** Nothing after `from` in its turn but the host's own notices: no error,
 *  nothing the model or the person wrote. Stops at the next turn's start. */
function onlyNoticesAfter(blocks: Block[], from: number): { closes: boolean; lastTurn: boolean } {
  for (let i = from + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.role === "user" || b.role === "handoff") return { closes: true, lastTurn: false };
    if (b.role !== "system" || isErrorBlock(b)) return { closes: false, lastTurn: false };
  }
  return { closes: true, lastTurn: true };
}

/** The turn ends on the person's Stop: its last error row is a stopped
 *  row and only host notices follow it. Its closing line is then
 *  "Stopped" (TurnEnd.tsx), never a "Worked for". */
export function turnEndsStopped(session: OutcomeSession, blocks: Block[]): boolean {
  const last = lastErrorBlock(blocks);
  if (!last || !isStoppedRow(session, last)) return false;
  return onlyNoticesAfter(blocks, blocks.indexOf(last)).closes;
}

/** The stopped row the settled turn's closing line already says: the row
 *  itself draws nothing then, so "Stopped" shows once. A turn still open
 *  (the thread busy or paused on it) keeps the row, as it has no closing
 *  line yet. */
export function stopClosesTurn(session: OutcomeSession & { busy?: boolean }, block: Block): boolean {
  if (!isStoppedRow(session, block)) return false;
  const at = session.blocks.findIndex((b) => b.id === block.id);
  if (at < 0) return false;
  const { closes, lastTurn } = onlyNoticesAfter(session.blocks, at);
  if (!closes) return false;
  return !lastTurn || !(session.busy || session.status === "paused");
}

/** Retry continues the work (`session.continue`), which the host does only
 *  for the last error of a tree it can pick back up and nothing paused: a
 *  bare "turn ended: …" wind-down settles the thread idle and is never
 *  continuable, so its card offers no Retry and the composer is the way on. */
export function canRetryFrom(session: OutcomeSession, block: Block): boolean {
  if (!session.treeCanContinue || session.status === "paused") return false;
  return lastErrorBlock(session.blocks)?.id === block.id;
}

export function errorRowOf(session: OutcomeSession, block: Block): ErrorRow {
  if (isStoppedRow(session, block)) {
    return { stopped: true, message: block.text, failure: null };
  }
  return {
    stopped: false,
    message: block.text,
    failure: block.failure ?? fallbackFailure(),
    canRetry: canRetryFrom(session, block),
  };
}
