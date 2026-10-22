import { registry } from "../lib/connection";
import { hostOfCwd } from "../lib/tcserver/projects";
import {
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  FilePlusCorner,
  MessageSquare,
  Minus,
  Pause,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "../chrome/icons";
import {
  type AnimationEvent,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AttachmentChip, openAttachmentImages } from "../chrome/AttachmentChip";
import { FilePreview } from "../chrome/FilePreview";
import { FileTypeIcon } from "../chrome/FileTypeIcon";
import { QuestionCard } from "./QuestionCard";
import { HandoffButton, SecondOpinionButton } from "../chrome/SecondOpinionButton";
import { SecondOpinionCard } from "../chrome/SecondOpinionCard";
import { NoteMiniCard } from "../chrome/NoteMiniCard";
import { TerminalSpinner } from "../chrome/TerminalSpinner";
import type { ApprovalDecision } from "../lib/harness";
import { perfMark } from "../lib/perfMarks";
import { sendOffset, sendOrigin } from "../lib/sendOrigin";
import { isEditTool, stubFilePreview } from "../lib/harness/preview";
import { copyText } from "../lib/clipboard";
import { playCue } from "../lib/sounds";
import { displayPath, resolveWorkspacePath } from "../lib/paths";
import { harnessForTurn } from "../lib/secondOpinion";
import { Shimmer } from "./Shimmer";
import { TWEEN_FALLBACK_MS, TweenHeight } from "../motion/TweenHeight";
import { usePersistedOpen } from "./editOpenState";
import { TranscriptMinimap } from "./TranscriptMinimap";
import {
  RowLayout,
  anchorShift,
  rangeCovers,
  type RowAnchor,
  type RowRange,
} from "../lib/transcriptWindow";
import {
  estimateRowHeight,
  flattenTurns,
  turnUserBlock,
  type TranscriptRow,
  type TurnInfo,
} from "./transcriptRows";
import { TodoListBlock } from "./TodoListBlock";
import { htmlRenderChunk } from "./chunks";
import { SurfaceSkeleton } from "./SurfaceSkeleton";
import { htmlRenderOf } from "./htmlRenderBlock";
import { useReducedMotion } from "motion/react";
import {
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type ToolPreview,
} from "../lib/session";
import { approvalDetailOf, approvalOutcome } from "../lib/approvalDetail";
import { isTurnPaused, passActionsOf, turnElapsed, useClock } from "../lib/turnClock";
import { errorRowOf, isErrorBlock } from "../lib/turnOutcome";
import { sessionStore, useSessionMeta } from "../lib/tcserver/store";
import { ErrorChip } from "./ErrorChip";
import { CompactionCard } from "./CompactionCard";
import { AgentSpawnRow, PlanHandoffRow } from "./AgentSpawnRow";
import { GateCard } from "./GateCard";
import { ReviewCard } from "./ReviewCard";
import { CommandChip, ConnectorMark, ConnectorSummary, ReconnectChip, SubagentMark, SubagentSteps, reauthOf } from "./ToolChips";
import { commandParts, isAgentCall, mcpServerOf, useKnownCommands, type CommandPart } from "./toolMarks";
import { TurnStateContext, useTurnState, type TurnSession } from "./turnState";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePaneVisible } from "../hooks/paneVisibility";
import {
  saveTranscriptScroll,
  takeTranscriptScroll,
  type TranscriptScrollMemory,
} from "../lib/transcriptScrollMemory";
import {
  blockForSeq,
  pendingTranscriptJump,
  subscribeTranscriptJump,
  takeTranscriptJump,
} from "../lib/transcriptJump";
import { useTranscriptLayout } from "../hooks/useTranscriptLayout";
import { useTranscriptZen } from "../hooks/useTranscriptZen";
import { useTranscriptAnchor } from "../hooks/useTranscriptAnchor";
import { useTranscriptSelection } from "../hooks/useTranscriptSelection";
import type { TranscriptLayout } from "../lib/appearance";
import { AgentMarkdown, SelectSessionContext } from "./AgentMarkdown";
import type { OpenFileFn } from "../lib/search";
import {
  storeTitleOf,
  threadMentionParts,
  type ThreadMentionPart,
  threadMentionsToTitles,
  useThreadTitles,
} from "../lib/threadMentions";
import { EditRow } from "./EditRow";
import { CallPortLink } from "./CallPortLink";
import { ToolDetails } from "./ToolDetails";
import { FileRefMenu } from "./FileRefMenu";
import { splitEditCards } from "./editCards";
import { AppToolSummary, useAppView } from "./AppToolSummary";
import { CopyMessageButton } from "./CopyMessageButton";
import { PreambleRow } from "./PreambleRow";
import { isEditBlock } from "./editModel";
import { TranscriptSessionContext, useTranscriptHost, useTranscriptSession } from "./transcriptSession";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";
import {
  activityPhaseTitle,
  activityPreviousLabel,
  buildActivityPhases,
  editVerb,
  groupTurns,
  isIncompleteTool,
  isThinkingBlock,
  isTodoBlock,
  isProseBlock,
  awaitsUser,
  needsApproval,
  nestedScrollAbsorbsWheel,
  proseSummary,
  splitActivityRows,
  toolCallLabel,
  toolCallState,
  turnCopyText,
  type ActivityPhase,
  type ActivityPhaseKind,
  type ToolCallState,
} from "./transcriptActivity";

