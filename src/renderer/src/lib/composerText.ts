/**
 * The composer's contenteditable, read and written as serialized text.
 *
 * Serialization: text nodes as they are, a chip (`[data-token]`) as its
 * token, `<br>` as a newline, a block element as a newline before its
 * children (Chromium wraps new lines in divs). One leading newline is
 * dropped, since the first line has nothing before it.
 *
 * Every reader here is one forward walk. The old code walked once for the
 * text, once more (after cloning the DOM) for the caret, and a third time
 * for the chips, on every keystroke.
 */

export interface ComposerChip {
  /** the literal token serialized into the message (e.g. "/linear") */
  token: string
  /** addon name for the label + brand mark */
  name: string
}

/** One run of composer content — drafts round-trip through these. */
export type ComposerSegment = { text: string } | { chip: ComposerChip }

export type ComposerRead = {
  text: string
  caret: number
  chips: Array<[number, number]>
}

export type DomPosition = { node: Node; offset: number }

type Walk = {
  isBlock: (node: HTMLElement) => boolean
}

function walker(): Walk {
  const blocks = new Map<HTMLElement, boolean>()
  return {
    isBlock(node) {
      let block = blocks.get(node)
      if (block === undefined) {
        block = getComputedStyle(node).display === 'block'
        blocks.set(node, block)
      }
      return block
    }
  }
}

function isChip(node: Node): boolean {
  return node instanceof HTMLElement && node.dataset.token !== undefined
}

/**
 * Text, caret and chip spans in one pass. `selection` is the focus end of
 * the selection when it sits inside `root`; without one the caret reads
 * as the end of the text.
 */
export function readComposer(root: HTMLElement, selection: DomPosition | null): ComposerRead {
  const { isBlock } = walker()
  const hasChips = root.querySelector('[data-token]') !== null
  const chips: Array<[number, number]> = []
  let text = ''
  let caret = -1

  const visit = (parent: Node): void => {
    const children = parent.childNodes
    for (let i = 0; i < children.length; i++) {
      if (selection && selection.node === parent && selection.offset === i) caret = text.length
      const child = children[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue ?? ''
        if (selection && selection.node === child) {
          caret = text.length + Math.min(selection.offset, value.length)
        }
        text += value
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (hasChips && isChip(child)) {
        const token = child.dataset.token ?? ''
        chips.push([text.length, text.length + token.length])
        text += token
        // A caret inside the chip's label sits after the chip.
        if (selection && child.contains(selection.node) && selection.node !== parent) {
          caret = text.length
        }
        continue
      }
      if (child.tagName === 'BR') {
        text += '\n'
        continue
      }
      if (isBlock(child)) text += '\n'
      visit(child)
    }
    if (selection && selection.node === parent && selection.offset >= children.length) {
      caret = text.length
    }
  }
  visit(root)
  if (caret < 0) caret = text.length

  if (text.startsWith('\n')) {
    text = text.slice(1)
    caret = Math.max(0, caret - 1)
    for (const chip of chips) {
      chip[0] = Math.max(0, chip[0] - 1)
      chip[1] = Math.max(0, chip[1] - 1)
    }
  }
  return { text, caret, chips }
}

export function serializeComposer(root: HTMLElement): string {
  return readComposer(root, null).text
}

/** The selection's focus end when it lies inside `root`. */
export function selectionIn(root: HTMLElement): DomPosition | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.endContainer)) return null
  return { node: range.endContainer, offset: range.endOffset }
}

/**
 * DOM positions for several serialized offsets, resolved in one walk.
 * Offsets must be ascending. A position on a chip's edge lands in the
 * chip's parent, before or after it.
 */
export function positionsFor(root: HTMLElement, offsets: readonly number[]): Array<DomPosition | null> {
  const { isBlock } = walker()
  const out: Array<DomPosition | null> = offsets.map(() => null)
  if (offsets.length === 0) return out
  let next = 0
  let pos = 0
  // readComposer drops one leading newline, whatever node made it — a
  // block, a <br>, or a text node's first character. Mirror that here or
  // every position lands one character early.
  let dropped = false
  const dropsLead = (): boolean => {
    if (pos !== 0 || dropped) return false
    dropped = true
    return true
  }

  const place = (node: Node, offset: number): void => {
    out[next] = { node, offset }
    next++
  }
  const visit = (parent: Node): boolean => {
    const children = parent.childNodes
    for (let i = 0; i < children.length && next < offsets.length; i++) {
      const child = children[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue ?? ''
        const lead = value.startsWith('\n') && dropsLead() ? 1 : 0
        const len = value.length - lead
        while (next < offsets.length && offsets[next] <= pos + len) {
          place(child, offsets[next] - pos + lead)
        }
        pos += len
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (isChip(child)) {
        const len = (child.dataset.token ?? '').length
        while (next < offsets.length && offsets[next] <= pos + len) {
          place(parent, i + (offsets[next] === pos + len ? 1 : 0))
        }
        pos += len
        continue
      }
      if (child.tagName === 'BR') {
        if (dropsLead()) continue
        while (next < offsets.length && offsets[next] <= pos) place(parent, i)
        pos += 1
        continue
      }
      if (isBlock(child) && !dropsLead()) {
        while (next < offsets.length && offsets[next] <= pos) place(parent, i)
        pos += 1
      }
      if (visit(child)) return true
    }
    return next >= offsets.length
  }
  visit(root)
  // Offsets at or past the end land at the end of the root.
  while (next < offsets.length && offsets[next] <= pos) place(root, root.childNodes.length)
  return out
}

export function positionFor(root: HTMLElement, offset: number): DomPosition | null {
  return positionsFor(root, [offset])[0] ?? null
}

/** Content as segments, chips kept whole — what a saved draft holds. */
export function snapshotSegments(root: HTMLElement): ComposerSegment[] {
  const { isBlock } = walker()
  const out: ComposerSegment[] = []
  const pushText = (t: string): void => {
    if (!t) return
    const last = out[out.length - 1]
    if (last && 'text' in last) last.text += t
    else out.push({ text: t })
  }
  const visit = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(child.nodeValue ?? '')
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (isChip(child)) {
        out.push({ chip: { token: child.dataset.token ?? '', name: child.dataset.name ?? '' } })
        continue
      }
      if (child.tagName === 'BR') {
        pushText('\n')
        continue
      }
      if (isBlock(child)) pushText('\n')
      visit(child)
    }
  }
  visit(root)
  const first = out[0]
  if (first && 'text' in first && first.text.startsWith('\n')) first.text = first.text.slice(1)
  return out.filter((s) => 'chip' in s || s.text)
}

/**
 * Replace the selection inside `root` (or append, when the selection is
 * elsewhere) with plain text in one Range mutation, and leave the caret
 * after it. The root is `pre-wrap`, so newlines need no markup.
 */
export function insertPlainText(root: HTMLElement, text: string): void {
  const sel = window.getSelection()
  let range: Range
  const current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  if (current && root.contains(current.startContainer) && root.contains(current.endContainer)) {
    range = current
  } else {
    range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
  }
  // Chromium's placeholder <br> for an empty box would become a stray line.
  if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) {
    root.innerHTML = ''
    range = document.createRange()
    range.setStart(root, 0)
    range.collapse(true)
  }
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(range)
}
