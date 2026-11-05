import type { ApprovalHandler, HandoffHandler, SecondOpinionHandler } from "./transcript/types";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { perfMark } from "../lib/perfMarks";
import { harnessForTurn } from "../lib/secondOpinion";
import { TranscriptOutline } from "./TranscriptOutline";
import {
  COLUMN_MAX_CLASS,
  LIST_SPACE,
  createReaderStore,
  outlineEntries,
  outlinePlacement,
  type OutlinePlacement,
} from "./transcriptOutlineModel";
import type { JumpHow } from "../chrome/JumpList";
import {
  RowLayout,
  anchorShift,
  rangeCovers,
  type RowAnchor,
  type RowRange,
} from "../lib/transcriptWindow";
import { useKept } from "../lib/keptValue";
import { RevealTurnContext } from "./revealDrain";
import { estimateRowHeight, flattenTurns, rowKeyOf, sameRow, turnUserBlock, type RowGap, type TranscriptRow } from "./transcriptRows";
import { useReducedMotion } from "motion/react";
import { cubicBezier, DUR, EASE_DRAWER, EASE_OUT } from "../lib/ease";
import { type Block, type HarnessId } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import { ParkPendingContext, TurnStateContext, type TurnSession } from "./turnState";
import { isTurnHeld } from "../lib/turnClock";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePaneVisible } from "../hooks/paneVisibility";
import { saveTranscriptScroll, takeTranscriptScroll, type TranscriptScrollMemory } from "../lib/transcriptScrollMemory";
import { blockForSeq, pendingTranscriptJump, subscribeTranscriptJump, takeTranscriptJump } from "../lib/transcriptJump";
import { useTranscriptAnchor } from "../hooks/useTranscriptAnchor";
import { useTranscriptSelection } from "../hooks/useTranscriptSelection";
import { SelectSessionContext } from "./AgentMarkdown";
import type { OpenFileFn } from "../lib/search";
import { RowBornContext, TranscriptSessionContext } from "./transcriptSession";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";
import { groupTurns } from "./transcriptActivity";
import { TurnEnd } from "./transcript/TurnEnd";
import { ActionGroup } from "./transcript/ActionGroup";
import { Button } from "../components/ui/button";
import { TranscriptBlock } from "./transcript/TranscriptBlock";
/*
 * One scroll engine (ported from temp-code). Three modes: `follow` rides the
 * bottom on a spring, `parked` holds the prompt at the top of the viewport
 * over a runway spacer while the answer grows, `free` leaves the reader
 * alone. Only wheel, scrollbar drags and keys release a mode; the engine's
 * own writes never do.
 */
const TOP_INSET = 12;
const STICK_THRESHOLD = 70;
const PILL_AT = 320;
const MAX_GLIDE_VIEWPORTS = 2.5;
const FOLLOW_LEAD = 32;
/** A glide the engine runs itself (docs/DESIGN.md "Motion values"): a jump,
 *  a burst while following and a jump to a row on `DUR.drawer` `EASE_OUT`;
 *  the park on send on `DUR.drawer` `EASE_DRAWER`; the runway's retirement
 *  on `DUR.base` `EASE_OUT`. */
const GLIDE = { ms: DUR.drawer * 1000, curve: cubicBezier(EASE_OUT) };
const PARK = { ms: DUR.drawer * 1000, curve: cubicBezier(EASE_DRAWER) };
const RUNWAY = { ms: DUR.base * 1000, curve: cubicBezier(EASE_OUT) };

/*
 * The viewport window. The thread is a flat list of rows (transcriptRows.ts)
 * laid out by estimated, then measured, heights (lib/transcriptWindow.ts).
 * Only the rows that meet the viewport, plus a screen of overscan each way,
 * are mounted, each absolutely placed at its offset (`top`, not a transform:
 * a transform per row is a compositing node per row, and Chromium's
 * layerize step then costs about 2 ms on every streamed token) inside a
 * container the height of the whole thread. One ResizeObserver measures every mounted
 * row: a measurement writes the container height and the offsets below it
 * straight to the DOM, and moves the scroll offset by the growth of the rows
 * above the reader's row, so nothing under the eye moves. The tail row
 * growing while streaming changes its own box and the container's height
 * and nothing else: the rows above are never laid out again. The window
 * re-renders only when the viewport leaves the middle of what is mounted.
 */
/** Overscan on each side, in px: a screen, or this when the screen is small. */
const MIN_OVERSCAN = 400;

type ScrollMode = "follow" | "parked" | "free";

type Motion = { readonly ms: number; readonly curve: (t: number) => number };
/** A glide of the scroll offset: its curve and length, and whether it parks
 *  a prompt (the runway retargets that one as the answer grows under it). */
type Glide = { from: number; to: number; start: number; park: boolean } & Motion;

/**
 * Whether a scroll-up left behind by an earlier mount — the reader's own,
 * or memory from a cold remount — is worth putting back on open. Only
 * while the run is still going: a settled thread has nothing left to watch
 * from up there, so it opens at the bottom regardless of where it was left.
 */
export function shouldRestoreScroll(
  saved: TranscriptScrollMemory | undefined,
  busy: boolean | undefined,
): boolean {
  return !!saved && !!busy;
}

