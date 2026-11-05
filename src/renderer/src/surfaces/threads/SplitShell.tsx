import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { refreshToastAnchor } from "../../lib/toastAnchor";
import { Toggle } from "../../components/ui/toggle";
import { TruncateTip } from "../../components/tip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import { MessageSquare } from "../../chrome/icons";
import { BackButton, useViewBack } from "./viewBack";
import { useSashKeys } from "../../hooks/useSashKeys";
import { animate } from "motion/react";
import { SPRING_GLIDE } from "../../lib/ease";
import { pushSample, releaseVelocity, rubber, suppressTextSelection, type DragSample } from "../../lib/drag";

/**
 * The board | sash | chat recipe every thread view with a board shares.
 * The board sits left at `split%` (30–70, double-click resets to 50) under
 * one 36px header: the view's title, one muted state line, its actions and
 * the conversation toggle. A board that asks for a `fit` (px) gets that
 * width, never over half the pane, until the person drags the sash;
 * double-click then goes back to the fit. Folding is a toggle, never a tween: the board
 * takes the full width at once and the chat stays mounted (`inert`,
 * `invisible`, parked at its last width) so the transcript keeps its
 * measurements; unfolding returns it to its slot, its content fading in.
 * The board fades in when it arrives live (opacity only, `--dur-base`), not
 * when it was already there at mount; without one (`hasBoard` false: a
 * master with an empty batch, a plan with no document yet) the chat fills
 * the pane with no header, sash or fold, and a board that leaves goes in
 * the same frame the chat takes the width. Beside the board the chat never goes under 360px: the
 * board yields first (DESIGN "Panels").
 */

/** The split's bounds in percent of the shell. A fitted board drawn under
 *  30% keeps its own width as the lower bound for the drag that starts there. */
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;

export type SplitState = {
  split: number;
  setSplit: (n: number) => void;
  /** The person dragged the sash: their split wins over a fitted width. */
  manual: boolean;
  setManual: (manual: boolean) => void;
  dragging: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  startDrag: (e: React.PointerEvent<HTMLElement>) => void;
};

/**
 * The board's share of the shell and the sash's drag. A drag starts from the
 * board as drawn (a fitted width included), so a grab never jumps it; it holds
 * the pointer (capture), keeps text from selecting, follows the rubber band
 * past its bounds and, released, settles back inside them on SPRING_GLIDE with
 * the pointer's speed. Escape glides it back to where the drag began. Reduced
 * motion settles at once.
 */
export function useSplit(initial = 50): SplitState {
  const [split, setSplitState] = useState(initial);
  const [manual, setManual] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef(initial);
  const settle = useRef<{ stop: () => void } | null>(null);
  const setSplit = useCallback((n: number) => {
    splitRef.current = n;
    setSplitState(n);
  }, []);
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      settle.current?.stop();
      settle.current = null;
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      const board = root.querySelector<HTMLElement>("[data-board]");
      const startPct = board ? (board.getBoundingClientRect().width / rect.width) * 100 : splitRef.current;
      const lo = Math.min(SPLIT_MIN, startPct);
      const manualAtStart = manual;
      const startX = e.clientX;
      const pointerId = e.pointerId;
      const handle = e.currentTarget;
      const toPct = (px: number) => (px / rect.width) * 100;
      const startPx = (startPct / 100) * rect.width;
      const samples: DragSample[] = [];
      let moved = false;
      handle.setPointerCapture?.(pointerId);
      setDragging(true);
      const restoreSelection = suppressTextSelection();
      document.body.style.cursor = "col-resize";
      document.documentElement.classList.add("is-resizing");
      const glideTo = (to: number, velocity: number, done?: () => void) => {
        const from = splitRef.current;
        if (from === to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setSplit(to);
          done?.();
          return;
        }
        settle.current = animate(from, to, { ...SPRING_GLIDE, velocity, onUpdate: setSplit, onComplete: done });
      };
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        if (!moved) {
          moved = true;
          setManual(true);
        }
        const px = startPx + ev.clientX - startX;
        pushSample(samples, toPct(px), ev.timeStamp);
        setSplit(toPct(rubber(px, (lo / 100) * rect.width, (SPLIT_MAX / 100) * rect.width)));
      };
      const end = (): void => {
        setDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey, true);
        handle.removeEventListener("lostpointercapture", onLost);
        try {
          handle.releasePointerCapture?.(pointerId);
        } catch {
          /* already released */
        }
        restoreSelection();
        document.body.style.cursor = "";
        document.documentElement.classList.remove("is-resizing");
      };
      const release = (now: number): void => {
        end();
        if (!moved) return;
        const current = splitRef.current;
        glideTo(Math.min(SPLIT_MAX, Math.max(lo, current)), releaseVelocity(samples, now));
      };
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) release(ev.timeStamp);
      };
      const onLost = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) release(ev.timeStamp);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        end();
        if (!moved) return;
        // Back to where the drag began; a board that was drawn at its fit goes back to the fit.
        glideTo(startPct, 0, () => {
          if (!manualAtStart) setManual(false);
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey, true);
      handle.addEventListener("lostpointercapture", onLost);
    },
    [manual, setSplit],
  );
  useEffect(() => () => settle.current?.stop(), []);
  return { split, setSplit, manual, setManual, dragging, rootRef, startDrag };
}

