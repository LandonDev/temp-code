/**
 * A text's lines as a person counts them: the empty part a final newline
 * leaves is not a line, so "a\nb\nc\n" is three lines, "" none and "\n"
 * one empty line. Every diff count and row split in the transcript uses it.
 */
export function textLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}
