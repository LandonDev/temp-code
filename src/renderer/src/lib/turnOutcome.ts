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
  | { stopped: false; message: string; failure: Failure };

/** `stopped` on the row is stamped by the fold. */
export type OutcomeSession = Pick<Session, "blocks" | "status" | "thread">;
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

export function errorRowOf(session: OutcomeSession, block: Block): ErrorRow {
  if (isStoppedRow(session, block)) {
    return { stopped: true, message: block.text, failure: null };
  }
  return { stopped: false, message: block.text, failure: block.failure ?? fallbackFailure() };
}
