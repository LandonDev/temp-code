// UI-16: what the live turn's working line says, pure.
import { computerPhrase } from "@shared/computer/words";
import { groupPhrase } from "../../lib/groupPhrase";
import { inputOf } from "../../lib/toolDetails";
import type { Block } from "../../lib/session";
import type { TitleOf } from "../../lib/threadMentions";
import { isProseBlock, isThinkingBlock, toldByWorkingLine } from "../transcriptActivity";
import { computerCallOf } from "../computerShots";
import { actionOf } from "./actionModel";
import { latestLine, latestLineKey } from "./thinking";

/**
 * One phase of the working line. `key` decides when the words morph: a
 * change of key morphs them (and is held at least 300 ms), new words under
 * the same key (a count, a seconds figure, a sentence growing) are drawn at
 * once. A thought's sentences are each a key of their own, so one morphs
 * into the next.
 */
export type WorkingPhase = {
  key: string;
  /** The words, plain. Empty while prose streams (the mark alone). */
  words: string;
  /** The line's accessible name when it is not `words`: a thought's sentences
   *  are said once as "Thinking", not each one to a screen reader. */
  spoken?: string;
  /** One call the line tells: its verb muted, its object in foreground. */
  call?: { block: Block; verb: string; object: string };
  /** The wait on agents, drawn like a call: "Waiting on" muted, what it waits on in foreground. */
  wait?: { verb: string; object: string };
  /** A thought streaming: its newest sentence and that sentence's ordinal. */
  thought?: { line: string; key: number };
};

/** The wait's verb, as `waitLine` (shared/watch.ts) words it. */
const WAIT_VERB = "Waiting on";

/** The host's words for the thread's running computer call (its session row's `running`). */
export type ComputerRunning = { words: string; held?: boolean } | null | undefined;

/**
 * One computer call on the line: the host's words when it has them (they name
 * the element from its book: "Clicking Save in TextEdit"), split at the verb
 * the call's own phrase has; a hold's words ("Waiting for the Mac to be
 * free") are said whole, under a key of their own.
 */
function computerCall(block: Block, running: ComputerRunning): WorkingPhase {
  const name = block.tool?.name ?? "";
  const own = computerPhrase(name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, ""), inputOf(block), { live: true });
  if (running?.held) return { key: `hold:${block.id}`, words: running.words };
  const words = running?.words ?? (own ? `${own.verb} ${own.object}` : "");
  const verb = own && words.startsWith(`${own.verb} `) ? own.verb : (words.split(" ")[0] ?? "");
  const object = words.slice(verb.length).trim();
  return { key: `call:${block.id}`, words, call: { block, verb, object } };
}

/** Something of the turn's own has come: anything but the person's row and an empty thought or reply. */
function started(turn: Block[]): boolean {
  return turn.some((b) => b.role !== "user" && !((b.role === "reasoning" || b.role === "assistant") && !b.text));
}

/**
 * What the working line says, first match wins: Sending while the person's
 * message is not yet echoed; the host's word for the wait (Starting the CLI,
 * Waiting for the provider, a retry) while nothing of the turn's own has
 * come, keyed by its words up to the first comma so "25 s" becoming "30 s"
 * is drawn in place; the wait on agents (`waitOn`, `waitSubject`'s words:
 * an agent's title or "2 subagents"), said as "Waiting on" and its object;
 * the running calls (`toldByWorkingLine`), one by its verb and object
 * ("Reading format.ts"), several by the group's present-tense phrase; a
 * thought streaming, as its newest sentence in place of the word (Thinking
 * until its first sentence); prose streaming, as the mark alone; else
 * Thinking.
 */
export function workingPhase(
  turn: Block[],
  activity: string | null | undefined,
  { cwd, titleOf, waitOn, computer }: { cwd?: string; titleOf?: TitleOf; waitOn?: string | null; computer?: ComputerRunning } = {},
): WorkingPhase {
  const last = turn[turn.length - 1];
  if (last?.role === "user" && last.pending) return { key: "sending", words: "Sending" };
  if (!started(turn) && activity) return { key: `host:${activity.split(",")[0]}`, words: activity };
  if (waitOn) return { key: "wait", words: `${WAIT_VERB} ${waitOn}`, wait: { verb: WAIT_VERB, object: waitOn } };
  const calls = turn.filter(toldByWorkingLine);
  if (calls.length === 1 && computerCallOf(calls[0])) return computerCall(calls[0], computer);
  if (calls.length === 1) {
    const { verb, object } = actionOf(calls[0], cwd, null, true);
    return { key: `call:${calls[0].id}`, words: [verb, object].filter(Boolean).join(" "), call: { block: calls[0], verb, object } };
  }
  if (calls.length > 1) return { key: "calls", words: groupPhrase(calls, cwd, true, titleOf) };
  const thought = turn.findLast((b) => isThinkingBlock(b) && b.streaming);
  if (thought) {
    const line = latestLine(thought.text);
    if (!line) return { key: "thinking", words: "Thinking" };
    const key = latestLineKey(thought.text);
    return { key: `thought:${key}`, words: line, spoken: "Thinking", thought: { line, key } };
  }
  if (last && isProseBlock(last) && last.streaming) return { key: "writing", words: "" };
  return { key: "thinking", words: "Thinking" };
}