type Props = {
  blocks: Block[];
  /** the session shown, for rows that remember state per session */
  sessionId?: string;
  /** Timer and outcome state for the last turn: one clock, one source. */
  turn?: TurnSession | null;
  busy?: boolean;
  cwd?: string;
  harness?: HarnessId;
  onApproval?: ApprovalHandler;
  onAddToChat?: (text: string) => void;
  onSaveNote?: (text: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  /** Opens a thread mentioned as `@thread:<id>`. */
  onSelectSession?: (sessionId: string) => void;
  onSecondOpinion?: SecondOpinionHandler;
  onHandoff?: HandoffHandler;
  onJumpToBottomChange?: (show: boolean) => void;
  onJumpToBottomReady?: (jump: () => void) => void;
  /** Where the column sits beside the message list, for a footer that
   *  lines its own column up with it (chatSlots.tsx). */
  onPlacementChange?: (placement: OutlinePlacement) => void;
  /** False while another tab is in front. Hidden tabs stay laid out. */
  visible?: boolean;
  /** The live turn's state line (Working, Needs you, Paused). Off where the
   *  slot above the composer holds the timer; the watching line under the last
   *  settled turn shows either way. */
  liveState?: boolean;
  /** The watching line's click: the right panel's Activity section. Stable, or every row re-renders. */
  onOpenActivity?: () => void;
};

export function AgentTranscript({
  blocks,
  sessionId,
  turn: turnState,
  busy,
  cwd,
  harness,
  onApproval,
  onAddToChat,
  onSaveNote,
  onOpenFile,
  onOpenDiff,
  onSelectSession,
  onSecondOpinion,
  onHandoff,
  onJumpToBottomChange,
  onJumpToBottomReady,
  onPlacementChange,
  visible: visibleProp = true,
  liveState = true,
  onOpenActivity,
}: Props) {
  // A parked pane keeps its transcript mounted; the context turns it off.
  const visible = visibleProp && usePaneVisible();
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  // The rows' wrapper: the scroller's content, after the message list's
  // zero-height wrapper.
  const inner = useRef<HTMLDivElement>(null);
  const showJumpRef = useRef(false);
  const wasVisible = useRef(false);
  const everVisible = useRef(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion() === true;
  // Engine state lives in refs: the rAF loop reads and writes it without a
  // render, and nothing here changes what React draws.
  const mode = useRef<ScrollMode>("follow");
  const parkedTurn = useRef<HTMLElement | null>(null);
  const glide = useRef<Glide | null>(null);
  const velocity = useRef(0);
  const expectedTop = useRef(-1);
  const dragging = useRef(false);
  const spacerH = useRef(0);
  const spacerAnim = useRef<{ from: number; start: number } | null>(null);
  const raf = useRef(0);
  // Glue to the bottom until the reader shows intent: history loading in
  // pages must not drift a fresh transcript off its end.
  const pinBottom = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // The window: the layout of every row, the mounted range, the mounted
  // elements by row key, the reader's anchor row, and a jump still landing.
  const layoutRef = useRef<RowLayout | null>(null);
  if (!layoutRef.current) layoutRef.current = new RowLayout();
  const rowLayout = layoutRef.current;
  const [mounted, setMounted] = useState<RowRange>({ start: 0, end: 0 });
  const mountedRef = useRef(mounted);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const rowObserver = useRef<ResizeObserver | null>(null);
  const anchorRef = useRef<RowAnchor | null>(null);
  const landing = useRef<string | null>(null);
  // The message list: the reader's turn (written only on a change, so a
  // scroll renders the list alone) and where the list sits.
  const reader = useRef(createReaderStore()).current;
  const paneWidth = useRef(0);
  const [placement, setPlacement] = useState<OutlinePlacement>("hidden");
  useLayoutEffect(() => {
    onPlacementChange?.(placement);
  }, [placement, onPlacementChange]);
  const { selection, dismissSelection } = useTranscriptSelection(
    scrollerEl,
    onAddToChat !== undefined,
  );
  const promptAnchor = useTranscriptAnchor();
  const lastUserId = lastUserBlockId(blocks);
  const setShowJump = useCallback(
    (show: boolean) => {
      if (showJumpRef.current === show) return;
      showJumpRef.current = show;
      onJumpToBottomChange?.(show);
    },
    [onJumpToBottomChange],
  );

  /** For a bubble deciding its entrance: is the engine parking its prompt? */
  const isParking = useCallback(() => mode.current === "parked", []);

  const setMode = (next: ScrollMode) => {
    mode.current = next;
    const el = scroller.current;
    if (el && el.dataset.scrollMode !== next) el.dataset.scrollMode = next;
  };

  const setSpacer = (h: number) => {
    spacerH.current = h;
    const el = spacer.current;
    if (el) el.style.height = `${h}px`;
  };

  /**
   * Mount what the viewport needs. The rows mounted stretch a screen past
   * the viewport each way; a render is due only when the viewport comes
   * within half a screen of their edge, or they reach more than two screens
   * past it. A scroller with no layout (a parked tab) keeps what it has.
   */
  const reconcileWindow = useCallback(
    (el: HTMLElement) => {
      const height = el.clientHeight;
      if (height === 0) return;
      const overscan = Math.max(MIN_OVERSCAN, height);
      const need = rowLayout.range(el.scrollTop, height, overscan / 2);
      const far = rowLayout.range(el.scrollTop, height, overscan * 2);
      const current = mountedRef.current;
      if (rangeCovers(current, need) && current.start >= far.start && current.end <= far.end) return;
      const next = rowLayout.range(el.scrollTop, height, overscan);
      if (next.start === current.start && next.end === current.end) return;
      mountedRef.current = next;
      setMounted(next);
    },
    [rowLayout],
  );

  /** The container's height and the offsets of the mounted rows from `from`
   *  on, written straight to the DOM; React writes the same values next
   *  time it renders. */
  const writeOffsets = useCallback(
    (from: number) => {
      const box = container.current;
      if (box) box.style.height = `${rowLayout.total()}px`;
      const { start, end } = mountedRef.current;
      for (let i = Math.max(from, start); i < end; i++) {
        const key = rowLayout.keyAt(i);
        const el = key === undefined ? undefined : rowEls.current.get(key);
        if (el) el.style.top = `${rowLayout.offsetOf(i)}px`;
      }
    },
    [rowLayout],
  );

  /** A scroll write of our own; the scroll handler knows it by its value. */
  const scrollTo = (el: HTMLElement, top: number) => {
    el.scrollTop = top;
    expectedTop.current = el.scrollTop;
    anchorRef.current = rowLayout.anchorAt(el.scrollTop);
    reconcileWindow(el);
  };

  /** A jump's last step: once its row is mounted and measured, land on it
   *  exactly (the glide aimed at an estimate). */
  const land = (el: HTMLElement) => {
    const key = landing.current;
    if (!key) return;
    const index = rowLayout.indexOf(key);
    if (index < 0) {
      landing.current = null;
      return;
    }
    if (!rowLayout.hasMeasured(key)) return;
    landing.current = null;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const top = Math.min(max, Math.max(0, rowLayout.offsetOf(index) - TOP_INSET));
    if (Math.abs(top - el.scrollTop) > 1) scrollTo(el, top);
  };

  /** Heights read once at the top of a frame, before that frame writes. */
  type Extent = { readonly scrollHeight: number; readonly clientHeight: number };

  const fromBottomOf = (el: HTMLElement, ext: Extent = el) =>
    ext.scrollHeight - el.scrollTop - ext.clientHeight;

  /** The reader's turn for the message list: the row a third of the way
   *  down the viewport; the first turn at the top of the thread and the last
   *  at its end. */
  const syncReader = useCallback(
    (el: HTMLElement, ext?: Extent) => {
      const turnCount = turnsRef.current.length;
      if (turnCount === 0) return;
      if (fromBottomOf(el, ext) - spacerH.current <= STICK_THRESHOLD) {
        reader.set(turnCount - 1);
        return;
      }
      const clientHeight = ext?.clientHeight ?? el.clientHeight;
      const y = el.scrollTop < 1 ? 0 : el.scrollTop + clientHeight / 3;
      const row = rowsRef.current[rowLayout.indexAt(y)];
      reader.set(row && row.kind !== "more" ? row.turn.index : 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reader, rowLayout],
  );

  const syncPill = useCallback(
    (el: HTMLElement, ext?: Extent) => {
      setShowJump(
        mode.current !== "follow" &&
          fromBottomOf(el, ext) - spacerH.current > PILL_AT,
      );
      syncReader(el, ext);
    },
    [setShowJump, syncReader],
  );

  const tickRef = useRef<(now: number) => void>(() => {});
  const schedule = useCallback(() => {
    if (raf.current || !visibleRef.current) return;
    raf.current = requestAnimationFrame((now) => tickRef.current(now));
  }, []);

  const tick = useCallback((now: number) => {
    raf.current = 0;
    const el = scroller.current;
    if (!el) return;
    // One layout read per frame, taken before the spacer write below dirties
    // it. The spacer is the only thing this frame resizes, so its delta keeps
    // the content height current without a second layout.
    const clientHeight = el.clientHeight;
    let scrollHeight = el.scrollHeight;
    let again = false;
    const anim = spacerAnim.current;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / RUNWAY.ms);
      const before = spacerH.current;
      setSpacer(anim.from * (1 - RUNWAY.curve(t)));
      scrollHeight += spacerH.current - before;
      if (t < 1) again = true;
      else spacerAnim.current = null;
    }
    const g = glide.current;
    if (g) {
      const t = Math.min(1, (now - g.start) / g.ms);
      scrollTo(el, g.from + (g.to - g.from) * g.curve(t));
      if (t < 1) again = true;
      else {
        glide.current = null;
        velocity.current = 0;
        land(el);
      }
    } else if (mode.current === "follow") {
      const max = scrollHeight - clientHeight;
      const dist = max - el.scrollTop;
      if (dist > clientHeight / 2 && !reduceMotion) {
        // A burst (a code block landing whole) is too far for the spring's
        // 32 px lead: glide there instead of snapping.
        glide.current = { from: el.scrollTop, to: max, start: now, park: false, ...GLIDE };
        again = true;
      } else if (dist > 2) {
        velocity.current = (velocity.current + (dist * 0.05) / 1.25) * 0.7;
        const next = Math.max(el.scrollTop + velocity.current, max - FOLLOW_LEAD);
        scrollTo(el, Math.min(next, max));
        again = true;
      } else {
        // Sub-pixel steps round away on a retina scroller; land exactly.
        if (dist > 0) scrollTo(el, max);
        velocity.current = 0;
      }
      // Settled, the loop rests, running thread or not: new rows, the
      // content growing, a resize and the reader's input start it again.
    }
    syncPill(el, { scrollHeight, clientHeight });
    if (again) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, schedule, syncPill]);
  tickRef.current = tick;

  /**
   * The runway under a parked turn: room for the prompt to sit at the top.
   * While the park glide runs, the runway is laid and the glide's target
   * moves with it; the glide owns the offset. Otherwise the offset is
   * written here, unless `write` is off (the park glide about to start).
   */
  const layoutRunway = useCallback((write = true) => {
    const el = scroller.current;
    const turn = parkedTurn.current;
    const content = inner.current;
    if (!el || !turn || !content) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const turnTop = turn.getBoundingClientRect().top - base;
    const below = content.getBoundingClientRect().bottom - base - turnTop;
    setSpacer(Math.max(0, el.clientHeight - TOP_INSET - below));
    const top = parkTopOf(turn, turnTop);
    const g = glide.current;
    if (g?.park) g.to = top;
    else if (write) scrollTo(el, top);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Where a parked prompt's row sits: its offset in the layout when it is
   *  a row there (exact without a layout pass), else its measured top. */
  const parkTopOf = (turn: HTMLElement, measuredTop: number): number => {
    const index = turn.dataset.row === undefined ? -1 : rowLayout.indexOf(turn.dataset.row);
    return (index >= 0 ? rowLayout.offsetOf(index) : measuredTop) - TOP_INSET;
  };

  /** Retire the runway: at once if it sits below the fold, else a short tween. */
  const collapseSpacer = useCallback(() => {
    const el = scroller.current;
    if (!el || spacerH.current <= 0) return;
    const padTop = el.scrollHeight - spacerH.current;
    if (reduceMotion || padTop >= el.scrollTop + el.clientHeight) {
      spacerAnim.current = null;
      setSpacer(0);
      return;
    }
    spacerAnim.current = { from: spacerH.current, start: performance.now() };
    schedule();
  }, [reduceMotion, schedule]);

  /**
   * Glide the offset to `to` on `motion` (a jump's, by default). A target
   * past the scroll range is clamped, except a park's: its runway is laid
   * first and moves its target as it grows. A glide longer than 2.5 screens
   * starts that far short, so the rows it passes are the ones that mount.
   */
  const startGlide = useCallback(
    (to: number, motion: Motion = GLIDE, park = false) => {
      const el = scroller.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      to = Math.max(0, park ? to : Math.min(max, to));
      if (reduceMotion) {
        scrollTo(el, to);
        return;
      }
      const cap = MAX_GLIDE_VIEWPORTS * el.clientHeight;
      let from = el.scrollTop;
      if (Math.abs(to - from) > cap) {
        from = to + Math.sign(from - to) * cap;
        scrollTo(el, from);
      }
      glide.current = { from, to, start: performance.now(), park, ...motion };
      velocity.current = 0;
      schedule();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduceMotion, schedule],
  );

  /** The reader took the wheel: no mode moves the viewport under them. */
  const release = useCallback(() => {
    glide.current = null;
    landing.current = null;
    pinBottom.current = false;
    parkedTurn.current = null;
    setMode("free");
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    parkedTurn.current = null;
    landing.current = null;
    setMode("follow");
    spacerAnim.current = null;
    setSpacer(0);
    setShowJump(false);
    startGlide(el.scrollHeight - el.clientHeight);
  }, [setShowJump, startGlide]);

  const glideTo = useCallback(
    (target: HTMLElement) => {
      const el = scroller.current;
      if (!el) return;
      release();
      const top =
        target.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop;
      landing.current = target.dataset.row ?? null;
      startGlide(top - TOP_INSET);
    },
    [release, startGlide],
  );

  /**
   * Glide to a row by index. A mounted row is measured, so the glide aims
   * at its box; one outside the window aims at its estimated offset and
   * lands exactly once it is mounted and measured (`land`). Either way the
   * glide teleports to within 2.5 screens first, so the rows it passes are
   * the ones that mount. `instant` (a keyboard jump) writes the offset at
   * once and lands the same way: a key is never animated.
   */
  const scrollToRow = useCallback(
    (index: number, options: { instant?: boolean } = {}) => {
      const el = scroller.current;
      const key = rowLayout.keyAt(index);
      if (!el || key === undefined) return;
      if (options.instant) {
        release();
        landing.current = key;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        scrollTo(el, Math.min(max, Math.max(0, rowLayout.offsetOf(index) - TOP_INSET)));
        land(el);
        syncPill(el);
        return;
      }
      const target = rowEls.current.get(key);
      if (target) {
        glideTo(target);
        return;
      }
      release();
      landing.current = key;
      startGlide(rowLayout.offsetOf(index) - TOP_INSET);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowLayout, glideTo, release, startGlide, syncPill],
  );

  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      setScrollerEl(el);
      lockOverscroll(el);
    },
    [lockOverscroll],
  );

  useEffect(() => {
    onJumpToBottomReady?.(jumpToBottom);
  }, [jumpToBottom, onJumpToBottomReady]);

  useEffect(() => {
    if (!scrollerEl) return;
    const el = scrollerEl;
    const onScroll = () => {
      if (el.scrollTop === expectedTop.current) return;
      anchorRef.current = rowLayout.anchorAt(el.scrollTop);
      reconcileWindow(el);
      if (dragging.current) release();
      if (mode.current === "free" && fromBottomOf(el) - spacerH.current <= STICK_THRESHOLD) {
        setMode("follow");
      }
      syncPill(el);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      release();
      if (e.deltaY > 0 && fromBottomOf(el) - spacerH.current <= STICK_THRESHOLD) {
        setMode("follow");
        schedule();
      }
      syncPill(el);
    };
    // The window listener lives only for the length of a scrollbar drag.
    const onPointerUp = () => {
      dragging.current = false;
      window.removeEventListener("pointerup", onPointerUp);
    };
    const onPointerDown = (e: PointerEvent) => {
      // The scrollbar gutter lies past the content box.
      if (e.offsetX < el.clientWidth) return;
      dragging.current = true;
      window.addEventListener("pointerup", onPointerUp);
    };
    const onKey = (e: KeyboardEvent) => {
      // The message list's keys walk the list, not the transcript.
      if ((e.target as Element | null)?.closest?.("[data-transcript-outline]")) return;
      if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") release();
      else if (e.key === "PageDown" || e.key === "End" || e.key === "ArrowDown") {
        release();
        if (e.key === "End" || fromBottomOf(el) - spacerH.current <= STICK_THRESHOLD) {
          setMode("follow");
          schedule();
        }
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("keydown", onKey);
    };
  }, [scrollerEl, rowLayout, reconcileWindow, release, schedule, syncPill]);

  // ── rows and their layout ─────────────────────────────────────────────
  const previousTurns = useRef<Block[][]>([]);
  const turns = useMemo(() => {
    const next = stableTurns(groupTurns(blocks), previousTurns.current);
    previousTurns.current = next;
    return next;
  }, [blocks]);
  // Remote profile: the next page of history comes from the server and
  // lands above; the reader's anchor row keeps them where they were.
  const moreHistory = !!sessionId && sessionStore.hasOlderHistory(sessionId);
  // A turn paused mid-way, or queued before it ran, is not over: no closing line until it settles.
  const paused = !busy && !!turnState && isTurnHeld(turnState);
  const { rows, rowOfBlock } = useMemo(
    () => flattenTurns(turns, !!busy, { loadEarlier: moreHistory, paused }),
    [turns, busy, moreHistory, paused],
  );
  // The scroll engine reads both from its frames without a render.
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The window is by index: rows landing before the tail would push the last
  // row (the live turn's line) past a window that reached it, and it would
  // drop out for a commit and mount again. A window that reached the tail
  // grows with it in the same render.
  const [tailLength, setTailLength] = useState(rows.length);
  if (tailLength !== rows.length) {
    setTailLength(rows.length);
    if (rows.length > tailLength && mounted.end >= tailLength) setMounted({ start: mounted.start, end: mounted.end + rows.length - tailLength });
  }
  useLayoutEffect(() => {
    mountedRef.current = mounted;
  }, [mounted]);
  const entryCount = useMemo(() => outlineEntries(turns).length, [turns]);
  const entryCountRef = useRef(entryCount);
  entryCountRef.current = entryCount;
  const rowOf = useCallback((blockId: string) => rowOfBlock().get(blockId), [rowOfBlock]);
  // The layout takes the rows before they render, so each mounted row's
  // offset below is read from the list it belongs to.
  useMemo(() => {
    rowLayout.setRows(rows.map((row) => ({ key: row.key, estimate: estimateRowHeight(row) })));
  }, [rows, rowLayout]);
  // Turns born after mount fade in; the ones the transcript opened with, and
  // the pages loaded above them, are already history. A row fades once, on
  // its first mount: one that leaves the window and comes back as the
  // reader scrolls is history too (`shownRows`), so nothing animates on
  // scroll.
  const initialTurns = useRef<Set<string> | null>(null);
  if (!initialTurns.current) {
    initialTurns.current = new Set(turns.map((turn) => rowKeyOf(turn[0])));
  }
  // A row that joins the live turn after open was born live: its prose
  // reveals from its first word, however much its first commit carried. One
  // there at open, one of a page loaded above (never the last turn) and one
  // scrolled back into view show whole.
  const initialRowKeys = useRef<Set<string> | null>(null);
  if (!initialRowKeys.current) {
    initialRowKeys.current = new Set(rows.map((row) => row.key));
  }
  const shownRows = useRef(new Set<string>());

  /**
   * Measured rows. The container and the offsets below the first change are
   * written now, in the observer's own pass before paint; the reader's
   * anchor row stays put by moving the scroll offset with the growth above
   * it; a jump still landing lands.
   */
  const onRowsResized = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const el = scroller.current;
      if (!el) return;
      const changes: { index: number; delta: number }[] = [];
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.row;
        if (key === undefined) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        const change = rowLayout.measure(key, height);
        if (change) changes.push(change);
      }
      if (changes.length === 0) {
        if (!glide.current) land(el);
        return;
      }
      let from = Infinity;
      for (const change of changes) from = Math.min(from, change.index);
      writeOffsets(from);
      const anchor = anchorRef.current;
      const anchorIndex = anchor ? rowLayout.indexOf(anchor.key) : -1;
      const shift = anchorIndex >= 0 ? anchorShift(changes, anchorIndex) : 0;
      if (shift !== 0) {
        el.scrollTop += shift;
        expectedTop.current = el.scrollTop;
        // A glide in flight moves with the content, so a row landing above
        // it never snaps it.
        const g = glide.current;
        if (g) {
          g.from += shift;
          g.to += shift;
        }
      }
      if (!glide.current) land(el);
      reconcileWindow(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowLayout, writeOffsets, reconcileWindow],
  );
  const registerRow = useCallback(
    (key: string, el: HTMLElement | null) => {
      const observer = (rowObserver.current ??= new ResizeObserver(onRowsResized));
      if (el) {
        rowEls.current.set(key, el);
        shownRows.current.add(key);
        observer.observe(el);
        return;
      }
      const old = rowEls.current.get(key);
      if (!old) return;
      observer.unobserve(old);
      rowEls.current.delete(key);
    },
    [onRowsResized],
  );
  useEffect(
    () => () => {
      rowObserver.current?.disconnect();
      rowObserver.current = null;
    },
    [],
  );

  // The rows changed under the reader: put their anchor row back where it
  // was (a page landed above, a turn regrouped) unless the transcript is
  // glued to its end, then mount what the viewport needs. First, so the
  // effects below see the window the rows will have.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const box = container.current;
    if (box) box.style.height = `${rowLayout.total()}px`;
    const anchor = anchorRef.current;
    if (anchor && !(mode.current === "follow" && pinBottom.current)) {
      const top = rowLayout.scrollTopFor(anchor);
      if (top != null && Math.abs(top - el.scrollTop) > 0.5) {
        el.scrollTop = top;
        expectedTop.current = el.scrollTop;
      }
    }
    reconcileWindow(el);
    syncReader(el);
  }, [rows, rowLayout, reconcileWindow, syncReader]);

  // The list's place follows the pane's width and the message count; set
  // only when it changes (React keeps an equal state).
  useLayoutEffect(() => {
    setPlacement(outlinePlacement(paneWidth.current, entryCount));
  }, [entryCount]);

  /** The element of the last turn's first row, when it is mounted. */
  const lastTurnEl = (): HTMLElement | null => {
    const last = turns[turns.length - 1];
    if (!last) return null;
    const index = rowOf(last[0].id);
    if (index === undefined) return null;
    const key = rowLayout.keyAt(index);
    return key === undefined ? null : (rowEls.current.get(key) ?? null);
  };

  // Own send: with prompt anchoring the new prompt parks at the top over a
  // runway; otherwise the transcript snaps to its end and follows from there.
  // A pane that mounts on an unanswered prompt (the first message of a new
  // session, a tab reopened while the agent works) treats it as its own
  // send once the turn is running. The prompt's row may mount only on the
  // commit after the send, so the park waits for it (`pendingPark`).
  const unanswered = blocks.length > 0 && blocks[blocks.length - 1].role === "user";
  const seenUserId = useRef(unanswered ? undefined : lastUserId);
  const pendingPark = useRef(false);
  /** Park the new prompt once its row is mounted: lay the runway, then
   *  glide there (at once under reduced motion, where the offset was
   *  already written at the send). */
  const parkLastTurn = () => {
    if (!pendingPark.current) return;
    const turnEl = lastTurnEl();
    if (!turnEl) return;
    pendingPark.current = false;
    parkedTurn.current = turnEl;
    // A park glide already under way (the prompt was far off) only moves its
    // target with the runway; otherwise the glide starts here.
    const gliding = !!glide.current?.park;
    layoutRunway(reduceMotion);
    const el = scroller.current;
    if (!el || reduceMotion || gliding) return;
    const top = el.getBoundingClientRect().top - el.scrollTop;
    startGlide(parkTopOf(turnEl, turnEl.getBoundingClientRect().top - top), PARK, true);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || lastUserId === seenUserId.current) return;
    if (!busy && unanswered) return;
    seenUserId.current = lastUserId;
    glide.current = null;
    spacerAnim.current = null;
    pinBottom.current = false;
    if (promptAnchor && lastUserId && busy) {
      setMode("parked");
      parkedTurn.current = null;
      pendingPark.current = true;
      // Under reduced motion the park lands in one write. Otherwise it glides
      // from where the reader is: at once toward the prompt's offset when its
      // row is not mounted (the reader is far up; the glide brings the window
      // there, and the runway takes over its target), else once the row is.
      const index = rowOf(lastUserId);
      if (index !== undefined && reduceMotion) scrollTo(el, rowLayout.offsetOf(index) - TOP_INSET);
      else if (index !== undefined && !lastTurnEl()) startGlide(rowLayout.offsetOf(index) - TOP_INSET, PARK, true);
      parkLastTurn();
    } else {
      setMode("follow");
      parkedTurn.current = null;
      pendingPark.current = false;
      setSpacer(0);
      scrollTo(el, el.scrollHeight);
    }
    setShowJump(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserId, promptAnchor, busy, unanswered, layoutRunway, setShowJump]);
  useLayoutEffect(() => {
    parkLastTurn();
  });

  // Turn end: a parked reader keeps their place while the runway retires, so
  // a settled transcript never keeps blank space below its last row.
  useLayoutEffect(() => {
    if (busy) {
      schedule();
      return;
    }
    if (mode.current === "parked") {
      setMode("free");
      parkedTurn.current = null;
      pendingPark.current = false;
    }
    collapseSpacer();
    const el = scroller.current;
    if (el) syncPill(el);
  }, [busy, collapseSpacer, schedule, syncPill]);

  // First commit that carries rows for this session: the last stage mark.
  const markedBlocks = useRef(false);
  useLayoutEffect(() => {
    if (markedBlocks.current || blocks.length === 0 || mounted.end === 0) return;
    markedBlocks.current = true;
    perfMark("transcript-blocks", sessionId);
  }, [blocks.length, mounted.end, sessionId]);

  useLayoutEffect(() => {
    const opened = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (visible) everVisible.current = true;
    if (!opened) {
      if (!visible && raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      return;
    }
    const el = scroller.current;
    if (!el) return;
    const saved = takeTranscriptScroll(sessionId ?? "");
    if (shouldRestoreScroll(saved, busy)) {
      // The pane was unmounted while parked and the run is still going: put
      // the reader back where they were watching from.
      pinBottom.current = false;
      setMode("free");
      const top = rowLayout.scrollTopFor((saved as TranscriptScrollMemory).anchor);
      scrollTo(el, top ?? el.scrollHeight - el.clientHeight);
    } else if (!busy) {
      // A settled thread always opens at the bottom. A scroll-up from
      // earlier — the reader's own, or restored memory from a cold
      // remount — only makes sense while there is still something to
      // watch; once the run is over there is nothing to come back to.
      pinBottom.current = true;
      setMode("follow");
      scrollTo(el, el.scrollHeight);
    } else if (mode.current === "follow") scrollTo(el, el.scrollHeight);
    else if (mode.current === "parked") layoutRunway();
    reconcileWindow(el);
    syncPill(el);
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId, layoutRunway, reconcileWindow, schedule, syncPill]);

  // Unmount (the tab left the warm set): remember where the reader was.
  // The closure holds the element, so the ref being detached first is fine.
  // A pane that never showed keeps whatever memory it mounted with.
  useLayoutEffect(() => {
    const el = scrollerEl;
    if (!el) return;
    return () => {
      if (!everVisible.current) return;
      const anchor = mode.current === "follow" ? null : rowLayout.anchorAt(el.scrollTop);
      saveTranscriptScroll(sessionId ?? "", anchor ? { anchor } : null);
    };
  }, [scrollerEl, sessionId, rowLayout]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (mode.current === "follow" && (pinBottom.current || !visible)) {
      scrollTo(el, el.scrollHeight);
    } else if (mode.current === "parked") layoutRunway();
    else schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, busy, visible, layoutRunway, schedule]);

  useLayoutEffect(() => {
    const el = scrollerEl;
    const content = inner.current;
    if (!el || !content) return;
    const onResize = () => {
      if (el.clientWidth !== paneWidth.current) {
        paneWidth.current = el.clientWidth;
        setPlacement(outlinePlacement(el.clientWidth, entryCountRef.current));
      }
      // The message list's height cap, without a render.
      el.style.setProperty("--transcript-viewport", `${el.clientHeight}px`);
      if (mode.current === "parked") layoutRunway();
      else if (mode.current === "follow" && (pinBottom.current || !visibleRef.current)) {
        scrollTo(el, el.scrollHeight);
      } else schedule();
      reconcileWindow(el);
      syncPill(el);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(content);
    observer.observe(el);
    onResize();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerEl, layoutRunway, reconcileWindow, schedule, syncPill]);

  // Strict mode runs this cleanup once on mount too: clearing the handle
  // lets the next schedule() start a fresh loop instead of waiting on a
  // cancelled frame.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  // One function for the thread: every row takes it, and a new one each
  // render re-rendered every mounted row on every push.
  const loadEarlier = useCallback(() => {
    release();
    if (sessionId) void sessionStore.loadOlder(sessionId);
  }, [release, sessionId]);

  // Which harness answered a turn, for its duration line. Read through a
  // ref so a streamed delta (a new `blocks` array) re-renders the live
  // turn's rows alone, never every mounted row.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const harnessOf = useCallback(
    (turn: Block[]) => (harness ? harnessForTurn(blocksRef.current, turn, harness) : undefined),
    [harness],
  );

  /** A block's row, for the message list: a click glides, a key lands at once. */
  const scrollToBlock = useCallback(
    (blockId: string, how: JumpHow) => {
      const index = rowOf(blockId);
      if (index !== undefined) scrollToRow(index, { instant: how === "key" });
    },
    [rowOf, scrollToRow],
  );

  // Scroll-to-row entry point (session search): the request waits in
  // lib/transcriptJump until this session's history holds the row, then the
  // same glide a click in the message list takes lands on it, through the window. No second
  // engine — glideTo owns the motion and the mode. Only the shown pane takes
  // the request: a hidden one may be about to remount as the view switches,
  // which would lose the jump with its state.
  const [jumpTick, setJumpTick] = useState(0);
  useEffect(
    () => subscribeTranscriptJump(() => setJumpTick((n) => n + 1)),
    [],
  );
  useLayoutEffect(() => {
    if (!sessionId || !visible) return;
    const jump = pendingTranscriptJump(sessionId);
    if (!jump) return;
    const block = blockForSeq(blocks, jump.seq);
    if (!block) return;
    const index = rowOf(block.id);
    if (index === undefined) return;
    const sc = scroller.current;
    // No layout (a display:none ancestor) means no viewport to land in.
    if (!sc || sc.clientHeight === 0) return;
    takeTranscriptJump(sessionId);
    scrollToRow(index);
  }, [sessionId, visible, blocks, rowOf, jumpTick, scrollToRow]);

  const shown = rows.slice(mounted.start, Math.min(mounted.end, rows.length));

  return (
    <SelectSessionContext.Provider value={onSelectSession}>
    <TranscriptSessionContext.Provider value={sessionId}>
    <TurnStateContext.Provider value={turnState ?? null}>
    <ParkPendingContext.Provider value={isParking}>
    <div className="relative h-full">
    <div
      ref={setScroller}
      className="agent-transcript h-full overflow-x-hidden overflow-y-auto overscroll-none [overflow-anchor:none] [scrollbar-gutter:stable] font-sans text-[13px] leading-5"
    >
      {placement !== "hidden" ? (
        // Inside the scroller, so a wheel over the list scrolls the
        // transcript; zero height, so no offset or scroll height moves.
        <div data-transcript-outline className="sticky top-0 z-10 h-0">
          <TranscriptOutline
            className="absolute top-4 left-4 w-52 max-h-[calc(var(--transcript-viewport)-32px)] font-sans"
            turns={turns}
            reader={reader}
            onJump={scrollToBlock}
            hasOlder={moreHistory}
            onLoadEarlier={loadEarlier}
          />
        </div>
      ) : null}
      <div
        ref={inner}
        className="px-4 pb-4"
        style={placement === "beside" ? { paddingLeft: LIST_SPACE } : undefined}
      >
        <div
          ref={container}
          className={`relative ${placement === "beside" ? "mr-auto" : "mx-auto"} w-full min-w-0 ${COLUMN_MAX_CLASS}`}
          style={{ height: rowLayout.total() }}
        >
          {shown.map((row, i) => (
            <RowView
              key={row.key}
              row={row}
              top={rowLayout.offsetOf(mounted.start + i)}
              fresh={
                row.kind !== "more" &&
                !initialTurns.current!.has(row.turn.id) &&
                !shownRows.current.has(row.key)
              }
              bornLive={
                row.kind === "item" &&
                row.turn.isLast &&
                !initialRowKeys.current!.has(row.key) &&
                !shownRows.current.has(row.key)
              }
              cwd={cwd}
              harnessOf={harnessOf}
              turnState={rowTurnState(row, turnState)}
              liveState={liveState}
              onOpenActivity={onOpenActivity}
              register={registerRow}
              onLoadEarlier={loadEarlier}
              onApproval={onApproval}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              onSaveNote={onSaveNote}
              onSecondOpinion={onSecondOpinion}
              onHandoff={onHandoff}
            />
          ))}
        </div>
      </div>
      <div ref={spacer} aria-hidden className="shrink-0" />
      {onAddToChat ? (
        <TranscriptSelectionMenu
          selection={selection}
          onAddToChat={onAddToChat}
          onDismiss={dismissSelection}
        />
      ) : null}
    </div>
    </div>
    </ParkPendingContext.Provider>
    </TurnStateContext.Provider>
    </TranscriptSessionContext.Provider>
    </SelectSessionContext.Provider>
  );
}