// An agent's HTML page renders from the html-render chunk (surfaces/chunks.ts).
const HtmlRenderRow = htmlRenderChunk.surface("HtmlRenderRow", <SurfaceSkeleton kind="frame" label="Loading page" />);

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
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onAddToChat?: (text: string) => void;
  onSaveNote?: (text: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  /** Opens a thread mentioned as `@thread:<id>`. */
  onSelectSession?: (sessionId: string) => void;
  onSecondOpinion?: (harness: HarnessId, turn: Block[], model: string) => void;
  onHandoff?: (harness: HarnessId, turn: Block[], model: string) => void;
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
  const zen = useTranscriptZen();
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
    () => flattenTurns(turns, zen, !!busy, { loadEarlier: moreHistory }),
    [turns, zen, busy, moreHistory],
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
              zen={zen}
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
  zen: boolean;
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
  zen,
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
        zen ? (
          <ActivityPhases
            blocks={row.item.blocks}
            cwd={cwd}
            done={row.done}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        ) : (
          <ActivityGroup
            blocks={row.item.blocks}
            cwd={cwd}
            autoOpen={row.autoOpen}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        )
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

/** A turn's closing row: the thinking tail while it starts, its duration
 *  line once it is over, the live timer while it runs or waits. */
function TurnEnd({
  turn,
  harnessOf,
  turnState,
  onSaveNote,
  onSecondOpinion,
  onHandoff,
}: {
  turn: TurnInfo;
  harnessOf: (turn: Block[]) => HarnessId | undefined;
  turnState: TurnSession | null;
  onSaveNote?: (text: string) => void;
  onSecondOpinion?: Props["onSecondOpinion"];
  onHandoff?: Props["onHandoff"];
}) {
  const { settled, durationMs, startedAt, isLast } = turn;
  // Settled only: the live turn's harness is not known until it answers.
  const fromHarness = useMemo(
    () => (settled ? harnessOf(turn.blocks) : undefined),
    [settled, harnessOf, turn.blocks],
  );
  return (
    <>
      {!settled && showsThinkingTail(turn.blocks) ? (
        <div className="z-fade-in flex h-[26px] items-center font-sans text-sm">
          <Shimmer>Thinking</Shimmer>
        </div>
      ) : null}
      {durationMs != null && settled ? (
        <TurnDuration
          elapsedMs={durationMs}
          done
          completedAt={startedAt != null ? startedAt + durationMs : undefined}
          copyText={threadMentionsToTitles(turnCopyText(turn.blocks), storeTitleOf)}
          onSaveNote={onSaveNote}
          fromHarness={fromHarness}
          onSecondOpinion={
            onSecondOpinion
              ? (target, model) => onSecondOpinion(target, turn.blocks, model)
              : undefined
          }
          onHandoff={
            onHandoff ? (target, model) => onHandoff(target, turn.blocks, model) : undefined
          }
        />
      ) : null}
      {isLast && (!settled || (durationMs == null && turnState && isTurnPaused(turnState))) ? (
        <LiveTurnDuration turn={turn.blocks} />
      ) : null}
    </>
  );
}

/**
 * The running timer for the turn still in flight. Ticks on the shared clock
 * so only this row re-renders each second, never the transcript.
 */
function LiveTurnDuration({ turn }: { turn: Block[] }) {
  const session = useTurnState();
  const paused = session ? isTurnPaused(session) : false;
  const now = useClock(!paused && usePaneVisible());
  const elapsed = session ? turnElapsed(session, now) : null;
  const waiting = turn.some(
    (b) => needsApproval(b) || (b.question != null && b.question.answers === undefined),
  );
  return (
    <TurnDuration elapsedMs={elapsed} live waiting={waiting} paused={paused} />
  );
}

function TurnDuration({
  elapsedMs,
  live = false,
  done = false,
  waiting = false,
  paused = false,
  completedAt,
  copyText: output,
  onSaveNote,
  fromHarness,
  onSecondOpinion,
  onHandoff,
}: {
  elapsedMs: number | null;
  live?: boolean;
  done?: boolean;
  waiting?: boolean;
  /** Frozen mid-turn: the elapsed time holds and the spinner stops. */
  paused?: boolean;
  completedAt?: number;
  copyText?: string;
  onSaveNote?: (text: string) => void;
  fromHarness?: HarnessId;
  onSecondOpinion?: (harness: HarnessId, model: string) => void;
  onHandoff?: (harness: HarnessId, model: string) => void;
}) {
  const label = paused
    ? `Paused · ${formatWorkingDuration(elapsedMs, true).replace(/^Worked/, "worked")}`
    : waiting
      ? "Waiting for you"
      : formatWorkingDuration(elapsedMs, done);
  const dot = (
    <span
      aria-hidden
      className="size-[3px] shrink-0 rounded-full bg-content/20"
    />
  );
  return (
    <div
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-label={
        paused ? "Paused" : waiting ? "Waiting for you" : live ? "Agent is working" : label
      }
      className="flex items-center gap-3 pt-1 pb-3 font-sans text-sm tabular-nums text-content/40"
    >
      {done ? (
        <span className="flex items-center gap-2">
          {output ? (
            <>
              <CopyTurnButton text={output} />
              {onSaveNote ? (
                <SaveNoteButton text={output} onSave={onSaveNote} />
              ) : null}
            </>
          ) : (
            <Check className="size-3.5" strokeWidth={1.75} />
          )}
          {fromHarness && onHandoff ? (
            <HandoffButton from={fromHarness} onPick={onHandoff} />
          ) : null}
          {fromHarness && onSecondOpinion ? (
            <SecondOpinionButton from={fromHarness} onPick={onSecondOpinion} />
          ) : null}
        </span>
      ) : paused ? (
        <Pause className="size-3.5" strokeWidth={1.75} />
      ) : (
        <TerminalSpinner />
      )}

      {done ? dot : null}

      {live && !done && !paused ? (
        <Shimmer>{label}</Shimmer>
      ) : (
        <span>{label}</span>
      )}

      {completedAt != null ? (
        <>
          {dot}
          <span className="text-content/40">
            {formatClockTime(completedAt)}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Wall-clock stamp for a finished turn, in the reader's own locale. */
const clockTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function formatClockTime(epochMs: number): string {
  return clockTimeFormat.format(epochMs);
}

function CopyTurnButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy response"}
      aria-label={copied ? "Copied" : "Copy response"}
      className="-ml-1 rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
      onClick={() => {
        playCue("copy");
        void copyText(text).then(
          () => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? (
        <Check className="size-3.5" strokeWidth={1.75} />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}

function SaveNoteButton({
  text,
  onSave,
}: {
  text: string;
  onSave: (text: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setSaved(false);
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <button
      type="button"
      title={saved ? "Saved to Notes" : "Save as note"}
      aria-label={saved ? "Saved to Notes" : "Save as note"}
      className="rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
      onClick={() => {
        playCue("copy");
        onSave(text);
        setSaved(true);
        if (timer.current != null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setSaved(false), 2000);
      }}
    >
      {saved ? (
        <Check className="size-3.5" strokeWidth={1.75} />
      ) : (
        <FilePlusCorner className="size-3.5" strokeWidth={1.75} />
      )}
    </button>
  );
}

const TranscriptBlock = memo(function TranscriptBlock({
  block,
  layout,
  stickyIndex,
  compactTop = false,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  layout: TranscriptLayout;
  stickyIndex: number;
  compactTop?: boolean;
  cwd?: string;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  // The thread's own host: its attachments and pages live there, whatever the cwd says.
  const threadHost = useTranscriptHost() ?? (cwd ? hostOfCwd(cwd) : registry.primary().environmentId);
  if (block.role === "user") {
    return (
      <UserMessageBlock
        block={block}
        layout={layout}
        stickyIndex={stickyIndex}
        environmentId={threadHost}
      />
    );
  }

  if (isTodoBlock(block)) {
    return <TodoListBlock block={block} />;
  }

  const page = htmlRenderOf(block);
  if (page) {
    return (
      <HtmlRenderRow
        reference={page}
        host={threadHost}
      />
    );
  }

  if (block.role === "tool") {
    return (
      <ToolCall
        block={block}
        cwd={cwd}
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  if (block.role === "reasoning") {
    return null;
  }

  if (block.role === "plan") {
    return (
      <div className="py-1">
        <AgentMarkdown
          text={block.text}
          streaming={block.streaming}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  if (block.role === "approval") {
    return (
      <ToolCall
        block={block}
        cwd={cwd}
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  if (block.role === "handoff") {
    return <HandoffDivider block={block} />;
  }

  if (block.role === "system") {
    if (block.compaction) return <CompactionCard block={block} />;
    if (block.agent) return <AgentSpawnRow block={block} />;
    if (block.planHandoff) return <PlanHandoffRow block={block} />;
    if (block.review) return <ReviewCard block={block} cwd={cwd} onOpenFile={onOpenFile} />;
    if (block.gate) return <GateCard block={block} />;
    if (isErrorBlock(block)) return <ErrorRowView block={block} />;
    const actions = passActionsOf(block);
    if (actions) return <PassRow actions={actions} />;
    return (
      <div className="py-2 text-content/50">
        <pre className="min-w-0 whitespace-pre-wrap break-words">
          {block.text}
        </pre>
      </div>
    );
  }

  if (!block.text && block.streaming) return null;

  return (
    <div
      data-block={block.id}
      data-selectable-agent-response={block.streaming ? undefined : block.id}
      className={`min-w-0 pb-1 text-content ${compactTop ? "pt-2" : "pt-3"}`}
    >
      <AgentMarkdown
        text={block.text}
        streaming={block.streaming}
        cwd={cwd}
        onOpenFile={onOpenFile}
      />
    </div>
  );
});

/** The send-in entrance's length (index.css `bubble-send-flip`, the
 *  longer of the two entrances). */
const SEND_IN_MS = 420;

function UserMessageBlock({
  block,
  layout,
  stickyIndex,
  environmentId,
}: {
  block: Block;
  layout: TranscriptLayout;
  stickyIndex: number;
  /** The host the turn's attachments live on. */
  environmentId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLPreElement>(null);
  // How far into its entrance this bubble is at mount; null once it is
  // over (or was never this window's send). A negative delay resumes it.
  const [entering, setEntering] = useState<number | null>(() => {
    const age = block.born == null ? Infinity : Date.now() - block.born;
    return age < SEND_IN_MS ? age : null;
  });
  // The entrance, decided once from the bubble's rest box on the frame
  // before its first paint — after the scroll engine has parked the turn,
  // whose layout effects run after this child's: a transform-only slide
  // from the composer field (`bubble-send-flip`), else the plain 18px
  // rise. Applied straight to the element so no React render sits between
  // the measurement and the first frame; the class comes off at
  // animationend, and `entrance` stays "" so re-renders leave it alone.
  const bubbleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (entering == null) return;
    const el = bubbleRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      // One screen of travel at most: the turn parks at the top of the
      // transcript, so the flight from the field is about the window's
      // height. Both boxes are on screen, so it can never be more.
      const cap = Math.max(600, window.innerHeight);
      const offset = sendOffset(sendOrigin(), el.getBoundingClientRect(), cap);
      if (offset) {
        el.style.setProperty("--send-dx", `${offset.dx}px`);
        el.style.setProperty("--send-dy", `${offset.dy}px`);
      }
      el.classList.add(offset ? "bubble-send-flip" : "bubble-send-in");
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: the entrance is decided once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const settleEntrance = (e: AnimationEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove("bubble-send-flip", "bubble-send-in");
    e.currentTarget.style.removeProperty("--send-dx");
    e.currentTarget.style.removeProperty("--send-dy");
    setEntering(null);
  };
  const card = block.secondOpinion;
  const note = block.noteCard;
  const text = card && card.kind !== "handoff" ? "" : block.text;
  const chat = layout === "chat";

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !text) {
      setOverflows(false);
      return;
    }
    if (expanded) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const toggle = () => {
    if (overflows) setExpanded((value) => !value);
  };

  return (
    <div
      className={
        chat ? "flex justify-end pt-1.5 pl-10" : "pt-1.5"
      }
    >
      <div
        ref={bubbleRef}
        className={`group/message relative min-w-0 bg-content/10 px-3 py-2 font-sans text-content ${
          chat
            ? "w-fit max-w-xl rounded-xl"
            : "rounded-xl"
        }`}
        style={
          entering == null
            ? { zIndex: stickyIndex }
            : { zIndex: stickyIndex, animationDelay: `${-entering}ms` }
        }
        onAnimationEnd={entering == null ? undefined : settleEntrance}
        onClick={overflows ? toggle : undefined}
      >
        {text || block.attachments?.length ? (
          <CopyMessageButton text={text} attachments={block.attachments ?? []} chat={chat} />
        ) : null}
        {block.attachments?.length ? (
          <div
            className={`flex flex-wrap gap-1.5 ${text || card || note ? "mb-2" : ""}`}
          >
            {block.attachments.map((file) => (
              <AttachmentChip
                key={file.id}
                environmentId={environmentId}
                attachment={file}
                onOpen={
                  file.kind === "image"
                    ? () => openAttachmentImages(environmentId, block.attachments ?? [], file)
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
        {note ? (
          <div className={text || card ? "mb-2" : ""}>
            <NoteMiniCard card={note} embedded />
          </div>
        ) : null}
        {card ? (
          <div className={text ? "mb-1.5" : undefined}>
            <SecondOpinionCard card={card} />
          </div>
        ) : null}
        {block.preamble ? (
          <PreambleRow text={block.preamble.text} words={block.preamble.words} />
        ) : null}
        {text ? (
          <pre
            ref={textRef}
            className={`min-w-0 whitespace-pre-wrap break-words font-sans text-sm ${expanded ? "" : "line-clamp-4"}`}
          >
            <UserText text={text} />
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A user's words, with each `@thread:<id>` as a chip that opens the thread
 * and each `/command` the session knows as the addon it names.
 */
function UserText({ text }: { text: string }) {
  const titleOf = useThreadTitles(text);
  const commands = useKnownCommands(useTranscriptSession());
  const onSelectSession = useContext(SelectSessionContext);
  const parts: (ThreadMentionPart | CommandPart)[] = threadMentionParts(text, titleOf).flatMap(
    (part): (ThreadMentionPart | CommandPart)[] => ("id" in part ? [part] : commandParts(part.text, commands)),
  );
  if (parts.length === 1 && "text" in parts[0]) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        "id" in part ? (
          <button
            key={index}
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-content/10 px-1 align-baseline text-[13px] text-content hover:underline"
            onClick={(event) => {
              event.stopPropagation();
              onSelectSession?.(part.id);
            }}
          >
            <MessageSquare className="size-3 opacity-60" />
            {part.title}
          </button>
        ) : "command" in part ? (
          <CommandChip key={index} command={part.command} />
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** One activity row: py-1 around a 20px line. */
const ACTIVITY_ROW_HEIGHT = "h-7";

const DISCLOSURE_ROW = "flex w-fit items-center gap-1.5 py-1 font-sans text-sm";

/**
 * The default transcript's tool stack: the call the agent is on holds the
 * line, and everything it has already finished waits behind a disclosure.
 */
function ActivityGroup({
  blocks,
  cwd,
  autoOpen = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  /** The group the agent is in: it opens by itself once a second call lands. */
  autoOpen?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession();
  const [override, setOverride] = usePersistedOpen(
    `${sessionId ?? "-"}:g:${blocks[0]?.id}`,
  );
  const { latest, pending, hidden } = splitActivityRows(blocks);
  const showPrevious = override ?? (autoOpen && hidden.length > 0);
  const reduceMotion = useReducedMotion() === true;
  // The fold tweens over rows that exist: mount them a frame before opening
  // and keep them through the close.
  const [mounted, setMounted] = useState(showPrevious);
  useLayoutEffect(() => {
    if (showPrevious) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), TWEEN_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [showPrevious]);

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {hidden.length > 0 ? (
        <button
          type="button"
          aria-expanded={showPrevious}
          aria-label={
            showPrevious
              ? "Hide previous tool calls"
              : `Show ${hidden.length} previous tool calls`
          }
          onClick={() => setOverride(!showPrevious)}
          className={`${DISCLOSURE_ROW} ${ACTIVITY_ROW_HEIGHT} shrink-0 text-content/40 transition-colors hover:text-content/70`}
        >
          <ChevronRight
            className={`size-3.5 shrink-0 transition-transform duration-150 ${
              showPrevious ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
          />
          <span>
            {showPrevious
              ? "Hide previous"
              : activityPreviousLabel(hidden.length)}
          </span>
        </button>
      ) : null}
      {mounted && hidden.length > 0 ? (
        <TweenHeight
          open={showPrevious && mounted}
          animate={!reduceMotion}
          className="flex flex-col gap-0.5"
        >
          {hidden.map((block) => (
            <ActivityRow
              key={block.id}
              block={block}
              cwd={cwd}
              expanded
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </TweenHeight>
      ) : null}
      {latest ? (
        <ActivityRow
          block={latest}
          cwd={cwd}
          live
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ) : null}
      {pending.map((block) => (
        <ActivityRow
          key={block.id}
          block={block}
          cwd={cwd}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

/**
 * Zen's activity view: the turn's work as phases. A phase is a run of related
 * calls under the line the agent wrote to introduce it — "now I need to find
 * the theme provider", then the searches and reads that followed. The phase
 * the agent is in stays open, with new steps scrolling inside a short window;
 * the moment it moves on the phase folds back to its header, so a long turn
 * ends up as a handful of labelled groups sitting above the answer.
 */
function ActivityPhases({
  blocks,
  cwd,
  done,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  done?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const phases = useMemo(() => buildActivityPhases(blocks), [blocks]);

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {phases.map((phase, index) => (
        <ActivityPhaseGroup
          key={phase.id}
          phase={phase}
          cwd={cwd}
          active={!done && index === phases.length - 1}
          onApproval={onApproval}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

/**
 * Keep a live phase body on its newest step. Pinning happens in layout
 * before paint so the window follows without a visible hitch; only a real
 * wheel away from the bottom pauses that.
 */
function useLivePhaseScroll(
  el: HTMLDivElement | null,
  enabled: boolean,
  steps: Block[],
) {
  const stickToBottom = useRef(true);
  const wasEnabled = useRef(false);

  useLayoutEffect(() => {
    if (!enabled) {
      wasEnabled.current = false;
      return;
    }
    if (!wasEnabled.current) {
      stickToBottom.current = true;
      wasEnabled.current = true;
    }
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [el, enabled, steps]);

  useEffect(() => {
    if (!el || !enabled) return;

    const pin = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      if (isNearBottom(el)) stickToBottom.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (!nestedScrollAbsorbsWheel(el, e.deltaY)) return;
      if (e.deltaY < 0) stickToBottom.current = false;
      e.stopPropagation();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    const inner = el.firstElementChild;
    const observer = new ResizeObserver(pin);
    if (inner) observer.observe(inner);
    pin();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [el, enabled]);
}

/**
 * One phase: a header the whole group hangs off, and the steps under it on a
 * rail. Folding is automatic — the group opens while it is the live one and
 * closes when the agent moves on — until you click, after which it stays where
 * you put it. A step still waiting on you keeps the group open regardless.
 * While live, the open body stays a short scrolling window pinned to the
 * newest step; after the turn settles an opened group is full height again.
 */
/** A driver error row: gray Stopped, or Failed with Continue when the tree can. */
function ErrorRowView({ block }: { block: Block }) {
  const session = useTurnState();
  const sessionId = useTranscriptSession();
  // The tree's continue flag lives on the meta until the projection carries it.
  const meta = useSessionMeta(sessionId);
  const row = errorRowOf(
    session
      ? { ...session, treeCanContinue: session.treeCanContinue ?? meta?.treeCanContinue }
      : { blocks: [block], status: "idle", thread: undefined },
    block,
  );
  if (!sessionId) return null;
  return (
    <div className="py-1">
      <ErrorChip sessionId={sessionId} row={row} busy={session?.busy} />
    </div>
  );
}

/** What the turn-pass did between turns: a compact line, not a system dump. */
function PassRow({ actions }: { actions: string[] }) {
  return (
    <div className="flex items-center gap-2 py-1 font-sans text-[12px] text-content/40">
      <span className="text-content/40">Pass</span>
      <span className="min-w-0 truncate">{actions.join(" · ")}</span>
    </div>
  );
}

function ActivityPhaseGroup({
  phase,
  cwd,
  active,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  phase: ActivityPhase;
  cwd?: string;
  active: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession();
  const [override, setOverride] = usePersistedOpen(
    `${sessionId ?? "-"}:p:${phase.id}`,
  );
  const waiting = phase.steps.some(awaitsUser);
  // The live phase opens on its second step; a reader's choice is remembered.
  const open = waiting || (override ?? (active && phase.steps.length > 1));
  const [liveScroller, setLiveScroller] = useState<HTMLDivElement | null>(null);
  useLivePhaseScroll(liveScroller, active && open, phase.steps);
  const title = activityPhaseTitle(phase, active, cwd);
  // Edits outlive the fold: a closed group still shows what it changed, with
  // the counts, while the reads and searches around them stay tucked away.
  const edits = phase.steps.filter(
    (block) => isEditBlock(block) && !needsApproval(block) && !block.question,
  );

  // A lone call is not a group: a header repeating the single row under it
  // says nothing twice.
  if (phase.steps.length === 1) {
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        <ActivityPhaseIcon kind={phase.kind} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <ActivityRow
            block={phase.steps[0]}
            cwd={cwd}
            variant="phase"
            live={active}
            onApproval={onApproval}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
          />
        </div>
      </div>
    );
  }

  const label = active ? (
    <Shimmer
      className="min-w-0 flex-1 truncate font-sans text-sm"
    >
      {title}
    </Shimmer>
  ) : (
    // Dimmed to sit with the icons: the work is chrome around the answer, and
    // only the answer reads at full strength.
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors group-hover:text-content/70">
      {title}
    </span>
  );

  const reauth = open ? undefined : reauthOf(phase.steps);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={
          open ? `Hide the steps for ${title}` : `Show the steps for ${title}`
        }
        onClick={() => setOverride(!open)}
        className="group flex w-full min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        {/*
         * The two icons share one 14px box, so the swap is instant: fading
         * between them leaves both half-drawn on top of each other.
         */}
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <ActivityPhaseIcon
            kind={phase.kind}
            className="group-hover:opacity-0"
          />
          <ChevronRight
            className={`absolute size-3.5 text-content/40 opacity-0 transition-transform duration-150 group-hover:opacity-100 ${
              open ? "rotate-90" : ""
            }`}
            strokeWidth={1.75}
          />
        </span>
        {label}
      </button>
      {reauth ? <ReconnectChip reauth={reauth} /> : null}
      </div>
      <div className="zen-phase-body" data-open={open}>
        <div
          ref={setLiveScroller}
          className={active || !open ? "zen-phase-live" : undefined}
        >
          <div className="flex min-w-0 flex-col">
            {phase.steps.map((block) => (
              <div
                key={block.id}
                className={`zen-phase-step${active ? " zen-step-in" : ""}`}
              >
                <ActivityRow
                  block={block}
                  cwd={cwd}
                  variant="phase"
                  live={active}
                  onApproval={onApproval}
                  onOpenFile={onOpenFile}
                  onOpenDiff={onOpenDiff}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {!open && edits.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 pb-1 pl-5">
          {edits.flatMap((block) => splitEditCards(block).cards).map((block) => (
            <EditRow
              key={block.id}
              block={block}
              cwd={cwd}
              onOpenFile={onOpenDiff ?? onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What the group was for, at a glance: look, change, run, think. */
function ActivityPhaseIcon({
  kind,
  className = "",
}: {
  kind: ActivityPhaseKind;
  className?: string;
}) {
  const props = {
    className: `size-3.5 shrink-0 text-content/40 ${className}`,
    strokeWidth: 1.75,
  };
  if (kind === "edit") return <PenLine {...props} />;
  if (kind === "research") return <Search {...props} />;
  if (kind === "run") return <Terminal {...props} />;
  if (kind === "think") return <Sparkles {...props} />;
  if (kind === "other") return <Wrench {...props} />;
  return <Minus {...props} />;
}

/**
 * One step of the agent's work, whatever that step was: a tool call, a thought,
 * a paragraph. In a phase the rail draws the bullet, so the row drops its own
 * leading icon and leans on the rail instead.
 */
function ActivityRow({
  block,
  cwd,
  expanded = false,
  live = false,
  variant = "stack",
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  expanded?: boolean;
  live?: boolean;
  variant?: "stack" | "phase";
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const railed = variant === "phase";
  if (isThinkingBlock(block)) {
    return (
      <ActivityThinkingRow
        block={block}
        cwd={cwd}
        expandable={expanded || railed}
        bare={railed}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (isProseBlock(block)) {
    if (railed) {
      return (
        <ActivityNoteRow
          block={block}
          cwd={cwd}
          bare
          expandable
          onOpenFile={onOpenFile}
        />
      );
    }
    return expanded ? (
      <div className="flex min-w-0 gap-1.5 py-1 text-content">
        <Minus
          className="mt-[5px] size-3.5 shrink-0 text-content/50"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <AgentMarkdown text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      </div>
    ) : (
      <ActivityNoteRow block={block} />
    );
  }
  if (isEditBlock(block) && !needsApproval(block) && !block.question) {
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <div key={card.id} className="py-1">
            <EditRow block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
          </div>
        ))}
        {internal ? (
          <ActivityToolRow
            block={internal}
            cwd={cwd}
            live={live}
            bare={railed}
            onOpenFile={onOpenFile}
          />
        ) : null}
        {/* A decided board leaves its one-line verdict under the edit it judged. */}
        <ApprovalControls block={block} onApproval={onApproval} />
      </>
    );
  }
  return (
    <ActivityToolRow
      block={block}
      cwd={cwd}
      live={live}
      bare={railed}
      onApproval={onApproval}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
    />
  );
}

/**
 * The line that keeps a long think from reading as a stall. Opening the fold
 * around it does not open the thought itself — reasoning is only ever read on
 * purpose, one line until you ask for it.
 */
function ActivityThinkingRow({
  block,
  cwd,
  expandable = false,
  bare = false,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  expandable?: boolean;
  bare?: boolean;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  // The thought mounts on first open and stays; the grid track does the reveal.
  const [mounted, setMounted] = useState(false);
  // A thought we watched arrive rises in; history sits still.
  const [fresh] = useState(!!block.streaming);
  const text = proseSummary(block.text) || "Thinking";
  // In a group the rail is the bullet, so there is nothing to breathe while
  // reasoning streams in — the line itself does.
  const pulse = block.streaming ? "zen-thinking-pulse" : "";
  const icon = bare ? null : (
    <Minus
      className={`size-3.5 shrink-0 text-content/40 ${pulse}`}
      strokeWidth={1.75}
    />
  );
  const label = (
    <span
      className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 ${
        bare ? pulse : ""
      }`}
    >
      {text}
    </span>
  );

  if (!expandable) {
    return (
      <div
        aria-label={`Thinking: ${text}`}
        className={`flex min-w-0 items-center gap-1.5 py-1 ${fresh ? "z-fade-in" : ""}`}
      >
        {icon}
        {label}
      </div>
    );
  }

  return (
    <div className={`flex min-w-0 flex-col ${fresh ? "z-fade-in" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide thinking" : `Show thinking: ${text}`}
        onClick={() => {
          setMounted(true);
          setOpen((value) => !value);
        }}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        {icon}
        <span
          className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors group-hover:text-content/70 ${
            bare ? pulse : ""
          }`}
        >
          {text}
        </span>
      </button>
      <div
        className="thinking-body grid"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          {mounted ? (
            <div className={`min-w-0 pb-2 ${bare ? "" : "pl-5"}`}>
              <AgentMarkdown
                className="agent-reasoning"
                text={block.text}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A line the agent wrote mid-run, kept to one line. It opens on click, so
 * folding the work never costs you a paragraph you wanted to read.
 */
function ActivityNoteRow({
  block,
  cwd,
  bare = false,
  expandable = false,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  bare?: boolean;
  expandable?: boolean;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  const text = proseSummary(block.text);
  const icon = bare ? null : (
    <Minus className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
  );

  if (!expandable) {
    return (
      <div
        aria-label={`Agent said: ${text}`}
        className="flex min-w-0 items-center gap-1.5 py-1"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/70">
          {text}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide the full note" : `Agent said: ${text}`}
        onClick={() => setOpen((value) => !value)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/70 transition-colors group-hover:text-content">
          {text}
        </span>
      </button>
      {open ? (
        <div className="min-w-0 pb-2">
          <AgentMarkdown text={block.text} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      ) : null}
    </div>
  );
}

function ActivityToolRow({
  block,
  cwd,
  live = false,
  bare = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  block: Block;
  cwd?: string;
  live?: boolean;
  bare?: boolean;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const label = toolCallLabel(block, cwd);
  const state = toolCallState(block);
  const pending = needsApproval(block);
  const openFile = isEditTool(
    block.tool?.kind,
    block.text || block.tool?.title,
    block.tool?.preview,
  )
    ? (onOpenDiff ?? onOpenFile)
    : onOpenFile;
  // A call we watched start rises in; rows already settled at mount sit still.
  const [fresh] = useState(live && state === "pending");
  const [open, setOpen] = useState(false);
  const app = useAppView(block);
  // Every call opens onto its details; the body mounts only once asked for.
  const expandable = !!block.tool && !pending && !block.question;
  // The app's own tools (mcp__app__*) are the app itself, not a connector —
  // no brand reads on them. Everything else that went through MCP gets the
  // connector's mark: a real logo where we have one, a plug glyph otherwise.
  const mcpServer = mcpServerOf(block.tool?.name ?? "");
  const connector = mcpServer && mcpServer !== "app" ? mcpServer : null;

  return (
    <div data-block={block.id} className={`flex min-w-0 flex-col ${fresh ? "z-fade-in" : ""}`}>
      <div
        aria-label={`Tool call: ${label}`}
        className={`group/tool flex min-w-0 items-center gap-1.5 py-1 ${expandable ? "cursor-pointer" : ""}`}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
      >
        {bare ? null : state === "pending" ? (
          <ActivityToolIcon state={state} live={live} />
        ) : block.tool?.display?.app ? (
          <ConnectorMark app={block.tool.display.app} />
        ) : isAgentCall(block) ? (
          <SubagentMark block={block} />
        ) : connector ? (
          <ConnectorMark app={connector} />
        ) : (
          <ActivityToolIcon state={state} live={live} />
        )}
        {block.tool?.display?.app ? (
          <ConnectorSummary display={block.tool.display} chip={bare} failed={state === "rejected"} />
        ) : app ? (
          <AppToolSummary view={app} chip={bare} failed={state === "rejected"} agent={isAgentCall(block)} />
        ) : (
          <ToolCallSummary
            label={label}
            preview={block.tool?.preview}
            cwd={cwd}
            chip={bare}
            failed={state === "rejected"}
            onOpenFile={openFile}
          />
        )}
        <SubagentSteps count={block.tool?.subCount} />
        <CallPortLink callId={block.tool?.callId} />
        {block.tool?.reauth ? <ReconnectChip reauth={block.tool.reauth} /> : null}
        {pending || block.question ? null : <ToolCallStatusIcon state={state} />}
        {expandable ? <ToolDisclosure open={open} /> : null}
      </div>
      {open && expandable ? <ToolDetails block={block} /> : null}
      {/* Pending: the board. Decided: its one-line verdict. Neither: nothing. */}
      <ApprovalControls block={block} onApproval={onApproval} />
      {block.question ? <QuestionCard question={block.question} /> : null}
    </div>
  );
}

/** The chevron that opens a row onto its details: quiet until hovered. */
function ToolDisclosure({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`ml-auto size-3.5 shrink-0 text-content/40 transition-transform duration-150 ${
        open ? "rotate-90" : "opacity-0 group-hover/tool:opacity-100"
      }`}
      strokeWidth={1.75}
    />
  );
}

function ActivityToolIcon({
  state,
  live = false,
}: {
  state: ToolCallState;
  live?: boolean;
}) {
  if (state === "pending") {
    return (
      <CircleDashed
        className={`size-3.5 shrink-0 text-content/40 ${live ? "zen-tool-spin" : ""}`}
        strokeWidth={1.75}
      />
    );
  }

  return (
    <Minus className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
  );
}

/** Failure stays marked. Running and success do not get a trailing icon. */
function ToolCallStatusIcon({ state }: { state: ToolCallState }) {
  if (state === "rejected") {
    return <X className="size-3.5 shrink-0 text-danger" strokeWidth={2} />;
  }
  return null;
}


function formatWorkingDuration(elapsedMs: number | null, done = false): string {
  if (elapsedMs == null) return done ? "Worked" : "Working…";
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  const label = done ? "Worked for" : "Working for";
  if (totalSec < 60) return `${label} ${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${label} ${minutes}m ${seconds}s` : `${label} ${minutes}m`;
}

function ToolCall({
  block,
  cwd,
  onApproval,
  onOpenFile,
  onOpenDiff,
  embedded,
  plain = false,
}: {
  block: Block;
  cwd?: string;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  embedded?: boolean;
  /** Render as a plain tool row even when the call is an edit (a memory-file edit). */
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const app = useAppView(block);
  const preview = block.tool?.preview;
  const label = toolCallLabel(block, cwd);
  const state = toolCallState(block);
  const stateLabel =
    state === "accepted"
      ? "Accepted"
      : state === "rejected"
        ? "Rejected"
        : "Pending";
  const editTool = isEditTool(
    block.tool?.kind,
    block.text || block.tool?.title,
    preview,
  );
  // Every call opens onto its details; the body mounts only once asked for.
  const expandable = !!block.tool && !needsApproval(block);

  const frame = embedded ? "py-0.5" : "py-1";

  if (block.question) {
    return (
      <div className={frame}>
        <div className="text-[12px] text-content/50">{label}</div>
        <QuestionCard question={block.question} />
      </div>
    );
  }

  if (editTool && !plain) {
    if (needsApproval(block)) {
      return (
        <div className={frame}>
          <FilePreview
            preview={preview ?? stubFilePreview(block.tool?.kind, label)}
            status={state}
            cwd={cwd}
            onOpenFile={onOpenDiff ?? onOpenFile}
          />
          <ApprovalControls block={block} onApproval={onApproval} />
        </div>
      );
    }
    // One card per file the call touched; app bookkeeping as a quiet row.
    const { cards, internal } = splitEditCards(block);
    return (
      <>
        {cards.map((card) => (
          <div key={card.id} className={frame}>
            <EditRow block={card} cwd={cwd} onOpenFile={onOpenDiff ?? onOpenFile} />
          </div>
        ))}
        {internal ? (
          <ToolCall block={internal} cwd={cwd} embedded={embedded} onOpenFile={onOpenFile} plain />
        ) : null}
      </>
    );
  }

  if (isIncompleteTool(block, label, state)) return null;

  return (
    <div className={frame}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${stateLabel} tool call: ${label}`}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 text-left"
        >
          <ToolCallIcon state={state} />
          {app ? (
            <AppToolSummary view={app} failed={state === "rejected"} />
          ) : (
            <ToolCallSummary
              label={label}
              preview={preview}
              cwd={cwd}
              failed={state === "rejected"}
              onOpenFile={onOpenFile}
            />
          )}
          <ChevronRight
            className={`size-3.5 shrink-0 text-content/40 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      ) : (
        <div
          aria-label={`${stateLabel} tool call: ${label}`}
          className="flex w-full min-w-0 items-center gap-2"
        >
          <ToolCallIcon state={state} />
          {app ? (
            <AppToolSummary view={app} failed={state === "rejected"} />
          ) : (
            <ToolCallSummary
              label={label}
              preview={preview}
              cwd={cwd}
              failed={state === "rejected"}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      )}
      {/* Outside the row's button: a dev server the call opened. */}
      <div className="flex pl-5">
        <CallPortLink callId={block.tool?.callId} />
      </div>
      {open && expandable ? <ToolDetails block={block} /> : null}
      <ApprovalControls block={block} onApproval={onApproval} />
    </div>
  );
}

function ToolCallSummary({
  label,
  preview,
  cwd,
  onOpenFile,
  interactive = true,
  chip = false,
  failed = false,
}: {
  label: string;
  preview?: ToolPreview;
  cwd?: string;
  onOpenFile?: OpenFileFn;
  interactive?: boolean;
  /** Sets the file off in a chip, for rows that lean on a rail for structure. */
  chip?: boolean;
  failed?: boolean;
}) {
  // A path the thread named opens on the thread's host (lib/pathHost.ts).
  const threadHost = useTranscriptHost();
  const parts = label.match(/^(Read|Find|Skill|List|Edit|Write)\s+(.+)$/);
  // A write preview carries the path itself, so edits get the same verb + file
  // chip as reads rather than falling through to a raw label.
  const writeTarget =
    preview?.kind === "write"
      ? preview.path
        ? displayPath(preview.path, cwd)
        : preview.fileName
      : undefined;
  const action =
    parts?.[1] ??
    (writeTarget ? editVerb(label) : undefined) ??
    (/^read$/i.test(label.trim()) && (preview?.path || preview?.fileName)
      ? "Read"
      : /^find$/i.test(label.trim()) && preview?.query
        ? "Find"
        : /^list$/i.test(label.trim()) && (preview?.path || preview?.fileName)
          ? "List"
          : /^skill$/i.test(label.trim())
            ? "Skill"
            : undefined);
  const target =
    parts?.[2] ??
    writeTarget ??
    (action === "Read" ||
    action === "List" ||
    action === "Edit" ||
    action === "Write"
      ? preview?.path
        ? displayPath(preview.path, cwd)
        : preview?.fileName
      : action === "Find"
        ? preview?.query
        : undefined);
  if (!action || !target) {
    return (
      <span
        className={`min-w-0 flex-1 truncate font-mono text-[13px] ${
          failed ? "text-danger" : chip ? "text-content/70" : "text-content/70"
        }`}
      >
        {label}
      </span>
    );
  }
  const isFile = action !== "Find" && action !== "Skill";
  const fileName =
    preview?.fileName ||
    target
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ||
    "file";
  const filePath = resolveWorkspacePath(preview?.path || target, cwd);
  const canOpen = interactive && !!onOpenFile && !!filePath;
  const actionTone = failed ? "text-danger" : "text-content/50";
  const targetTone = failed
    ? "text-danger"
    : chip
      ? "text-content/70"
      : "text-content";

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
      <span className={`shrink-0 font-sans text-sm ${actionTone}`}>
        {action}
      </span>
      {isFile ? (
        <FileRefMenu target={preview?.path || target} cwd={cwd}>
        {canOpen ? (
          <button
            type="button"
            className={`-my-0.5 flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left hover:text-info ${
              chip
                ? `max-w-full bg-content/6 hover:bg-content/10 ${targetTone}`
                : `flex-1 hover:underline ${targetTone}`
            }`}
            title={preview?.path || target}
            onClick={(event) => {
              event.stopPropagation();
              onOpenFile?.(filePath, undefined, threadHost ? { environmentId: threadHost } : undefined);
            }}
          >
            <FileTypeIcon name={fileName} isDir={action === "List"} />
            <span className="min-w-0 truncate">{target}</span>
          </button>
        ) : (
          <span
            className={`-my-0.5 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 ${
              chip
                ? `max-w-full bg-content/6 ${targetTone}`
                : `flex-1 ${targetTone}`
            }`}
            title={preview?.path || target}
          >
            <FileTypeIcon name={fileName} isDir={action === "List"} />
            <span className="min-w-0 truncate">{target}</span>
          </span>
        )}
        </FileRefMenu>
      ) : (
        <span
          className={`flex min-w-0 flex-1 items-center gap-1.5 pl-1 ${targetTone}`}
          title={target}
        >
          <span className="min-w-0 truncate">{target}</span>
        </span>
      )}
    </span>
  );
}

function ToolCallIcon({ state }: { state: ToolCallState }) {
  if (state === "rejected") {
    return <X className="size-3.5 shrink-0 text-danger" strokeWidth={2} />;
  }
  if (state === "pending") {
    return (
      <CircleDashed
        className="size-3.5 shrink-0 text-content/40"
        strokeWidth={1.75}
      />
    );
  }
  return null;
}

function ApprovalControls({
  block,
  onApproval,
}: {
  block: Block;
  onApproval?: (requestId: string | number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  if (!approval) return null;
  const detail = approvalDetailOf(block);
  const outcome = approvalOutcome(approval);
  if (approval.decided) {
    return outcome ? (
      <div className="mt-1 font-sans text-[11px] text-content/40">{outcome}</div>
    ) : null;
  }
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {detail ? <ApprovalDetailView detail={detail} /> : null}
      <div className="flex gap-2">
      <button
        type="button"
        className="rounded-md bg-content px-2.5 py-0.5 text-[11px] hover:bg-content/70     text-background-base"
        onClick={() => onApproval?.(approval.requestId, "allow")}
      >
        Allow
      </button>
      <button
        type="button"
        className="rounded-md bg-content/10 px-2.5 py-0.5 text-[11px] text-content/70 hover:bg-content/20"
        onClick={() => onApproval?.(approval.requestId, "deny")}
      >
        Deny
      </button>
      </div>
    </div>
  );
}

/** What the agent is asking to do, in the words the board can decide on. */
function ApprovalDetailView({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof approvalDetailOf>>;
}) {
  if (detail.kind === "shell") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-sans text-[12px] text-content/70">{detail.doing}</span>
        <pre className="min-w-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/6 px-2 py-1 text-[12px] text-content/70">
          {detail.command}
        </pre>
      </div>
    );
  }
  if (detail.kind === "file") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-sans text-[12px] text-content/70">Write {detail.path}</span>
        {detail.added.length ? (
          <pre className="min-w-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/6 px-2 py-1 text-[12px] text-content/70">
            {detail.added.join("\n")}
            {detail.more ? "\n…" : null}
          </pre>
        ) : null}
      </div>
    );
  }
  return (
    <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {detail.entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-content/40">{key}</dt>
          <dd className="min-w-0 truncate text-content/70">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HandoffDivider({ block }: { block: Block }) {
  const meta = block.handoff;
  if (!meta) return null;

  const preparing = meta.status === "preparing";
  const label = preparing ? "Preparing a handoff" : HARNESS_TITLE[meta.to];

  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <div className="h-px min-w-4 flex-1 bg-content/10" />
        <div
          role="separator"
          aria-label={
            preparing
              ? `Preparing a handoff to ${HARNESS_TITLE[meta.to]}`
              : `Continued with ${label}`
          }
          className="flex max-w-[min(100%,20rem)] items-center gap-1.5 px-1.5 font-sans text-[12px] text-content/50"
        >
          {preparing ? (
            <>
              <TerminalSpinner className="text-content/40" />
              <Shimmer>{label}</Shimmer>
            </>
          ) : (
            <>
              <HarnessIcon harness={meta.to} className="size-3.5 shrink-0" />
            </>
          )}
        </div>
        <div className="h-px min-w-4 flex-1 bg-content/10" />
      </div>
    </div>
  );
}

function lastUserBlockId(blocks: Block[]): string | undefined {
  return turnUserBlock(blocks)?.id;
}

/** Within a line or two of the end of a nested scroller. */
function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
}

/**
 * A live turn with nothing to show yet ends in a "Thinking" shimmer: after
 * the prompt, behind an empty reasoning block, or before the first word of
 * the answer. The next content takes that slot, so nothing jumps.
 */
function showsThinkingTail(turn: Block[]): boolean {
  const last = turn[turn.length - 1];
  if (!last || last.role === "user") return true;
  if (last.role === "reasoning" || last.role === "assistant") return !last.text;
  return false;
}

const stampFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** When the prompt went out, shown under it while the turn is hovered.
 *  The row is reserved even without a time, so every bubble sits the same
 *  16px above what follows. */
function TurnStamp({ ts, chat }: { ts?: number; chat: boolean }) {
  return (
    <div
      className={`flex h-4 items-center font-sans text-[11px] tabular-nums text-content/40 opacity-0 transition-opacity group-hover/turn:opacity-100 ${
        chat ? "justify-end" : ""
      }`}
    >
      {ts == null ? null : stampFormat.format(ts)}
    </div>
  );
}
