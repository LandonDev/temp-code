/** One ranking function, two menus: the PromptBar @-mention list and ⌘P
 *  quick-open (docs/PLAN-3.md M11). Basename prefix > path prefix >
 *  substring; shorter paths win ties. */
export function rankFiles(files: string[], query: string, max = 8): string[] {
  if (!query) return files.slice(0, max)
  const q = query.toLowerCase()
  const scored: { p: string; s: number }[] = []
  for (const p of files) {
    const lower = p.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    const s = base.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1
    if (s >= 0) scored.push({ p, s })
    if (scored.length > 400) break
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length)
    .slice(0, max)
    .map((x) => x.p)
}
