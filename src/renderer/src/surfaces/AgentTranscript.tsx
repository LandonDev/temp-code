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
import { TranscriptMinimap } from "./TranscriptMinimap";
import {
  RowLayout,
  anchorShift,
  rangeCovers,
  type RowAnchor,
  type RowRange,
} from "../lib/transcriptWindow";
import { estimateRowHeight, flattenTurns, turnUserBlock, type TranscriptRow } from "./transcriptRows";
import { useReducedMotion } from "motion/react";
import { type Block, type HarnessId } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import { TurnStateContext, type TurnSession } from "./turnState";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePaneVisible } from "../hooks/paneVisibility";
import { saveTranscriptScroll, takeTranscriptScroll, type TranscriptScrollMemory } from "../lib/transcriptScrollMemory";
import { blockForSeq, pendingTranscriptJump, subscribeTranscriptJump, takeTranscriptJump } from "../lib/transcriptJump";
import { useTranscriptLayout } from "../hooks/useTranscriptLayout";
import { useTranscriptAnchor } from "../hooks/useTranscriptAnchor";
import { useTranscriptSelection } from "../hooks/useTranscriptSelection";
import type { TranscriptLayout } from "../lib/appearance";
import { SelectSessionContext } from "./AgentMarkdown";
import type { OpenFileFn } from "../lib/search";
import { TranscriptSessionContext } from "./transcriptSession";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";
import { groupTurns } from "./transcriptActivity";
import { TurnEnd } from "./transcript/TurnEnd";
import { ActionGroup } from "./transcript/ActionGroup";
import { TranscriptBlock } from "./transcript/TranscriptBlock";
import { TurnStamp } from "./transcript/UserMessage";
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
const GLIDE_MS = 500;
const MAX_GLIDE_VIEWPORTS = 2.5;
const SPACER_MS = 220;
const FOLLOW_LEAD = 32;

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

