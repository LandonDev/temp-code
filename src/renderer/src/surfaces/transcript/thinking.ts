// A9 (thinking): the words of the thinking row, pure.
import type { Block } from "../../lib/session";

/** "4s", "1m 12s", "2m": a span never shorter than one second. */
export function spanWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The settled row's label: "Thought for 4s", or "Thought" with no timing. */
export function thoughtLabel(ms?: number): string {
  return ms == null ? "Thought" : `Thought for ${spanWords(ms)}`;
}

/** How long the thought ran: from its block's birth to the next thing's. */
export function thoughtMs(block: Pick<Block, "ts">, endTs?: number): number | undefined {
  if (block.ts == null || endTs == null) return undefined;
  return Math.max(0, endTs - block.ts);
}

const MAX_LINE = 160;

/**
 * The newest finished sentence of a thought, as plain text, for the live
 * row. A sentence still being written is left out until it ends (a line
 * that changes word by word reads as noise), unless it is all there is.
 * Code and markdown markers go; the line is cut at 160 characters.
 */
export function latestLine(text: string): string {
  const body = text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/, "")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(\*|_)(.+?)\1/g, "$2")
        .trim(),
    )
    .filter(Boolean);
  const sentences = body.flatMap((line) => line.split(/(?<=[.!?:])\s+/)).filter(Boolean);
  if (!sentences.length) return "";
  const last = sentences[sentences.length - 1];
  const finished = /[.!?:]$/.test(last);
  const line = finished || sentences.length === 1 ? last : sentences[sentences.length - 2];
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}
