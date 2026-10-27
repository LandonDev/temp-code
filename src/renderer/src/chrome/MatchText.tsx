import type { ReactNode } from "react";

type PositionSpec = { positions: number[] };
type QuerySpec = { query: string; caseSensitive?: boolean; regex?: boolean };
export type MatchSpec = PositionSpec | QuerySpec;

type Props = { text: string; active?: boolean } & MatchSpec;

/**
 * The one highlighter. Fuzzy matchers pass the matched character
 * positions; text searches pass the query. A match is marked by weight
 * (semibold, foreground), never by colour: blue is for links and focus.
 */
export function MatchText({ text, active = true, ...spec }: Props): ReactNode {
  const ranges = active ? matchRanges(text, spec) : [];
  if (ranges.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark key={start} className="bg-transparent font-semibold text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** The `[start, end)` runs to mark, sorted and never overlapping.
 *  Positions fold into runs; a query marks the whole phrase where it
 *  appears, else the first occurrence of each word; a regex marks its
 *  first match, and an invalid pattern marks nothing. */
export function matchRanges(text: string, spec: MatchSpec): [number, number][] {
  if ("positions" in spec) return foldPositions(text, spec.positions);
  const query = spec.query.trim();
  if (!query) return [];
  if (spec.regex) {
    let match: RegExpExecArray | null;
    try {
      match = new RegExp(query, spec.caseSensitive ? "" : "i").exec(text);
    } catch {
      return [];
    }
    if (!match || match[0].length === 0) return [];
    return [[match.index, match.index + match[0].length]];
  }
  const haystack = spec.caseSensitive ? text : text.toLowerCase();
  const find = (needle: string) => haystack.indexOf(spec.caseSensitive ? needle : needle.toLowerCase());
  const phrase = find(query);
  if (phrase >= 0) return [[phrase, phrase + query.length]];
  const ranges: [number, number][] = [];
  for (const word of query.split(/\s+/)) {
    const at = find(word);
    if (at >= 0) ranges.push([at, at + word.length]);
  }
  return mergeRanges(ranges);
}

function foldPositions(text: string, positions: number[]): [number, number][] {
  const sorted = [...new Set(positions)].filter((i) => i >= 0 && i < text.length).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
