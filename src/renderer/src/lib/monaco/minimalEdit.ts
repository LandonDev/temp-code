/** Common prefix / suffix trim of two texts: the one edit that turns cur into next. */
export function minimalEdit(
  cur: string,
  next: string,
): { start: number; endCur: number; text: string } | null {
  if (cur === next) return null;
  let start = 0;
  const minLen = Math.min(cur.length, next.length);
  while (start < minLen && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  return { start, endCur, text: next.slice(start, endNext) };
}
