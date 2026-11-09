/** Children of one proof-owned process, deepest first, from ps -Ao pid=,ppid=. */
export function proofDescendants(ps: string, parent: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of ps.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!row) continue
    const pid = Number(row[1]),
      ppid = Number(row[2])
    const siblings = children.get(ppid) ?? []
    siblings.push(pid)
    children.set(ppid, siblings)
  }
  const seen = new Set([parent])
  const result: number[] = []
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      result.push(child)
    }
  }
  visit(parent)
  return result
}
