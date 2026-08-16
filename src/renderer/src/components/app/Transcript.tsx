import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '../../lib/utils'
import { useApp } from '../../state/store'
import type { Block } from '../../state/blocks'
import { ApprovalCard } from './blocks/ApprovalCard'
import { QuestionCard } from './blocks/QuestionCard'
import { CompactionCard } from './blocks/CompactionCard'
import { MarkdownText } from './blocks/MarkdownText'
import { ThinkingBlock } from './blocks/ThinkingBlock'
import { TextShimmer } from '../motion/text-shimmer'
import {
  EDIT_TOOLS,
  ErrorChip,
  groupSummary,
  splitEdit,
  ToolGroup,
  ZEditCard
} from './blocks/ToolGroup'
import { UserMessage } from './blocks/UserMessage'
import { ZIcon } from './zicon'
import { Spinner } from '../ui/spinner'

/**
 * Zeron transcript (transcript.rs, values verbatim): 736px column,
 * translucent user bubbles, bare assistant markdown, consecutive tools
 * folded into group rows. Own sends glide the prompt to rest 10px under
 * the titlebar and the reply streams into a reserved runway below; the
 * hold releases only on a real user wheel/drag.
 */

type ToolBlock = Extract<Block, { kind: 'tool' }>

type Row =
  | { type: 'block'; id: string; block: Block; turn: number }
  | { type: 'group'; id: string; tools: ToolBlock[]; turn: number }
  | { type: 'edit'; id: string; block: ToolBlock; turn: number }

const TOP_INSET = 48 // OWN_SEND_TOP_INSET: titlebar 38 + 10
const BASE_PAD = 32 // bottom pad past the fade band
const STICK_THRESHOLD = 70 // re-engage follow within this of the bottom
const AT_BOTTOM = 2
const PILL_AT = 320 // "scroll to bottom" appears past this
const GLIDE_MS = 500 // SCROLL_GLIDE
const MAX_GLIDE_VIEWPORTS = 2.5

/** Consecutive tool blocks fold into one group row (id = first tool's). */
function rowsFor(blocks: Block[]): Row[] {
  const rows: Row[] = []
  let turn = -1
  for (const b of blocks) {
    // Thinking with no visible text never becomes a row — a row that
    // appears and then vanishes when the step settles reads as jitter.
    // The transcript's trailing "Thinking" status covers the live case.
    if (b.kind === 'thinking' && b.text.trim() === '') continue
    if (b.kind === 'user') turn++
    if (b.kind === 'tool') {
      // File changes stand alone and loud — one card per file, never
      // collapsed. App-bookkeeping edits (.temp-code/) and every other
      // tool fold into the running group (which resumes after the cards).
      const isEdit = EDIT_TOOLS.has(b.name)
      const { edits, internal } = isEdit ? splitEdit(b) : { edits: [], internal: null }
      for (const eb of edits) rows.push({ type: 'edit', id: eb.id, block: eb, turn })
      const grouped = isEdit ? internal : b
      if (grouped) {
        const last = rows.at(-1)
        if (last?.type === 'group') last.tools.push(grouped)
        else rows.push({ type: 'group', id: `g${grouped.id}`, tools: [grouped], turn })
      }
      continue
    }
    rows.push({ type: 'block', id: b.id, block: b, turn })
  }
  return rows
}

type GlanceKind = 'user' | 'reply' | 'edit' | 'tool' | 'alert'

/** What a row IS, at minimap distance: who spoke / what happened + a
 *  one-line snippet for the hover preview. */
function rowGlance(row: Row): { kind: GlanceKind; who: string; text: string } {
  if (row.type === 'group') return { kind: 'tool', who: 'Tools', text: groupSummary(row.tools) }
  if (row.type === 'edit') {
    const input = (row.block.input ?? {}) as { file_path?: string; notebook_path?: string }
    const path = input.file_path ?? input.notebook_path ?? ''
    return { kind: 'edit', who: 'Edit', text: path.split('/').pop() ?? row.block.name }
  }
  const b = row.block
  switch (b.kind) {
    case 'user':
      return { kind: 'user', who: 'You', text: b.text.trim().split('\n')[0] }
    case 'assistant':
      return { kind: 'reply', who: 'Reply', text: b.text.trim().split('\n')[0] }
    case 'thinking':
      return { kind: 'tool', who: 'Thinking', text: b.text.trim().split('\n')[0] }
    case 'approval':
      return { kind: 'alert', who: 'Approval', text: b.title ?? b.toolName }
    case 'question':
      return { kind: 'alert', who: 'Question', text: b.questions[0]?.question ?? '' }
    case 'error':
      return { kind: 'alert', who: 'Error', text: b.text }
    case 'compaction':
      return {
        kind: 'alert',
        who: 'Compaction',
        text: b.phase === 'start' ? 'Compacting context' : 'Context compacted'
      }
    default:
      return { kind: 'tool', who: '', text: '' }
  }
}

