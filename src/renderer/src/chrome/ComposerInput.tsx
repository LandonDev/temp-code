import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import { brandOf } from '../lib/addonBrand'
import { addonTitle } from '../lib/addonNames'
import { morphTextareaHeight } from '../lib/composerHeight'
import { tallyRender } from '../lib/devRenders'

/**
 * The composer's input: a managed contenteditable that renders connector
 * references as inline chips — the Linear mark and name, as the transcript
 * shows them — while serializing back to plain text with the real
 * `/linear` token, so nothing downstream changes.
 *
 * The element is UNCONTROLLED: the DOM is the source of truth while the
 * user types (re-rendering on every keystroke would fight the caret), and
 * the component reports `(text, caret, chips)` after every input or
 * selection change. Programmatic edits (accepting a menu row, restoring a
 * draft, clearing on send) go through the imperative handle.
 */

export interface ComposerChip {
  /** the literal token serialized into the message (e.g. "/linear") */
  token: string
  /** addon name for the label + brand mark */
  name: string
}

/** One run of composer content — drafts round-trip through these. */
export type ComposerSegment = { text: string } | { chip: ComposerChip }

/** A plain `/skill` or `@mention` run to paint in the serialized text. */
export type ComposerToken = { start: number; end: number; kind: 'skill' | 'mention' }

export interface ComposerInputHandle {
  focus: () => void
  /** serialized text, chips as their tokens */
  value: () => string
  /** replace [from, to) of the serialized text with plain text or a chip */
  replaceRange: (
    from: number,
    to: number,
    insert: { text: string } | { chip: ComposerChip }
  ) => void
  clear: () => void
  /** current content as segments, chips intact — for saving a draft */
  snapshot: () => ComposerSegment[]
  /** replace all content from segments, caret at the end */
  restore: (segments: ComposerSegment[]) => void
}

const HIGHLIGHT_NAMES = { skill: 'composer-skill', mention: 'composer-mention' } as const

function isBlock(node: HTMLElement): boolean {
  return getComputedStyle(node).display === 'block'
}

/** Serialized text contributed by one DOM node. */
function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
  if (node instanceof HTMLElement) {
    if (node.dataset.token !== undefined) return node.dataset.token
    if (node.tagName === 'BR') return '\n'
    // block children (divs the browser makes on line breaks) begin new lines
    const inner = [...node.childNodes].map(serialize).join('')
    return isBlock(node) ? `\n${inner}` : inner
  }
  return ''
}

function serializeAll(root: HTMLElement): string {
  const out = [...root.childNodes].map(serialize).join('')
  // The first block child would add a leading newline that isn't there.
  return out.startsWith('\n') ? out.slice(1) : out
}

/** [start, end) spans the chips occupy in the serialized text — the
 *  autocomplete must never treat a chip's token as something being typed. */
function chipRanges(root: HTMLElement): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let offset = 0
  const leading = root.firstChild instanceof HTMLElement && isBlock(root.firstChild)
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.dataset.token !== undefined) {
        const len = child.dataset.token.length
        ranges.push([offset, offset + len])
        offset += len
        continue
      }
      if (child.nodeType === Node.TEXT_NODE) {
        offset += (child.nodeValue ?? '').length
        continue
      }
      if (child instanceof HTMLElement) {
        if (child.tagName === 'BR') {
          offset += 1
          continue
        }
        if (isBlock(child)) offset += 1
        walk(child)
      }
    }
  }
  walk(root)
  // mirror serializeAll's leading-newline trim
  return leading ? ranges.map(([a, b]) => [Math.max(0, a - 1), Math.max(0, b - 1)]) : ranges
}

function selectionInside(root: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return root.contains(range.endContainer) ? range : null
}

/** Serialized caret offset for the current selection inside root. */
function caretOffset(root: HTMLElement): number {
  const range = selectionInside(root)
  if (!range) return serializeAll(root).length
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.endContainer, range.endOffset)
  const holder = document.createElement('div')
  holder.append(pre.cloneContents())
  // cloneContents keeps data-token spans, so chip lengths count correctly.
  return serializeAll(holder).length
}

/** DOM position for a serialized offset (text nodes, or a chip's edge). */
function positionFor(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
  let remaining = offset
  const walk = (node: Node): { node: Node; offset: number } | null => {
    for (const child of node.childNodes) {
      const len = serialize(child).length
      if (remaining <= len) {
        if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: remaining }
        if (child instanceof HTMLElement && child.dataset.token !== undefined) {
          // boundary of a chip — position after/before it in the parent
          return {
            node,
            offset: [...node.childNodes].indexOf(child) + (remaining === len ? 1 : 0)
          }
        }
        return walk(child)
      }
      remaining -= len
    }
    return null
  }
  return walk(root)
}

/** Content as segments — the walk mirrors serialize() but keeps chips whole. */
function snapshotAll(root: HTMLElement): ComposerSegment[] {
  const out: ComposerSegment[] = []
  const pushText = (t: string): void => {
    if (!t) return
    const last = out[out.length - 1]
    if (last && 'text' in last) last.text += t
    else out.push({ text: t })
  }
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.dataset.token !== undefined) {
        out.push({ chip: { token: child.dataset.token, name: child.dataset.name ?? '' } })
        continue
      }
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(child.nodeValue ?? '')
        continue
      }
      if (child instanceof HTMLElement) {
        if (child.tagName === 'BR') {
          pushText('\n')
          continue
        }
        if (isBlock(child)) pushText('\n')
        walk(child)
      }
    }
  }
  walk(root)
  const first = out[0]
  if (first && 'text' in first && first.text.startsWith('\n')) first.text = first.text.slice(1)
  return out.filter((s) => 'chip' in s || s.text)
}

