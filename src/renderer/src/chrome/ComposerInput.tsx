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
import { pastePlan } from '../lib/composerPaste'
import {
  insertPlainText,
  positionsFor,
  readComposer,
  selectionIn,
  serializeComposer,
  snapshotSegments,
  type ComposerChip,
  type ComposerSegment
} from '../lib/composerText'
import { tallyRender } from '../lib/devRenders'

export type { ComposerChip, ComposerSegment } from '../lib/composerText'

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
  /** type plain text at the caret (or the end) as one edit — ⌘Z takes it back whole */
  insertText: (text: string) => void
  clear: () => void
  /** current content as segments, chips intact — for saving a draft */
  snapshot: () => ComposerSegment[]
  /** replace all content from segments, caret at the end */
  restore: (segments: ComposerSegment[]) => void
}

const HIGHLIGHT_NAMES = { skill: 'composer-skill', mention: 'composer-mention' } as const

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
  // Focus first: focusing an editable that lacks the selection seats the
  // caret at its start, which would undo the placement below.
  root.focus()
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

function caretToEnd(root: HTMLElement): void {
  placeCaret(root, root, root.childNodes.length)
}

function fillFromSegments(root: HTMLElement, segments: readonly ComposerSegment[]): void {
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
}

/** Paint plain `/skill` and `@mention` runs through the CSS highlight
 *  registry — the only way to colour ranges of a contenteditable without
 *  putting markup in the user's way. All token edges resolve in one walk. */
function paintTokens(root: HTMLElement, tokens: readonly ComposerToken[]): void {
  const registry = CSS.highlights
  if (!registry) return
  const edges = tokens
    .flatMap((token, i) => [
      { offset: token.start, token: i },
      { offset: token.end, token: i }
    ])
    .sort((a, b) => a.offset - b.offset)
  const positions = positionsFor(
    root,
    edges.map((e) => e.offset)
  )
  const ranges = new Map<number, Range>()
  edges.forEach((edge, i) => {
    const pos = positions[i]
    if (!pos) return
    let range = ranges.get(edge.token)
    if (!range) {
      range = document.createRange()
      ranges.set(edge.token, range)
    }
    if (edge.offset === tokens[edge.token].start) range.setStart(pos.node, pos.offset)
    else range.setEnd(pos.node, pos.offset)
  })
  for (const kind of ['skill', 'mention'] as const) {
    const painted: Range[] = []
    tokens.forEach((token, i) => {
      const range = ranges.get(i)
      if (token.kind === kind && range && !range.collapsed) painted.push(range)
    })
    const name = HIGHLIGHT_NAMES[kind]
    if (painted.length === 0) registry.delete(name)
    else registry.set(name, new Highlight(...painted))
  }
}

export const NO_TOKENS: ComposerToken[] = []

/** Content around one programmatic insertion, so ⌘Z can take it back whole. */
type Insertion = { before: ComposerSegment[]; after: string; caret: number }
const UNDO_DEPTH = 8

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  {
    onState: (text: string, caret: number, chips: Array<[number, number]>) => void
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
    onPaste: (e: ClipboardEvent<HTMLDivElement>) => void
    onFocus?: () => void
    /** when given, a pasted text over the size threshold becomes a file here instead of typed text */
    attachLargePastes?: (file: File) => void
    placeholder: string
    className?: string
    maxHeight: number
    /** plain tokens to colour; positions in the serialized text */
    tokens?: readonly ComposerToken[]
  }
