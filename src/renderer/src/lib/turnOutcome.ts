import type { Block, Session } from "./session";

/**
 * Stopped versus Failed. The fold keeps a harness error as a system row
 * with an `err:` id; the user's own Stop lands the same way with the
 * thread's `stopped` flag (and, once the fold stamps it, the row's). A stop
 * is a quiet gray note and never offers Continue. A failure offers one
 * Continue, on the last error still showing, when the server says the
 * tree can pick the work back up.
 */

export type ErrorRow = {
  stopped: boolean;
  message: string;
  showContinue: boolean;
};

/** `treeCanContinue` is the server's tree-wide verdict (M4); `stopped` on the row is stamped by the fold. */
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

/** Continue belongs on one row: the last error, when the server allows recovery and nothing is paused. */
export function canContinueFrom(session: OutcomeSession, block: Block): boolean {
  if (!session.treeCanContinue || session.status === "paused") return false;
  return lastErrorBlock(session.blocks)?.id === block.id;
}

export function errorRowOf(session: OutcomeSession, block: Block): ErrorRow {
  if (isStoppedRow(session, block)) {
    return { stopped: true, message: block.text, showContinue: false };
  }
  return { stopped: false, message: block.text, showContinue: canContinueFrom(session, block) };
}