function chipElement(chip: ComposerChip): HTMLElement {
  const el = document.createElement('span')
  el.dataset.token = chip.token
  el.dataset.name = chip.name
  el.contentEditable = 'false'
  el.title = chip.token
  el.className =
    'inline-flex select-none items-center gap-1 rounded-[5px] bg-accent/20 px-1 align-baseline font-medium text-content'
  const brand = brandOf(chip.name)
  if (brand) {
    el.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" class="shrink-0"><path d="${brand.path}" fill="currentColor"></path></svg>`
  }
  el.append(document.createTextNode(addonTitle(chip.name)))
  return el
}

function placeCaret(root: HTMLElement, node: Node, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  root.focus()
}

function caretToEnd(root: HTMLElement): void {
  placeCaret(root, root, root.childNodes.length)
}

/** Paint plain `/skill` and `@mention` runs through the CSS highlight
 *  registry — the only way to colour ranges of a contenteditable without
 *  putting markup in the user's way. */
function paintTokens(root: HTMLElement, tokens: readonly ComposerToken[]): void {
  const registry = CSS.highlights
  if (!registry) return
  for (const kind of ['skill', 'mention'] as const) {
    const ranges: Range[] = []
    for (const token of tokens) {
      if (token.kind !== kind) continue
      const start = positionFor(root, token.start)
      const end = positionFor(root, token.end)
      if (!start || !end) continue
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      ranges.push(range)
    }
    const name = HIGHLIGHT_NAMES[kind]
    if (ranges.length === 0) registry.delete(name)
    else registry.set(name, new Highlight(...ranges))
  }
}

const NO_TOKENS: ComposerToken[] = []

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  {
    onState: (text: string, caret: number, chips: Array<[number, number]>) => void
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
    onPaste: (e: ClipboardEvent<HTMLDivElement>) => void
    onFocus?: () => void
    placeholder: string
    className?: string
    maxHeight: number
    /** plain tokens to colour; positions in the serialized text */
    tokens?: readonly ComposerToken[]
  }
>(function ComposerInput(
  { onState, onKeyDown, onPaste, onFocus, placeholder, className, maxHeight, tokens = NO_TOKENS },
  ref
) {
  tallyRender('composerInput')
  const rootRef = useRef<HTMLDivElement>(null)
  const lastText = useRef('')

  const report = (): void => {
    const root = rootRef.current
    if (!root) return
    // Chromium leaves a lone <br> after the last character goes; the
    // placeholder relies on :empty.
    if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) {
      root.innerHTML = ''
    }
    const text = serializeAll(root)
    if (text !== lastText.current) {
      lastText.current = text
      morphTextareaHeight(root, maxHeight)
    }
    onState(text, caretOffset(root), chipRanges(root))
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      const root = rootRef.current
      if (!root) return
      if (selectionInside(root)) root.focus()
      else caretToEnd(root)
    },
    value: () => (rootRef.current ? serializeAll(rootRef.current) : ''),
    replaceRange: (from, to, insert) => {
      const root = rootRef.current
      if (!root) return
      const start = positionFor(root, from)
      const end = positionFor(root, to)
      if (!start || !end) return
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      range.deleteContents()
      const nodes: Node[] =
        'chip' in insert
          ? [chipElement(insert.chip), document.createTextNode(' ')]
          : [document.createTextNode(insert.text)]
      for (const n of [...nodes].reverse()) range.insertNode(n)
      const last = nodes[nodes.length - 1]!
      const after = document.createRange()
      after.setStartAfter(last)
      after.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(after)
      root.focus()
      report()
    },
    clear: () => {
      const root = rootRef.current
      if (!root) return
      root.innerHTML = ''
      root.style.height = 'auto'
      report()
    },
    snapshot: () => (rootRef.current ? snapshotAll(rootRef.current) : []),
    restore: (segments) => {
      const root = rootRef.current
      if (!root) return
      root.innerHTML = ''
      for (const seg of segments) {
        if ('chip' in seg) {
          root.append(chipElement(seg.chip))
          continue
        }
        seg.text.split('\n').forEach((line, i) => {
          if (i > 0) root.append(document.createElement('br'))
          if (line) root.append(document.createTextNode(line))
        })
      }
      if (document.activeElement === root) caretToEnd(root)
      report()
    }
  }))

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root) paintTokens(root, tokens)
  }, [tokens])

  useEffect(() => {
    return () => {
      for (const name of Object.values(HIGHLIGHT_NAMES)) CSS.highlights?.delete(name)
    }
  }, [])

  // The pane this sits in can animate open from zero width — a height
  // measured mid-animation wraps the content absurdly and then sticks.
  // Re-measure whenever the box's WIDTH changes; height-only resizes (our
  // own morph) bail out, so no feedback loop.
  const lastWidth = useRef(0)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth
      if (w === lastWidth.current) return
      lastWidth.current = w
      if (w === 0) return
      root.style.transition = 'none'
      root.style.height = 'auto'
      root.style.height = `${Math.min(maxHeight, root.scrollHeight)}px`
    })
    ro.observe(root)
    return () => ro.disconnect()
  }, [maxHeight])

  // selectionchange is document-level — needed for caret-only moves.
  useEffect(() => {
    const onSel = (): void => {
      if (document.activeElement === rootRef.current) report()
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report is stable per mount
  }, [])

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Message"
      spellCheck={false}
      data-composer-input
      data-placeholder={placeholder}
      onInput={report}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        onPaste(e)
        if (e.defaultPrevented) return
        // Plain text only — foreign markup must never enter the composer.
        e.preventDefault()
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
      }}
      className={className}
      style={{ overflowY: 'auto', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
    />
  )
})