/** True once the board has painted: a board there at mount (or within
 *  800ms of it) is true at once and skips the fade; one arriving later is
 *  false for its first frame so it fades in. A board that leaves resets
 *  it, so its next arrival fades again. */
function useLiveEntry(has: boolean): boolean {
  const mountedAt = useRef(performance.now());
  const [entered, setEntered] = useState(false);
  if (!has && entered) setEntered(false);
  useEffect(() => {
    if (!has) return;
    const live = performance.now() - mountedAt.current > 800;
    if (!live) {
      setEntered(true);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [has]);
  return has && entered;
}

/** The shell's width while a fitted board is drawn, for the keys to read the board's share. */
function useShellWidth(ref: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return width;
}

/** The chat column's width while it is shown, so a fold can park it there. */
function useShownWidth(ref: React.RefObject<HTMLDivElement | null>, shown: boolean): number | undefined {
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el || !shown || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, shown]);
  return width;
}

/** The header's conversation toggle: pressed while the chat is shown. */
export function ChatToggle({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Toggle size="sm" aria-label="Conversation" pressed={open} onPressedChange={(p) => onToggle(p)} />}
      >
        <MessageSquare />
      </TooltipTrigger>
      <TooltipContent>Conversation</TooltipContent>
    </Tooltip>
  );
}

function ViewHeader({
  title,
  detail,
  actions,
  chatOpen,
  onToggleChat,
}: {
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  chatOpen: boolean;
  onToggleChat: (open: boolean) => void;
}) {
  const heading = <span data-view-title className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</span>;
  // Opened from a master's board, the header leads with Back (viewBack.tsx)
  // and the child pane draws no bar of its own.
  const back = useViewBack();
  // The title reads as the header (14px semibold) over 13px rows; its one
  // fact sits 8px after it at 12px, muted. The controls are equal 28px
  // squares 2px apart, the last ending on the rows' 12px right edge.
  return (
    <div data-view-header className={`flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pr-3 ${back ? "pl-2" : "pl-3"}`}>
      {back ? <BackButton onBack={back} /> : null}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {typeof title === "string" ? <TruncateTip text={title}>{heading}</TruncateTip> : heading}
        {detail ? (
          <span data-view-detail className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {detail}
          </span>
        ) : null}
      </div>
      <div data-view-actions className="flex shrink-0 items-center gap-0.5">
        <TooltipProvider>
          {actions}
          <ChatToggle open={chatOpen} onToggle={onToggleChat} />
        </TooltipProvider>
      </div>
    </div>
  );
}

