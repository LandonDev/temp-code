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

  /** An element's ancestors, the nearest first; empty for an index the book lacks or one at the top. A parent that names a missing entry ends the walk. */
  path(index: number): ElementBrief[] {
    const out: ElementBrief[] = []
    const seen = new Set<number>([index])
    for (let at = this.entries.get(index)?.parent ?? null; at !== null && !seen.has(at); at = this.entries.get(at)?.parent ?? null) {
      const e = this.entries.get(at)
      if (!e) break
      seen.add(at)
      out.push({ index: at, line: e.line })
    }
    return out
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

  /**
   * One element the service named outside an observation (§27.7a, §27.9): a `named` step's resolved element, a
   * password field a refusal named. Its parent is kept when the book already holds it.
   */
  learn(brief: ElementBrief): void {
    this.entries.set(brief.index, { line: brief.line, parent: this.entries.get(brief.index)?.parent ?? null })
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
    // the opened-menu blocks close the text (§27.4): the body before them is read as its kind says
    const blockAt = lines.findIndex((l) => l.type === 'menuBlock')
    if (kind !== 'unchanged') this.read(blockAt < 0 ? lines : lines.slice(0, blockAt), kind)
    if (blockAt >= 0) this.menus(lines.slice(blockAt))
  }

  private read(lines: ObservationLine[], kind: ObservationKind): void {
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

  /** An opened menu's head and its items under it (§27.4). */
  private menus(lines: ObservationLine[]): void {
    let menu: number | null = null
    for (const l of lines) {
      if (l.type === 'menuBlock') {
        menu = l.menu?.index ?? null
        if (l.menu) this.entries.set(l.menu.index, { line: `menu ${JSON.stringify(l.menu.title)}`, parent: null })
      } else if (l.type === 'element') this.entries.set(l.index, { line: lineOf(l), parent: menu })
    }
  }

  /** Full-tree lines from depth `base` on: each line's parent is the nearest shallower element. */
  private tree(lines: ObservationLine[], parentAtBase: number | null, base: number): void {
    const stack: (number | null)[] = []
    for (const l of lines) {
      if (l.type === 'menuBar') {
        // a compact menu bar line (§27.13): the menu, then each item under it
        const depth = l.depth - base
        const parent = depth <= 0 ? parentAtBase : (stack[depth - 1] ?? parentAtBase)
        this.entries.set(l.index, { line: `menu ${JSON.stringify(l.title)}`, parent })
        for (const item of l.items)
          this.entries.set(item.index, { line: `menu item ${JSON.stringify(item.name)}${item.disabled ? ' disabled' : ''}`, parent: l.index })
        stack[depth] = l.index
        stack.length = depth + 1
        continue
      }
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