const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

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
  /** False while another tab is in front. Hidden tabs stay laid out. */
  visible?: boolean;
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
  visible: visibleProp = true,
}: Props) {
  // A parked pane keeps its transcript mounted; the context turns it off.
  const visible = visibleProp && usePaneVisible();
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const showJumpRef = useRef(false);
  const wasVisible = useRef(false);
  const everVisible = useRef(false);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion() === true;
  // Engine state lives in refs: the rAF loop reads and writes it without a
  // render, and nothing here changes what React draws.
  const mode = useRef<ScrollMode>("follow");
  const parkedTurn = useRef<HTMLElement | null>(null);
  const glide = useRef<{ from: number; to: number; start: number } | null>(null);
  const velocity = useRef(0);
  const expectedTop = useRef(-1);
  const dragging = useRef(false);
  const spacerH = useRef(0);
  const spacerAnim = useRef<{ from: number; start: number } | null>(null);
  const raf = useRef(0);
  // Glue to the bottom until the reader shows intent: history loading in
  // pages must not drift a fresh transcript off its end.
  const pinBottom = useRef(true);
  const runningRef = useRef(!!busy);
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
  const { selection, dismissSelection } = useTranscriptSelection(
    scrollerEl,
    onAddToChat !== undefined,
  );
  const transcriptLayout = useTranscriptLayout();
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

  const syncPill = useCallback(
    (el: HTMLElement, ext?: Extent) => {
      setShowJump(
        mode.current !== "follow" &&
          fromBottomOf(el, ext) - spacerH.current > PILL_AT,
      );
    },
    [setShowJump],
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
      const t = Math.min(1, (now - anim.start) / SPACER_MS);
      const before = spacerH.current;
      setSpacer(anim.from * (1 - easeOut(t)));
      scrollHeight += spacerH.current - before;
      if (t < 1) again = true;
      else spacerAnim.current = null;
    }
    const g = glide.current;
    if (g) {
      const t = Math.min(1, (now - g.start) / GLIDE_MS);
      scrollTo(el, g.from + (g.to - g.from) * easeInOut(t));
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
        glide.current = { from: el.scrollTop, to: max, start: now };
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
      if (runningRef.current) again = true;
    }
    syncPill(el, { scrollHeight, clientHeight });
    if (again) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, schedule, syncPill]);
  tickRef.current = tick;

  /** The runway under a parked turn: room for the prompt to sit at the top. */
  const layoutRunway = useCallback(() => {
    const el = scroller.current;
    const turn = parkedTurn.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !turn || !inner) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const turnTop = turn.getBoundingClientRect().top - base;
    const below = inner.getBoundingClientRect().bottom - base - turnTop;
    setSpacer(Math.max(0, el.clientHeight - TOP_INSET - below));
    scrollTo(el, turnTop - TOP_INSET);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const startGlide = useCallback(
    (to: number) => {
      const el = scroller.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      to = Math.min(max, Math.max(0, to));
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
      glide.current = { from, to, start: performance.now() };
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
   * the ones that mount.
   */
  const scrollToRow = useCallback(
    (index: number) => {
      const el = scroller.current;
      const key = rowLayout.keyAt(index);
      if (!el || key === undefined) return;
      const target = rowEls.current.get(key);
      if (target) {
        glideTo(target);
        return;
      }
      release();
      landing.current = key;
      startGlide(rowLayout.offsetOf(index) - TOP_INSET);
    },
    [rowLayout, glideTo, release, startGlide],
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
  const { rows, rowOfBlock } = useMemo(
    () => flattenTurns(turns, !!busy, { loadEarlier: moreHistory }),
    [turns, busy, moreHistory],
  );
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
    initialTurns.current = new Set(turns.map((turn) => turn[0].id));
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
  }, [rows, rowLayout, reconcileWindow]);

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
  const parkLastTurn = () => {
    if (!pendingPark.current) return;
    const turnEl = lastTurnEl();
    if (!turnEl) return;
    pendingPark.current = false;
    parkedTurn.current = turnEl;
    layoutRunway();
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
      const index = rowOf(lastUserId);
      if (index !== undefined) scrollTo(el, rowLayout.offsetOf(index) - TOP_INSET);
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
    runningRef.current = !!busy;
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
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const onResize = () => {
      if (mode.current === "parked") layoutRunway();
      else if (mode.current === "follow" && (pinBottom.current || !visibleRef.current)) {
        scrollTo(el, el.scrollHeight);
      } else schedule();
      reconcileWindow(el);
      syncPill(el);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(inner);
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

  const loadEarlier = () => {
    release();
    if (sessionId) void sessionStore.loadOlder(sessionId);
  };

  // Which harness answered a turn, for its duration line. Read through a
  // ref so a streamed delta (a new `blocks` array) re-renders the live
  // turn's rows alone, never every mounted row.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const harnessOf = useCallback(
    (turn: Block[]) => (harness ? harnessForTurn(blocksRef.current, turn, harness) : undefined),
    [harness],
  );

  /** A block's row, for the minimap and search hits. */
  const scrollToBlock = useCallback(
    (blockId: string) => {
      const index = rowOf(blockId);
      if (index !== undefined) scrollToRow(index);
    },
    [rowOf, scrollToRow],
  );

  // Scroll-to-row entry point (session search): the request waits in
  // lib/transcriptJump until this session's history holds the row, then the
  // same glide the minimap uses lands on it, through the window. No second
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
    <div className="relative h-full">
    <div
      ref={setScroller}
      className="agent-transcript h-full overflow-y-auto overscroll-none [overflow-anchor:none] font-mono text-[13px] leading-5"
    >
      <div className="px-4">
        <div
          ref={container}
          className="relative mx-auto w-full min-w-0 max-w-4xl"
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
              cwd={cwd}
              layout={transcriptLayout}
              harnessOf={harnessOf}
              turnState={row.kind !== "more" && row.turn.isLast ? (turnState ?? null) : null}
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
    <TranscriptMinimap
      scroller={scrollerEl}
      turns={turns}
      visible={visible}
      onJump={scrollToBlock}
    />
    </div>
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

type RowViewProps = {
  row: TranscriptRow;
  /** Offset in the container, from the layout at render time. */
  top: number;
  /** Born after the transcript mounted and never shown: fades in, once. */
  fresh: boolean;
  cwd?: string;
  layout: TranscriptLayout;
  harnessOf: (turn: Block[]) => HarnessId | undefined;
  /** The session, for the live turn's rows only; older rows never see it change. */
  turnState: TurnSession | null;
  register: (key: string, el: HTMLElement | null) => void;
  onLoadEarlier: () => void;
  onApproval?: Props["onApproval"];
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  onSaveNote?: (text: string) => void;
  onSecondOpinion?: Props["onSecondOpinion"];
  onHandoff?: Props["onHandoff"];
};

/**
 * One row of the window, placed by its offset. Its `row` keeps its identity
 * while its turn's blocks do (see `stableTurns` and transcriptRows.ts), so
 * a streamed delta re-renders the live turn's rows alone; a row whose
 * offset moved re-renders its wrapper and nothing inside it.
 */
const RowView = memo(function RowView({
  row,
  top,
  fresh,
  cwd,
  layout,
  harnessOf,
  turnState,
  register,
  onLoadEarlier,
  onApproval,
  onOpenFile,
  onOpenDiff,
  onSaveNote,
  onSecondOpinion,
  onHandoff,
}: RowViewProps) {
  const key = row.key;
  // Decided at mount: a later render never starts or cuts the fade.
  const [fadeIn] = useState(fresh);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      register(key, el);
      return () => register(key, null);
    },
    [register, key],
  );
  return (
    <div
      ref={ref}
      data-row={key}
      data-turn={row.kind === "more" ? undefined : row.turn.id}
      className={`absolute inset-x-0 flex min-w-0 flex-col pb-1${fadeIn ? " z-fade-in" : ""}`}
      style={{ top }}
    >
      {row.kind === "more" ? (
        <div className="flex justify-center py-3">
          <button
            type="button"
            className="pressable rounded-md bg-content/8 px-2.5 py-1.5 font-sans text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
            onClick={onLoadEarlier}
          >
            Load earlier messages
          </button>
        </div>
      ) : row.kind === "end" ? (
        <TurnEnd
          turn={row.turn}
          harnessOf={harnessOf}
          turnState={turnState}
          onSaveNote={onSaveNote}
          onSecondOpinion={onSecondOpinion}
          onHandoff={onHandoff}
        />
      ) : row.item.type === "activity" ? (
        <ActionGroup
          blocks={row.item.blocks}
          cwd={cwd}
          live={row.live}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ) : row.item.block.role === "user" ? (
        <div data-block={row.item.block.id} className="group/turn flex min-w-0 flex-col">
          <TranscriptBlock
            block={row.item.block}
            layout={layout}
            stickyIndex={row.turn.index + 1}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            cwd={cwd}
          />
          <TurnStamp ts={row.item.block.ts ?? row.item.block.startedAt} chat={layout === "chat"} />
        </div>
      ) : (
        <TranscriptBlock
          block={row.item.block}
          layout={layout}
          stickyIndex={row.turn.index + 1}
          compactTop={row.compactTop}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          cwd={cwd}
        />
      )}
    </div>
  );
});

function lastUserBlockId(blocks: Block[]): string | undefined {
  return turnUserBlock(blocks)?.id;
}
