import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { brandOf } from '../../lib/addon-brand'
import { addonTitle } from '../../lib/addon-names'

/**
 * The composer's input: a managed contenteditable that renders addon
 * references as inline chips — the Linear logo and name, exactly like the
 * transcript — while serializing back to plain text with the real
 * `/linear` token, so nothing downstream changes.
 *
 * The element is UNCONTROLLED: the DOM is the source of truth while the
 * user types (re-rendering innerHTML on every keystroke would fight the
 * caret), and the component reports `(text, caret)` after every input or
 * selection change. Programmatic edits (accepting a menu item, appending
 * a file ref, clearing on send) go through the imperative handle.
 */

export interface ComposerChip {
  /** the literal token serialized into the message (e.g. "/linear") */
  token: string
  /** addon name for the label + brand mark */
  name: string
}

/** One run of composer content — drafts round-trip through these. */
export type ComposerSegment = { text: string } | { chip: ComposerChip }

export interface ComposerInputHandle {
  focus: () => void
  /** replace [from, to) of the serialized text with plain text or a chip */
  replaceRange: (
    from: number,
    to: number,
    insert: { text: string } | { chip: ComposerChip }
  ) => void
  appendText: (text: string) => void
  clear: () => void
  /** current content as segments, chips intact — for saving a draft */
  snapshot: () => ComposerSegment[]
  /** replace all content from segments — for restoring a draft */
  restore: (segments: ComposerSegment[]) => void
}

/** Serialized length contributed by one DOM node. */
function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
  if (node instanceof HTMLElement) {
    if (node.dataset.token !== undefined) return node.dataset.token
    if (node.tagName === 'BR') return '\n'
    // block children (divs the browser makes on line breaks) begin new lines
    const inner = [...node.childNodes].map(serialize).join('')
    const block = getComputedStyle(node).display === 'block'
    return block ? `\n${inner}` : inner
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
  const leading = [...root.childNodes].some(
    (n) => n instanceof HTMLElement && getComputedStyle(n).display === 'block'
  )
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.dataset.token !== undefined) {
        const len = (child.dataset.token ?? '').length
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
        if (getComputedStyle(child).display === 'block') offset += 1
        walk(child)
      }
    }
  }
  walk(root)
  // mirror serializeAll's leading-newline trim
  if (leading && root.firstChild instanceof HTMLElement) {
    return ranges.map(([a, b]) => [Math.max(0, a - 1), Math.max(0, b - 1)])
  }
  return ranges
}

/** Serialized caret offset for the current selection inside root. */
function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return serializeAll(root).length
  const range = sel.getRangeAt(0)
  if (!root.contains(range.endContainer)) return serializeAll(root).length
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.endContainer, range.endOffset)
  const frag = pre.cloneContents()
  const holder = document.createElement('div')
  holder.append(frag)
  // cloneContents keeps data-token spans, so chip lengths count correctly.
  return serializeAll(holder).length
}

/** DOM position for a serialized string offset (text nodes only — the
 *  ranges we replace are always plain typed tokens). */
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
            offset: [...node.childNodes].indexOf(child as ChildNode) + (remaining === len ? 1 : 0)
          }
        }
        const inner = walk(child)
        if (inner) return inner
        return null
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
        if (getComputedStyle(child).display === 'block') pushText('\n')
        walk(child)
      }
    }
  }
  walk(root)
  // mirror serializeAll's leading-newline trim
  if (out.length && 'text' in out[0] && out[0].text.startsWith('\n')) {
    out[0].text = out[0].text.slice(1)
  }
  return out.filter((s) => 'chip' in s || s.text)
}