/** Tick geometry + tone per glance kind — your messages read strongest,
 *  finalized replies next, mechanics stay faint. */
const TICK: Record<GlanceKind, { w: number; cls: string }> = {
  user: { w: 14, cls: 'bg-info' },
  reply: { w: 12, cls: 'bg-foreground/50' },
  edit: { w: 12, cls: 'bg-success/60' },
  tool: { w: 7, cls: 'bg-foreground/18' },
  alert: { w: 12, cls: 'bg-warning' }
}

/** "Jul 1, 3:45 PM" — short month, no leading zero. */
function fmtTs(ts: number): string {
  const d = new Date(ts)
  const month = d.toLocaleString('en-US', { month: 'short' })
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${month} ${d.getDate()}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Single-block renderer for the non-chat views (implementation traces).
 *  `sessionId` is the session the block belongs to (approvals answer it). */
export const BlockRow = memo(function BlockRow({
  block,
  sessionId
}: {
  block: Block
  sessionId: string
}): React.JSX.Element {
  if (block.kind === 'tool') {
    if (EDIT_TOOLS.has(block.name)) {
      const { edits, internal } = splitEdit(block)
      return (
        <>
          {edits.map((eb) => (
            <ZEditCard key={eb.id} b={eb} />
          ))}
          {internal && <ToolGroup tools={[internal]} />}
        </>
      )
    }
    return <ToolGroup tools={[block]} />
  }
  if (block.kind === 'thinking' && block.text.trim() === '') return <></>
  return <RowContent row={{ type: 'block', id: block.id, block, turn: 0 }} sessionId={sessionId} />
})

const RowContent = memo(function RowContent({
  row,
  sessionId,
  autoOpen = false
}: {
  row: Row
  sessionId: string
  autoOpen?: boolean
}): React.JSX.Element {
  if (row.type === 'group') return <ToolGroup tools={row.tools} autoOpen={autoOpen} />
  if (row.type === 'edit') return <ZEditCard b={row.block} />
  const block = row.block
  switch (block.kind) {
    case 'user':
      return <UserMessage block={block} sessionId={sessionId} />
    case 'assistant':
      return <MarkdownText text={block.text} streaming={block.streaming} />
    case 'thinking':
      return (
        <ThinkingBlock text={block.text} streaming={block.streaming} thoughtMs={block.thoughtMs} />
      )
    case 'approval':
      return <ApprovalCard block={block} sessionId={sessionId} />
    case 'question':
      return <QuestionCard block={block} sessionId={sessionId} />
    case 'compaction':
      return <CompactionCard block={block} />
    case 'error':
      return <ErrorChip text={block.text} />
    default:
      return <></>
  }
})

export function Transcript({
  sessionId,
  className,
  minimap = true
}: {
  sessionId: string
  className?: string
  /** false: hide the left minimap rail (tight surfaces like agent detail). */
  minimap?: boolean
}): React.JSX.Element {
  const blocks = useApp((s) => s.blocks[sessionId]) ?? []
  const status = useApp((s) => s.sessions[sessionId]?.status)
  const loaded = useApp((s) => !!s.loaded[sessionId])
  const rows = useMemo(() => rowsFor(blocks), [blocks])
  // In-thread liveness: the model is working with nothing visible yet —
  // hidden reasoning, or the beat right after a send. A trailing status
  // row sits where the next content will land, so it's replaced by it,
  // never yanked out from above.
  const lastBlock = blocks.at(-1)
  const thinkingTail =
    (status === 'running' || status === 'starting') &&
    (!lastBlock ||
      lastBlock.kind === 'user' ||
      (lastBlock.kind === 'thinking' && lastBlock.text.trim() === ''))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null)
  const [pill, setPill] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const railWindowRef = useRef<HTMLDivElement>(null)

  /** The viewport window on the minimap — driven by direct DOM writes so
   *  scrolling never re-renders React. */
  const positionRailWindow = (): void => {
    const el = scrollRef.current
    const rail = railRef.current
    const win = railWindowRef.current
    if (!el || !rail || !win) return
    const total = Math.max(1, el.scrollHeight)
    const h = rail.clientHeight
    const top = (el.scrollTop / total) * h
    const height = Math.max(10, (el.clientHeight / total) * h)
    win.style.transform = `translateY(${Math.min(top, h - height)}px)`
    win.style.height = `${height}px`
  }

  // Scroll engine state (refs — per-frame, never re-renders).
  const mode = useRef<'follow' | 'parked' | 'free'>('follow')
  const parkedRow = useRef<number | null>(null)
  const glide = useRef<{ from: number; target: () => number; start: number } | null>(null)
  const velocity = useRef(0)
  // Counter, not a boolean: several engine writes can land before their
  // scroll events drain, and each event must consume exactly one credit or
  // the surplus reads as user intent and releases the parked hold.
  const programmatic = useRef(0)
  const raf = useRef(0)
  const prevLen = useRef(0)
  const initialCount = useRef(blocks.length)
  // A freshly opened session stays glued to the end (instant, no spring)
  // while the virtualizer's estimates settle into measured heights; the
  // first real user scroll or own send unpins it.
  const pinBottom = useRef(true)

  const virtualizer = useVirtualizer({
    count: rows.length + (thinkingTail ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 10,
    getItemKey: (i) => rows[i]?.id ?? 'thinking-tail'
  })

  // Raw item start — NOT getOffsetForIndex, which clamps to the current
  // max scroll and lies while the runway spacer is still being reserved.
  const offsetOf = (index: number): number => {
    const cache = (
      virtualizer as unknown as { measurementsCache?: { index: number; start: number }[] }
    ).measurementsCache
    const m = cache?.[index]
    if (m && m.index === index) return m.start
    const item = virtualizer.getVirtualItems().find((i) => i.index === index)
    return item?.start ?? 0
  }

  // Runway spacer: after an own send, reserve viewport − inset − pad below
  // the sent prompt so it can park at the top while the reply streams in.
  const [spacer, setSpacerState] = useState(0)
  const spacerRef = useRef(0)
  const spacerAnim = useRef(0)
  const setSpacer = (v: number): void => {
    spacerRef.current = v
    setSpacerState(v)
  }
  /** Retire the runway: instantly when the blank pad sits below the
   *  viewport (nothing visible changes), otherwise a 220ms ease-out tween —
   *  the browser clamps scrollTop each frame, so the view glides, never
   *  snaps, even after a short reply left most of the runway empty. */
  const collapseSpacer = (): void => {
    cancelAnimationFrame(spacerAnim.current)
    const from = spacerRef.current
    if (from === 0) return
    const el = scrollRef.current
    if (el && el.scrollHeight - el.clientHeight - el.scrollTop > from) {
      setSpacer(0)
      return
    }
    const t0 = performance.now()
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / 220)
      setSpacer(Math.round(from * Math.pow(1 - p, 3)))
      if (p < 1) spacerAnim.current = requestAnimationFrame(tick)
    }
    spacerAnim.current = requestAnimationFrame(tick)
  }
  const totalSize = virtualizer.getTotalSize()

  const running = status === 'running' || status === 'starting'
  const runningRef = useRef(false)
  useEffect(() => {
    runningRef.current = running
    // Turn settled: release the parked hold COMPLETELY — the mode, the
    // parked row, and the runway. Leaving parkedRow set kept the spacer
    // effect regrowing the runway on any later height change (expanding a
    // group), which read as phantom blank space below the transcript and a
    // "scroll to bottom" pill while already at the bottom.
    if (!running) {
      if (mode.current === 'parked') mode.current = 'free'
      parkedRow.current = null
      collapseSpacer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable helpers
  }, [running])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinBottom.current) el.scrollTop = el.scrollHeight - el.clientHeight
    if (!el || parkedRow.current === null) return
    const idx = parkedRow.current
    if (idx >= rows.length) return
    const inset = idx === 0 ? 0 : TOP_INSET
    const runway = el.clientHeight - inset - BASE_PAD
    const below = totalSize - offsetOf(idx)
    const next = Math.max(0, runway - below)
    if (Math.abs(next - spacer) > 1) setSpacer(next)
  }, [totalSize, rows.length, spacer])

  const setScrollTop = (v: number): void => {
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(el.scrollTop - v) < 0.5) return
    programmatic.current++
    el.scrollTop = v
  }

  /** 500ms ease-in-out glide to a (live) target, capped at 2.5 viewports. */
  const startGlide = (target: () => number): void => {
    const el = scrollRef.current
    if (!el) return
    let from = el.scrollTop
    const cap = el.clientHeight * MAX_GLIDE_VIEWPORTS
    const t0 = target()
    if (Math.abs(t0 - from) > cap) from = t0 - Math.sign(t0 - from) * cap
    glide.current = { from, target, start: performance.now() }
  }

  // The per-frame engine: glides, parked hold, stick-to-bottom spring
  // (damping 0.7, stiffness 0.05, mass 1.25 — Zeron's exact tuning).
  useEffect(() => {
    const tick = (): void => {
      raf.current = requestAnimationFrame(tick)
      const el = scrollRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      if (glide.current) {
        const g = glide.current
        const p = Math.min(1, (performance.now() - g.start) / GLIDE_MS)
        setScrollTop(g.from + (Math.min(max, g.target()) - g.from) * easeInOut(p))
        if (p >= 1) glide.current = null
        return
      }
      if (mode.current === 'parked' && parkedRow.current !== null) {
        const inset = parkedRow.current === 0 ? 0 : TOP_INSET
        const want = Math.min(max, Math.max(0, offsetOf(parkedRow.current) - inset))
        if (Math.abs(el.scrollTop - want) > 1) setScrollTop(want)
        return
      }
      // The stick-to-bottom spring only chases while a reply is streaming —
      // when the transcript is idle, height changes (opening or closing a
      // section) must never scroll the view.
      if (mode.current === 'follow' && runningRef.current) {
        const dist = max - el.scrollTop
        if (dist > AT_BOTTOM) {
          // Per-frame spring toward the bottom (damping 0.7, stiffness 0.05,
          // mass 1.25), chase lead capped at 32px.
          velocity.current = (velocity.current + (dist * 0.05) / 1.25) * 0.7
          let next = el.scrollTop + velocity.current
          next = Math.max(next, max - 32)
          setScrollTop(Math.min(next, max))
        } else {
          velocity.current = 0
        }
      }
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [sessionId])

  // User intent: ONLY a real wheel/drag (or scroll keys) releases the
  // parked hold — bare scroll events also come from the engine and from
  // the virtualizer's own measurement adjustments, so they never release.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let draggingBar = false
    /** dir < 0 = the user is heading up: always break to free — never let
     *  the spring fight an upward scroll. dir >= 0 = heading down: rejoin
     *  follow within the stick threshold. Any release ends the parked hold
     *  and collapses the runway spacer. */
    const release = (dir: number): void => {
      glide.current = null
      velocity.current = 0
      parkedRow.current = null
      pinBottom.current = false
      collapseSpacer()
      const fromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
      mode.current = dir < 0 ? 'free' : fromBottom < STICK_THRESHOLD ? 'follow' : 'free'
    }
    const onWheel = (e: WheelEvent): void => release(e.deltaY)
    const onPointerDown = (e: PointerEvent): void => {
      // A press on the scrollbar gutter starts a drag.
      draggingBar = e.offsetX >= el.clientWidth
    }
    const onPointerUp = (): void => {
      draggingBar = false
    }
    const onKey = (e: KeyboardEvent): void => {
      if (['PageUp', 'Home', 'ArrowUp'].includes(e.key)) release(-1)
      else if (['PageDown', 'End', 'ArrowDown'].includes(e.key)) release(1)
    }
    const onScroll = (): void => {
      const fromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
      // The runway spacer is blank padding, not content — the pill only
      // cares about real transcript below the fold.
      setPill(fromBottom - spacerRef.current > PILL_AT)
      positionRailWindow()
      if (programmatic.current > 0) {
        programmatic.current--
        return
      }
      if (draggingBar) release(1)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    el.addEventListener('keydown', onKey)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('scroll', onScroll)
    }
  }, [sessionId])

  // Own send: park the prompt 10px under the titlebar (48px inset; none for
  // the very first message) and reserve the runway beneath it.
  useLayoutEffect(() => {
    const appended = blocks.length > prevLen.current
    prevLen.current = blocks.length
    const last = blocks.at(-1)
    if (!appended || last?.kind !== 'user') return
    const rowIdx = rows.length - 1
    parkedRow.current = rowIdx
    mode.current = 'parked'
    pinBottom.current = false
    cancelAnimationFrame(spacerAnim.current)
    velocity.current = 0
    const el = scrollRef.current
    if (el) {
      const inset = rowIdx === 0 ? 0 : TOP_INSET
      startGlide(() => Math.max(0, offsetOf(rowIdx) - inset))
    }
  }, [blocks.length, rows.length])

  // New session: jump straight to the end, no animation.
  useLayoutEffect(() => {
    mode.current = 'follow'
    parkedRow.current = null
    glide.current = null
    pinBottom.current = true
    velocity.current = 0
    prevLen.current = blocks.length
    initialCount.current = blocks.length
    cancelAnimationFrame(spacerAnim.current)
    setSpacer(0)
    const el = scrollRef.current
    if (el) setScrollTop(el.scrollHeight - el.clientHeight)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only
  }, [sessionId])

  // Tab switches select instantly; a big backlog still fetching shows a
  // quiet centered spinner instead of a blank plane that pops full.
  if (!loaded && rows.length === 0) {
    return (
      <div className={cn('relative flex min-h-0 flex-1 items-center justify-center', className)}>
        <Spinner className="size-4 text-muted-foreground/60 animate-[z-fade-quick_300ms_ease-out]" />
      </div>
    )
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto select-text [overflow-anchor:none]"
        onMouseLeave={() => setHoveredTurn(null)}
      >
        <div
          className="relative mx-auto w-full max-w-[736px] px-6"
          style={{ height: totalSize + spacer + BASE_PAD }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) {
              // The trailing "Thinking" status — quiet text, no tile, no
              // chevron; the next real row takes this exact spot.
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute right-6 left-6"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div className="flex h-[26px] items-center px-1 py-1">
                    <TextShimmer className="text-xs">Thinking</TextShimmer>
                  </div>
                </div>
              )
            }
            const isUser = row.type === 'block' && row.block.kind === 'user'
            const fresh = item.index === rows.length - 1 && blocks.length > initialCount.current
            // Timestamp strip: under a user bubble, or under the last row of
            // a settled assistant turn, revealed by hovering the turn.
            const nextRow = rows[item.index + 1]
            const endsTurn = !nextRow || nextRow.turn !== row.turn
            const settled =
              row.type === 'group'
                ? !running
                : row.block.kind === 'assistant' && !row.block.streaming
            const lastOfTurn = isUser || (endsTurn && settled)
            const ts = row.type === 'group' ? row.tools.at(-1)?.ts : row.block.ts
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute right-6 left-6"
                style={{ transform: `translateY(${item.start}px)` }}
                onMouseEnter={() => setHoveredTurn(row.turn)}
              >
                <div
                  className={cn(
                    // Block gap 8, turn gap 14 (user rows carry the extra).
                    isUser ? 'py-2.5' : 'py-1',
                    fresh && 'animate-[z-fade-in_500ms_cubic-bezier(0.16,1,0.3,1)]'
                  )}
                >
                  {/* The active group — tools still streaming into it,
                      nothing after — rides open; the next text block
                      bumps it off the end and it folds. */}
                  <RowContent
                    row={row}
                    sessionId={sessionId}
                    autoOpen={row.type === 'group' && item.index === rows.length - 1 && running}
                  />
                  {/* hover-revealed 16px timestamp strip */}
                  {lastOfTurn && ts !== undefined && (
                    <div
                      className={cn(
                        'flex h-4 items-end text-[11px] leading-none text-faint transition-opacity duration-150',
                        isUser && 'justify-end',
                        hoveredTurn === row.turn ? 'opacity-100' : 'opacity-0'
                      )}
                    >
                      {fmtTs(ts)}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* bottom fade: the transcript melts into the panel over 24px */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />

      {/* scroll-to-bottom pill — raised opaque plate, appears past 320px */}
      <div
        className={cn(
          'absolute bottom-3 left-1/2 -translate-x-1/2 transition-all duration-150',
          pill ? 'opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
        )}
      >
        <button
          onClick={() => {
            mode.current = 'follow'
            parkedRow.current = null
            collapseSpacer()
            const el = scrollRef.current
            if (el) startGlide(() => el.scrollHeight - el.clientHeight)
          }}
          className="flex h-7 items-center gap-1.5 rounded-full bg-secondary px-3 text-xs text-secondary-foreground transition-colors duration-150 hover:bg-secondary-hover"
        >
          <ZIcon name="arrow-down" size={11} />
          Scroll to bottom
        </button>
      </div>

      {/* left rail: the thread at a glance — every row a tick (yours in
          blue, finalized replies solid, mechanics faint), the viewport as
          a sliding window, hover for an instant who-said-what preview. */}
      {minimap && rows.length > 1 && (
        <Minimap
          rows={rows}
          totalSize={totalSize}
          railRef={railRef}
          windowRef={railWindowRef}
          onLayout={positionRailWindow}
          offsetOf={offsetOf}
          onJump={(i) => {
            mode.current = 'free'
            parkedRow.current = null
            pinBottom.current = false
            collapseSpacer()
            startGlide(() => Math.max(0, offsetOf(i) - TOP_INSET))
          }}
        />
      )}
    </div>
  )
}

