// A9 (thinking): a span's words and a thought's newest sentence, pure.

/** "4s", "1m 12s", "2m": a span never shorter than one second. */
export function spanWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

const MAX_LINE = 160;

/** The sentences of a thought as plain text: code and markdown markers go. */
function sentencesOf(text: string): string[] {
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
  return body.flatMap((line) => line.split(/(?<=[.!?:])\s+/)).filter(Boolean);
}

/** Which sentence the working line shows: the newest finished one, or the one
 *  being written when it is all there is. -1 for an empty thought. */
function latestIndex(sentences: string[]): number {
  if (!sentences.length) return -1;
  const last = sentences.length - 1;
  return /[.!?:]$/.test(sentences[last]) || last === 0 ? last : last - 1;
}

/**
 * The newest finished sentence of a thought, as plain text, for the
 * working line. A sentence still being written is left out until it ends (a line
 * that changes word by word reads as noise), unless it is all there is.
 * Code and markdown markers go; the line is cut at 160 characters.
 */
export function latestLine(text: string): string {
  const sentences = sentencesOf(text);
  const line = sentences[latestIndex(sentences)];
  if (line === undefined) return "";
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

/** The ordinal of the sentence `latestLine` shows: the same while that
 *  sentence grows, new once a later one finishes. The working line keys its
 *  phase by it (`thought:<n>`), so a new sentence morphs in and a growing one
 *  is redrawn in place. */
export function latestLineKey(text: string): number {
  return latestIndex(sentencesOf(text));
}