export function SplitShell({
  board,
  chat,
  hasBoard,
  collapsed,
  onToggleChat,
  title,
  detail,
  actions,
  held,
  fit,
  splitState,
  className = "",
}: {
  /** The board's body; the header is drawn from `title`. */
  board: ReactNode;
  chat: ReactNode;
  /** The board has something to show; without it the chat fills the pane. */
  hasBoard: boolean;
  /** The chat is folded away. */
  collapsed: boolean;
  onToggleChat: (open: boolean) => void;
  /** The header's title; omitted, no header (the view draws its own). */
  title?: ReactNode;
  /** One muted state line after the title. */
  detail?: ReactNode;
  /** The view's buttons, before the conversation toggle. */
  actions?: ReactNode;
  /** The thread's paused row (`heldRowOf`): under the header while the
   *  chat is folded, so a pause is never out of sight; with the chat
   *  shown its own strip says it, and this is not drawn. */
  held?: ReactNode;
  /** The board's wanted width in px while the chat shows, capped at half
   *  the pane; a drag replaces it, a double-click on the sash restores it. */
  fit?: number;
  /** The split, held by a view that unmounts the shell for a while (the master
   *  board's child pane) so the person's split is there when it comes back. */
  splitState?: SplitState;
  className?: string;
}) {
  const ownSplit = useSplit(50);
  const { split, setSplit, manual, setManual, dragging, rootRef, startDrag } = splitState ?? ownSplit;
  const fitted = fit !== undefined && !manual;
  const basis = fitted ? `min(${String(fit)}px, 50%)` : `${String(split)}%`;
  const shellWidth = useShellWidth(rootRef, fitted);
  // While a fit is drawn the keys move from the board as it stands, not from 50.
  const drawn = fitted && shellWidth > 0 ? Math.min((fit / shellWidth) * 100, 50) : split;
  const resetSplit = (): void => {
    if (fit !== undefined) setManual(false);
    else setSplit(50);
  };
  // The keyboard moves the split 2% (Shift 10%) of the shell, in percent.
  const sashKeys = useSashKeys({
    label: "Resize",
    orientation: "vertical",
    value: drawn,
    min: Math.min(SPLIT_MIN, drawn),
    max: SPLIT_MAX,
    getSpan: () => 100,
    onChange: (next) => {
      setManual(true);
      setSplit(next);
    },
    onReset: resetSplit,
  });
  const entered = useLiveEntry(hasBoard);
  const folded = hasBoard && collapsed;
  const chatRef = useRef<HTMLDivElement | null>(null);
  const width = useShownWidth(chatRef, !folded);
  // Continue or Stop on the held row takes the row away with the focus in
  // it: the focus lands on the conversation toggle, not the page.
  const showHeld = folded && !!held;
  // The folded chat is inert, so its footer seats no toast: the stack asks again.
  useLayoutEffect(() => {
    refreshToastAnchor();
  }, [folded]);
  const heldFocus = useRef(false);
  useLayoutEffect(() => {
    if (showHeld || !heldFocus.current) return;
    heldFocus.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    rootRef.current?.querySelector<HTMLElement>("[data-board] [aria-label='Conversation']")?.focus();
  }, [showHeld, rootRef]);
  return (
    <div ref={rootRef} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${className}`}>
      {hasBoard ? (
        <div
          data-board
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden transition-opacity duration-(--dur-base) ease-(--ease-out) [contain:layout_style] motion-reduce:transition-none ${
            entered ? "opacity-100" : "opacity-0"
          }`}
          style={{ flexBasis: folded ? "100%" : basis, flexGrow: 0, flexShrink: 1 }}
        >
          {title !== undefined ? (
            <ViewHeader
              title={title}
              detail={detail}
              actions={actions}
              chatOpen={!folded}
              onToggleChat={onToggleChat}
            />
          ) : null}
          {showHeld ? (
            <div
              data-board-held
              className="shrink-0 border-b border-border"
              onFocus={() => (heldFocus.current = true)}
              onBlur={(e) => {
                if (e.relatedTarget) heldFocus.current = false;
              }}
            >
              {held}
            </div>
          ) : null}
          {board}
        </div>
      ) : null}
      {hasBoard && !folded ? (
        <div
          {...sashKeys}
          onPointerDown={startDrag}
          className={`relative w-px shrink-0 cursor-col-resize outline-none focus-visible:bg-accent ${
            dragging ? "bg-foreground/12" : "bg-border hover:bg-foreground/7"
          }`}
        >
          {/* The hairline is the sash; this widens the grab to 8px. */}
          <span className="absolute inset-y-0 -inset-x-1" />
        </div>
      ) : null}
      <div
        ref={chatRef}
        data-chat
        inert={folded || undefined}
        style={folded && width ? { width } : undefined}
        className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
          folded ? "invisible absolute inset-y-0 right-0" : hasBoard ? "relative min-w-90 flex-1" : "relative flex-1"
        }${hasBoard ? " [contain:layout_style]" : ""}`}
      >
        <div
          className={`flex min-h-0 flex-1 flex-col transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-none ${
            folded ? "opacity-0" : "opacity-100"
          }`}
        >
          {chat}
        </div>
      </div>
    </div>
  );
}
