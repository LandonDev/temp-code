// A9 (thinking): a span's words and a streaming thought's finished sentences, pure.

/** "4s", "1m 12s", "2m": a span never shorter than one second. */
export function spanWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** A thought's paragraphs as plain text: code fences go whole, and each
 *  line loses its markdown markers (headings, bullets, quotes, emphasis,
 *  code spans, links). Blank lines are no paragraph. */
function paragraphsOf(text: string): string[] {
  return text
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
}

const ENDS = /[.!?:]$/;

/**
 * The sentences of a streaming thought that have finished, paragraph by
 * paragraph, for the reasoning column under the working line: every
 * paragraph but the last is whole, and the last one's sentence still being
 * written is left out until it ends (a line that changes word by word reads
 * as noise). A thought whose only sentence is unfinished gives no paragraph
 * yet; `thoughtHasWords` says it has text all the same.
 */
export function thoughtLines(text: string): string[][] {
  const paragraphs = paragraphsOf(text).map((p) => p.split(/(?<=[.!?:])\s+/).filter(Boolean));
  const last = paragraphs[paragraphs.length - 1];
  if (last && !ENDS.test(last[last.length - 1])) {
    last.pop();
    if (!last.length) paragraphs.pop();
  }
  return paragraphs;
}

/** The thought has words (past its markers), finished or not. */
export function thoughtHasWords(text: string): boolean {
  return paragraphsOf(text).length > 0;
}