/**
 * Re-uses the previous array for every turn whose blocks are the same
 * objects, so folding a delta into the live turn leaves the rest untouched
 * and their memoised views hold.
 */
function stableTurns(next: Block[][], previous: Block[][]): Block[][] {
  let changed = next.length !== previous.length;
  const out = next.map((turn, i) => {
    const old = previous[i];
    if (old && old.length === turn.length && old.every((block, j) => block === turn[j])) return old;
    changed = true;
    return turn;
  });
  return changed ? out : previous;
}

/** The session a row is handed: the live turn's closing row alone draws it.
 *  It is a new object on every delta, so an item row given it would re-render
 *  with each one; an item that reads it (a notice) takes it from context. */
export function rowTurnState(row: TranscriptRow, turnState: TurnSession | null | undefined): TurnSession | null {
  return row.kind === "end" && row.turn.isLast ? (turnState ?? null) : null;
}

type RowViewProps = {
  row: TranscriptRow;
  /** Offset in the container, from the layout at render time. */
  top: number;
  /** Born after the transcript mounted and never shown: fades in, once. */
  fresh: boolean;
  /** Joined the live turn after the transcript opened and never shown: its
   *  prose reveals from its first word. */
  bornLive: boolean;
  cwd?: string;
  harnessOf: (turn: Block[]) => HarnessId | undefined;
  /** The session, for the live turn's closing row only (`rowTurnState`). */
  turnState: TurnSession | null;
  liveState: boolean;
  onOpenActivity?: () => void;
  register: (key: string, el: HTMLElement | null) => void;
  onLoadEarlier: () => void;
  onApproval?: Props["onApproval"];
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  onSaveNote?: (text: string) => void;
  onSecondOpinion?: Props["onSecondOpinion"];
  onHandoff?: Props["onHandoff"];
};