/** The transcript minimap. Ticks sit at their row's true document
 *  position; the window div is written directly from the scroll handler.
 *  Hover state lives HERE so previews never re-render the transcript. */
function Minimap({
  rows,
  totalSize,
  railRef,
  windowRef,
  onLayout,
  offsetOf,
  onJump
}: {
  rows: Row[]
  totalSize: number
  railRef: React.RefObject<HTMLDivElement | null>
  windowRef: React.RefObject<HTMLDivElement | null>
  onLayout: () => void
  offsetOf: (index: number) => number
  onJump: (index: number) => void
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  // Compact stack for short threads, fixed proportional map for long ones.
  const railH = Math.min(Math.max(rows.length * 9, 48), 320)
  const total = Math.max(1, totalSize)

  useLayoutEffect(onLayout, [railH, totalSize, onLayout])

  const glance = hover !== null && rows[hover] ? rowGlance(rows[hover]) : null
  const hoverTop = hover !== null ? (offsetOf(hover) / total) * railH : 0

  return (
    <div
      className="absolute top-1/2 left-3 z-10 -translate-y-1/2"
      onMouseLeave={() => setHover(null)}
    >
      <div ref={railRef} className="relative w-5" style={{ height: railH }}>
        {/* viewport window */}
        <div
          ref={windowRef}
          className="pointer-events-none absolute -left-1 w-7 rounded-[4px] bg-foreground/[0.07] ring-1 ring-foreground/10"
        />
        {rows.map((r, i) => {
          const g = rowGlance(r)
          const t = TICK[g.kind]
          const top = (offsetOf(i) / total) * railH
          return (
            <button
              key={r.id}
              aria-label={`Jump to ${g.who}: ${g.text.slice(0, 40)}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onJump(i)}
              className="absolute left-0 flex h-[9px] w-6 items-center"
              style={{ top: Math.min(top, railH - 9) }}
            >
              <span
                className={cn(
                  'h-[2px] rounded-full transition-[width,opacity] duration-100',
                  t.cls,
                  hover === i && 'opacity-100'
                )}
                style={{ width: hover === i ? t.w + 4 : t.w }}
              />
            </button>
          )
        })}

        {/* instant hover preview */}
        {glance && (
          <div
            className="pointer-events-none absolute left-8 z-20 -translate-y-1/2 animate-[z-fade-quick_80ms_ease-out]"
            style={{ top: Math.max(10, Math.min(hoverTop + 4, railH - 10)) }}
          >
            <div className="flex max-w-64 items-baseline gap-1.5 rounded-lg bg-popover px-2.5 py-1.5 whitespace-nowrap shadow-[0_4px_16px_rgb(0_0_0/0.14)] ring-1 ring-foreground/10">
              <span
                className={cn(
                  'shrink-0 text-[10px] font-semibold tracking-wide uppercase',
                  g_who_cls(glance.kind)
                )}
              >
                {glance.who}
              </span>
              <span className="min-w-0 truncate text-[11.5px] text-foreground/85">
                {glance.text || '\u2026'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function g_who_cls(kind: GlanceKind): string {
  switch (kind) {
    case 'user':
      return 'text-info'
    case 'edit':
      return 'text-success'
    case 'alert':
      return 'text-warning'
    default:
      return 'text-muted-foreground'
  }
}
