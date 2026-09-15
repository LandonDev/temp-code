import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare } from "../../chrome/icons";
import { EASE_DRAWER_CSS, EASE_OUT_CSS } from "../../lib/ease";
import type { SessionStatus } from "../../lib/tcserver/types";
import { StatusDot } from "./bits";

/**
 * The board | sash | chat recipe every thread view with a board shares.
 * The board sits left at `split%` (30–70, double-click resets to 50);
 * the chat column sits right and folds to a 32px edge tab. The fold is a
 * push: the board's basis tweens (280ms out, 200ms back, the drawer curve)
 * while the chat sits in a clipping shell at its pre-fold width, so it
 * slides off to the right and never re-lays out; it fades over 120ms. The
 * chat stays mounted while folded (`inert` + `invisible`) so the transcript
 * virtualizer keeps its measurements. The board grows in from zero on
 * its first appearance unless it was already there on mount.
 */

const FOLD_MS = 200;
const UNFOLD_MS = 280;
const FADE_MS = 120;

export function useSplit(initial = 50): {
  split: number;
  setSplit: (n: number) => void;
  dragging: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  startDrag: (e: React.PointerEvent) => void;
} {
  const [split, setSplit] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    setDragging(true);
    const rect = root.getBoundingClientRect();
    const onMove = (ev: PointerEvent): void => {
      setSplit(Math.min(70, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100)));
    };
    const onUp = (): void => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);
  return { split, setSplit, dragging, rootRef, startDrag };
}

/** True from the first render on — false for that first render only when
 *  `has` was already true at mount, so a restored board skips the grow-in. */
function useLiveEntry(has: boolean): boolean {
  const mountedAt = useRef(performance.now());
  const [entered, setEntered] = useState(false);
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

type Fold = {
  /** The chat is fully folded away: invisible, out of the way. */
  parked: boolean;
  /** A fold or unfold is in flight. */
  moving: boolean;
  /** The chat's width in px, frozen at the flip so it slides as one piece. */
  width: number;
  /** The fold this state was derived for. */
  folded: boolean;
};

/** Tracks a fold flip: freezes the chat's width, then parks it (or not)
 *  once the tween has played. A flip mid-flight restarts the clock. The
 *  flip is derived during render so the very first frame already slides;
 *  flipping in a layout effect let the measurement's forced layout commit
 *  a frame with no inline opacity, which snapped the fade. */
function useFold(folded: boolean, measure: () => number, reduce: boolean): Fold {
  const [fold, setFold] = useState<Fold>({ parked: folded, moving: false, width: 0, folded });
  if (fold.folded !== folded) {
    setFold({ parked: false, moving: true, width: measure(), folded });
  }
  useEffect(() => {
    if (!fold.moving) return;
    const t = setTimeout(
      () => setFold((f) => ({ ...f, parked: f.folded, moving: false })),
      reduce ? FADE_MS : fold.folded ? FOLD_MS : UNFOLD_MS,
    );
    return () => clearTimeout(t);
  }, [fold.moving, fold.folded, reduce]);
  return fold;
}

export function SplitShell({
  board,
  chat,
  hasBoard,
  collapsed,
  onOpenChat,
  status,
  className = "",
  edgeTitle = "Show conversation",
}: {
  board: ReactNode;
  chat: ReactNode;
  /** The board has something to show; without it the chat fills the pane. */
  hasBoard: boolean;
  /** The chat is folded to its edge tab. */
  collapsed: boolean;
  onOpenChat: () => void;
  status: SessionStatus | undefined;
  className?: string;
  edgeTitle?: string;
}) {
  const { split, setSplit, dragging, rootRef, startDrag } = useSplit(50);
  const reduce = useReducedMotion() ?? false;
  const entered = useLiveEntry(hasBoard);
  const folded = hasBoard && collapsed;
  const splitRef = useRef(split);
  splitRef.current = split;
  const measure = useCallback(
    () => ((rootRef.current?.clientWidth ?? 0) * (100 - splitRef.current)) / 100 - 1,
    [rootRef],
  );
  const fold = useFold(folded, measure, reduce);
  const boardBasis = !hasBoard || !entered ? "0%" : folded ? "100%" : `${split}%`;
  const sliding = hasBoard && (folded || fold.moving);
  return (
    <div ref={rootRef} className={`relative flex min-h-0 min-w-0 flex-1 ${className}`}>
      {hasBoard ? (
        <div
          className="z-board flex min-h-0 min-w-0 flex-col overflow-hidden [contain:layout_style]"
          data-dragging={dragging}
          style={{
            flexBasis: boardBasis,
            flexGrow: 0,
            flexShrink: 1,
            opacity: entered ? 1 : 0,
            transition:
              dragging || reduce ? "none" : `flex-basis ${folded ? FOLD_MS : UNFOLD_MS}ms ${EASE_DRAWER_CSS}`,
          }}
        >
          {board}
        </div>
      ) : null}
      {hasBoard && !folded ? (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag}
          onDoubleClick={() => setSplit(50)}
          title="Drag to resize · double-click to reset"
          className={`relative w-px shrink-0 cursor-col-resize transition-colors hover:bg-content/20 ${
            dragging ? "bg-content/20" : "bg-content/10"
          }`}
        >
          {/* The hairline is the sash; this widens the grab to 8px. */}
          <span className="absolute inset-y-0 -inset-x-1" />
        </div>
      ) : null}
      {folded ? (
        <button
          type="button"
          onClick={onOpenChat}
          title={edgeTitle}
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-content/10 pt-4 text-content/50 transition-colors hover:bg-content/5 hover:text-content"
        >
          <MessageSquare className="size-3.5" strokeWidth={1.75} />
          <StatusDot status={status} />
        </button>
      ) : null}
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden${
          hasBoard ? " [contain:layout_style]" : ""
        }`}
      >
        <div
          inert={folded}
          style={
            sliding
              ? {
                  width: fold.width,
                  opacity: folded ? 0 : 1,
                  transition: `opacity ${FADE_MS}ms ${EASE_OUT_CSS}`,
                }
              : undefined
          }
          className={`flex min-h-0 flex-col ${sliding ? "absolute inset-y-0 left-0" : "flex-1"}${
            fold.parked && folded ? " invisible" : ""
          }`}
        >
          {chat}
        </div>
      </div>
    </div>
  );
}