/** The gap above a row (`ROW_GAP`), only while the row draws something,
 *  so an empty row stays 0px tall. Written out whole for Tailwind. */
const GAP_CLASS: Record<RowGap, string> = {
  4: "has-[>*]:pt-1",
  8: "has-[>*]:pt-2",
  12: "has-[>*]:pt-3",
  16: "has-[>*]:pt-4",
  32: "has-[>*]:pt-8",
};

/**
 * One row of the window, placed by its offset. A streamed delta rebuilds the
 * live turn's rows as new objects; RowView compares its row by what it draws
 * (`sameRow`, transcriptRows.ts) and its other props by identity, so the
 * delta re-renders the row it changed and the closing row alone; a row whose
 * offset moved re-renders its wrapper and, keeping the row it drew
 * (`useKept`), nothing inside it.
 */
const RowView = memo(function RowView({
  row: next,
  top,
  fresh,
  bornLive,
  cwd,
  harnessOf,
  turnState,
  liveState,
  onOpenActivity,
  register,
  onLoadEarlier,
  onApproval,
  onOpenFile,
  onOpenDiff,
  onSaveNote,
  onSecondOpinion,
  onHandoff,
}: RowViewProps) {
  // The row as last drawn while it reads the same, so a render for a moved
  // offset hands the views inside the same blocks and they skip it.
  const row = useKept(next, sameRow);
  const key = row.key;
  // Decided at mount: a later render never starts or cuts the fade.
  const [fadeIn] = useState(fresh);
  const [born] = useState(bornLive);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      register(key, el);
      return () => register(key, null);
    },
    [register, key],
  );
  return (
    <RevealTurnContext.Provider value={row.kind === "more" ? null : row.turn.id}>
    <div
      ref={ref}
      data-row={key}
      data-turn={row.kind === "more" ? undefined : row.turn.id}
      className={`absolute inset-x-0 flex min-w-0 flex-col ${GAP_CLASS[row.gap]}${fadeIn ? " z-fade-in" : ""}`}
      style={{ top }}
    >
      {row.kind === "more" ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={onLoadEarlier}>
            Load earlier messages
          </Button>
        </div>
      ) : row.kind === "end" ? (
        <TurnEnd
          turn={row.turn}
          cwd={cwd}
          harnessOf={harnessOf}
          turnState={turnState}
          liveState={liveState}
          onOpenActivity={onOpenActivity}
          onSaveNote={onSaveNote}
          onSecondOpinion={onSecondOpinion}
          onHandoff={onHandoff}
        />
      ) : row.item.type === "activity" ? (
        <ActionGroup
          blocks={row.item.blocks}
          cwd={cwd}
          live={row.live}
          working={row.working}
          settled={row.turn.settled}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ) : row.item.block.role === "user" ? (
        <div data-block={row.item.block.id} className="flex min-w-0 flex-col">
          <TranscriptBlock
            block={row.item.block}
            stickyIndex={row.turn.index + 1}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            cwd={cwd}
          />
        </div>
      ) : (
        <RowBornContext.Provider value={born}>
          <TranscriptBlock
            block={row.item.block}
            stickyIndex={row.turn.index + 1}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            cwd={cwd}
          />
        </RowBornContext.Provider>
      )}
    </div>
    </RevealTurnContext.Provider>
  );
}, sameRowViewProps);

/** RowView's memo: the row by what it draws, every other prop by identity. */
function sameRowViewProps(a: RowViewProps, b: RowViewProps): boolean {
  for (const key of Object.keys(b) as (keyof RowViewProps)[]) {
    if (key === "row" ? !sameRow(a.row, b.row) : a[key] !== b[key]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

function lastUserBlockId(blocks: Block[]): string | undefined {
  return turnUserBlock(blocks)?.id;
}