>(function ComposerInput(
  {
    onState,
    onKeyDown,
    onPaste,
    onFocus,
    attachLargePastes,
    placeholder,
    className,
    maxHeight,
    tokens = NO_TOKENS
  },
  ref
) {
  tallyRender('composerInput')
  const rootRef = useRef<HTMLDivElement>(null)
  const lastText = useRef('')
  /** an IME is composing: the DOM is in flux, report when it settles */
  const composing = useRef(false)
  /** an input event already reported this task; the selectionchange it queued follows */
  const reportedThisFrame = useRef(false)
  /** programmatic insertions the browser's own undo stack never saw */
  const undo = useRef<Insertion[]>([])
  const paintedTokens = useRef(tokens)

  const report = (): void => {
    const root = rootRef.current
    if (!root) return
    // Chromium leaves a lone <br> after the last character goes; the
    // placeholder relies on :empty.
    if (root.childNodes.length === 1 && root.firstChild instanceof HTMLBRElement) {
      root.innerHTML = ''
    }
    const { text, caret, chips } = readComposer(root, selectionIn(root))
    if (text !== lastText.current) {
      lastText.current = text
      morphTextareaHeight(root, maxHeight)
    }
    onState(text, caret, chips)
  }

  const onInput = (): void => {
    if (composing.current) return
    reportedThisFrame.current = true
    // A timeout, not a frame: the selectionchange task is already queued
    // and runs first, and a hidden window still runs timers.
    setTimeout(() => {
      reportedThisFrame.current = false
    }, 0)
    report()
  }

  /** Replace everything and repaint: the highlight ranges died with the old nodes. */
  const rebuild = (root: HTMLElement, segments: readonly ComposerSegment[]): void => {
    fillFromSegments(root, segments)
    paintTokens(root, paintedTokens.current)
  }

  const insertText = (text: string): void => {
    const root = rootRef.current
    if (!root) return
    const before = snapshotSegments(root)
    if (selectionIn(root)) root.focus()
    else caretToEnd(root)
    const caret = readComposer(root, selectionIn(root)).caret
    insertPlainText(root, text)
    undo.current = [
      ...undo.current.slice(1 - UNDO_DEPTH),
      { before, after: serializeComposer(root), caret }
    ]
    report()
  }

  /** ⌘Z with the box exactly as an insertion left it: take that insertion back. */
  const undoInsertion = (root: HTMLElement): boolean => {
    const top = undo.current[undo.current.length - 1]
    if (!top || serializeComposer(root) !== top.after) return false
    undo.current = undo.current.slice(0, -1)
    rebuild(root, top.before)
    const at = positionsFor(root, [top.caret])[0]
    if (at) placeCaret(root, at.node, at.offset)
    else caretToEnd(root)
    report()
    return true
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      const root = rootRef.current
      if (!root) return
      if (selectionIn(root)) root.focus()
      else caretToEnd(root)
    },
    value: () => (rootRef.current ? serializeComposer(rootRef.current) : ''),
    replaceRange: (from, to, insert) => {
      const root = rootRef.current
      if (!root) return
      const [start, end] = positionsFor(root, from <= to ? [from, to] : [to, from])
      if (!start || !end) return
      root.focus()
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
      undo.current = []
      report()
    },
    insertText,
    clear: () => {
      const root = rootRef.current
      if (!root) return
      root.innerHTML = ''
      root.style.height = 'auto'
      undo.current = []
      report()
    },
    snapshot: () => (rootRef.current ? snapshotSegments(rootRef.current) : []),
    restore: (segments) => {
      const root = rootRef.current
      if (!root) return
      rebuild(root, segments)
      if (document.activeElement === root) caretToEnd(root)
      undo.current = []
      report()
    }
  }))

  useLayoutEffect(() => {
    paintedTokens.current = tokens
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

  // selectionchange is document-level — needed for caret-only moves. An
  // input event moves the caret too and has already reported this frame.
  useEffect(() => {
    const onSel = (): void => {
      if (document.activeElement !== rootRef.current) return
      if (reportedThisFrame.current || composing.current) return
      report()
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
      onInput={onInput}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
        onInput()
      }}
      onFocus={onFocus}
      onKeyDown={(e) => {
        // A pasted block goes in as one Range edit the browser's undo stack
        // never sees. Once the browser has undone whatever was typed after
        // it, the box matches the post-paste text and this ⌘Z takes the
        // paste back in one step.
        if (
          undo.current.length > 0 &&
          (e.metaKey || e.ctrlKey) &&
          !e.shiftKey &&
          !e.altKey &&
          e.key.toLowerCase() === 'z'
        ) {
          const root = rootRef.current
          if (root && undoInsertion(root)) {
            e.preventDefault()
            return
          }
        }
        onKeyDown(e)
      }}
      onPaste={(e) => {
        onPaste(e)
        if (e.defaultPrevented) return
        // Plain text only — foreign markup must never enter the composer.
        e.preventDefault()
        const raw = e.clipboardData.getData('text/plain')
        if (!raw) return
        const plan = pastePlan(raw, attachLargePastes ? undefined : Infinity)
        if ('attach' in plan) attachLargePastes?.(plan.attach)
        else insertText(plan.inline)
      }}
      className={className}
      style={{ overflowY: 'auto', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
    />
  )
})

/** Same spans, same kinds, in order — the paint has nothing new to draw. */
export function sameTokens(a: readonly ComposerToken[], b: readonly ComposerToken[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].kind !== b[i].kind) return false
  }
  return true
}
