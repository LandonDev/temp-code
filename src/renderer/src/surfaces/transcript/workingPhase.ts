// UI-16: what the live turn's working line says, pure.
import { groupPhrase } from "../../lib/groupPhrase";
import type { Block } from "../../lib/session";
import type { TitleOf } from "../../lib/threadMentions";
import { isProseBlock, isThinkingBlock, toldByWorkingLine } from "../transcriptActivity";
import { actionOf } from "./actionModel";
import { latestLine, latestLineKey } from "./thinking";

/**
 * One phase of the working line. `key` decides when the words morph: a
 * change of key morphs them (and is held at least 300 ms), new words under
 * the same key (a count, a seconds figure, a new sentence) are drawn at once.
 */
export type WorkingPhase = {
  key: string;
  /** The words, plain: the line's accessible name. Empty while prose streams (the mark alone). */
  words: string;
  /** One call the line tells: its verb muted, its object in foreground. */
  call?: { block: Block; verb: string; object: string };
  /** A thought streaming: its newest sentence and that sentence's ordinal. */
  thought?: { line: string; key: number };
};

/** Something of the turn's own has come: anything but the person's row and an empty thought or reply. */
function started(turn: Block[]): boolean {
  return turn.some((b) => b.role !== "user" && !((b.role === "reasoning" || b.role === "assistant") && !b.text));
}

/**
 * What the working line says, first match wins: Sending while the person's
 * message is not yet echoed; the host's word for the wait (Starting the CLI,
 * Waiting for the provider, a retry) while nothing of the turn's own has
 * come, keyed by its words up to the first comma so "25 s" becoming "30 s"
 * is drawn in place; the wait on agents (`waitWords`, UI-15's words);
 * the running calls (`toldByWorkingLine`), one by its verb and object
 * ("Reading format.ts"), several by the group's present-tense phrase; a
 * thought streaming, as Thinking and its newest sentence; prose streaming,
 * as the mark alone; else Thinking.
 */
export function workingPhase(
  turn: Block[],
  activity: string | null | undefined,
  { cwd, titleOf, waitWords }: { cwd?: string; titleOf?: TitleOf; waitWords?: string | null } = {},
): WorkingPhase {
  const last = turn[turn.length - 1];
  if (last?.role === "user" && last.pending) return { key: "sending", words: "Sending" };
  if (!started(turn) && activity) return { key: `host:${activity.split(",")[0]}`, words: activity };
  if (waitWords) return { key: "wait", words: waitWords };
  const calls = turn.filter(toldByWorkingLine);
  if (calls.length === 1) {
    const { verb, object } = actionOf(calls[0], cwd, null, true);
    return { key: `call:${calls[0].id}`, words: [verb, object].filter(Boolean).join(" "), call: { block: calls[0], verb, object } };
  }
  if (calls.length > 1) return { key: "calls", words: groupPhrase(calls, cwd, true, titleOf) };
  const thought = turn.findLast((b) => isThinkingBlock(b) && b.streaming);
  if (thought) return { key: "thinking", words: "Thinking", thought: { line: latestLine(thought.text), key: latestLineKey(thought.text) } };
  if (last && isProseBlock(last) && last.streaming) return { key: "writing", words: "" };
  return { key: "thinking", words: "Thinking" };
}