function chipElement(chip: ComposerChip): HTMLElement {
  const el = document.createElement('span')
  el.dataset.token = chip.token
  el.dataset.name = chip.name
  el.contentEditable = 'false'
  el.className =
    'inline-flex items-center gap-1 rounded-[5px] bg-accent px-1 align-baseline text-[13px] font-medium select-none'
  const brand = brandOf(chip.name)
  if (brand) {
    el.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" style="flex-shrink:0;transform:translateY(0.5px)"><path d="${brand.path}" fill="#${brand.hex}"></path></svg>`
  }
  el.append(document.createTextNode(addonTitle(chip.name)))
  return el
}

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  {
    onState: (text: string, caret: number, chips: Array<[number, number]>) => void
    onKeyDown: (e: React.KeyboardEvent) => void
    onPaste: (e: React.ClipboardEvent) => void
    placeholder: string
    className?: string
    /** re-run the height morph when this changes (mirrors old textarea) */
    heightKey: string
  }
>(function ComposerInput({ onState, onKeyDown, onPaste, placeholder, className, heightKey }, ref) {
  const rootRef = useRef<HTMLDivElement>(null)

  const report = (): void => {
    const root = rootRef.current
    if (!root) return
    onState(serializeAll(root), caretOffset(root), chipRanges(root))
  }

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
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
          ? [chipElement(insert.chip), document.createTextNode(' ')]
          : [document.createTextNode(insert.text)]
      for (const n of nodes.reverse()) range.insertNode(n)
      // caret after the insertion
      const sel = window.getSelection()
      const after = document.createRange()
      after.setStartAfter(nodes[0])
      after.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(after)
      root.focus()
      report()
    },
    appendText: (text) => {
      const root = rootRef.current
      if (!root) return
      root.append(document.createTextNode(text))
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(root)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
      report()
    },
    clear: () => {
      const root = rootRef.current
      if (!root) return
      root.innerHTML = ''
      report()
    },
    snapshot: () => {
      const root = rootRef.current
      return root ? snapshotAll(root) : []
    },
    restore: (segments) => {
      const root = rootRef.current
      if (!root) return
      root.innerHTML = ''
      for (const seg of segments) {
        if ('chip' in seg) {
          root.append(chipElement(seg.chip))
          continue
        }
        const lines = seg.text.split('\n')
        lines.forEach((line, i) => {
          if (i > 0) root.append(document.createElement('br'))
          if (line) root.append(document.createTextNode(line))
        })
      }
      report()
    }
  }))

  // Height morph (Zeron FlipMorph) — same tween the textarea had.
  useLayoutEffect(() => {
    const a = rootRef.current
    if (!a) return
    const prev = a.style.height
    a.style.transition = 'none'
    a.style.height = 'auto'
    const target = Math.min(260, a.scrollHeight)
    a.style.height = prev || `${target}px`
    void a.offsetHeight
    a.style.transition = 'height 180ms ease-out'
    a.style.height = `${target}px`
  }, [heightKey])

  // The pane this sits in can animate open from zero width (the board's
  // conversation fold) — a height measured mid-animation wraps the content
  // absurdly and then sticks. Re-measure whenever the box's WIDTH changes;
  // height-only resizes (our own morph) bail out, so no feedback loop.
  const lastWidth = useRef(0)
  useLayoutEffect(() => {
    const a = rootRef.current
    if (!a) return
    const ro = new ResizeObserver(() => {
      const w = a.clientWidth
      if (w === lastWidth.current) return
      lastWidth.current = w
      if (w === 0) return
      a.style.transition = 'none'
      a.style.height = 'auto'
      a.style.height = `${Math.min(260, a.scrollHeight)}px`
    })
    ro.observe(a)
    return () => ro.disconnect()
  }, [])

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
      role="textbox"
      aria-multiline="true"
      aria-label="Message"
      data-placeholder={placeholder}
      onInput={report}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        onPaste(e)
        if (e.defaultPrevented) return
        // Plain text only — foreign markup must never enter the composer.
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        document.execCommand('insertText', false, text)
      }}
      className={className}
      style={{ overflowY: 'auto', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
    />
  )
})
