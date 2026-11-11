import { formatElementLine, parseObservation, type ElementLine, type ObservationLine } from '@shared/computer/observation'
import type { ElementBrief, ObservationKind } from '@shared/computer/protocol'

/**
 * What a thread knows of one app's elements: every index the observations it
 * got named, with the element's line (after `[<index>] `) and its parent, kept
 * through diffs and subtrees, so a card says `button "Save"` and never asks
 * the service. A removed subtree takes its descendants.
 */
interface Entry {
  line: string
  parent: number | null
}

/** An element line's text after `[<index>] `, without indent, marker, geometry or `(and n inside)`. */
function lineOf(e: ElementLine): string {
  const { frame: _frame, inside: _inside, marker: _marker, ...rest } = e
  return formatElementLine({ ...rest, depth: 0 }).replace(/^\[\d+\] /, '')
}

export class ElementBook {
  private readonly entries = new Map<number, Entry>()
  /** the element the latest read named focused, if it named one */
  focused: number | null = null

  get size(): number {
    return this.entries.size
  }

  has(index: number): boolean {
    return this.entries.has(index)
  }

  brief(index: number): ElementBrief | null {
    const e = this.entries.get(index)
    return e ? { index, line: e.line } : null
  }

  clear(): void {
    this.entries.clear()
    this.focused = null
  }

  /** Whether any element the book holds has this role (`password`). */
  hasRole(role: string): boolean {
    for (const e of this.entries.values()) if (e.line === role || e.line.startsWith(`${role} `)) return true
    return false
  }

  /** Take one observation the model got. A text off the grammar empties the book: names fall back to indices. */
  apply(text: string, kind: ObservationKind): void {
    let lines: ObservationLine[]
    try {
      const parsed = parseObservation(text)
      lines = parsed.lines
      this.focused = parsed.header.focused ?? null
    } catch {
      this.clear()
      return
    }
    if (kind === 'unchanged') return
    if (kind === 'full') {
      this.entries.clear()
      this.tree(lines, null, 0)
      return
    }
    if (kind === 'subtree') {
      const root = lines.find((l) => l.type === 'element' && l.depth === 0)
      const parent = root && root.type === 'element' ? (this.entries.get(root.index)?.parent ?? null) : null
      this.tree(lines, parent, 0)
      return
    }
    this.diff(lines)
  }

  /** Full-tree lines from depth `base` on: each line's parent is the nearest shallower element. */
  private tree(lines: ObservationLine[], parentAtBase: number | null, base: number): void {
    const stack: (number | null)[] = []
    for (const l of lines) {
      if (l.type !== 'element' && l.type !== 'range') continue
      const depth = l.depth - base
      const parent = depth <= 0 ? parentAtBase : (stack[depth - 1] ?? parentAtBase)
      if (l.type === 'element') {
        this.entries.set(l.index, { line: lineOf(l), parent })
        stack[depth] = l.index
      } else {
        for (let i = l.first; i <= l.last; i++) this.entries.set(i, { line: l.role, parent })
        stack[depth] = null
      }
      stack.length = depth + 1
    }
  }

  private diff(lines: ObservationLine[]): void {
    let group: ObservationLine[] = []
    let groupParent: number | null = null
    const flush = (): void => {
      if (group.length) this.tree(group, groupParent, 1)
      group = []
    }
    for (const l of lines) {
      if (l.type === 'added') {
        flush()
        groupParent = l.parent
        continue
      }
      const marked = (l.type === 'element' || l.type === 'range') && l.marker !== undefined
      if (!marked) {
        group.push(l)
        continue
      }
      flush()
      if (l.type === 'range') for (let i = l.first; i <= l.last; i++) this.remove(i)
      else if (l.marker === '-') this.remove(l.index)
      else {
        const was = this.entries.get(l.index)
        this.entries.set(l.index, { line: lineOf(l), parent: was?.parent ?? null })
      }
    }
    flush()
  }

  private remove(index: number): void {
    if (!this.entries.delete(index)) return
    for (const [i, e] of [...this.entries]) if (e.parent === index) this.remove(i)
  }
}
