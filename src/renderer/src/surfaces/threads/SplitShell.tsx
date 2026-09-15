import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare } from "../../chrome/icons";
import type { SessionStatus } from "../../lib/tcserver/types";
import { StatusDot } from "./bits";

/**
 * The board | sash | chat recipe every thread view with a board shares.
 * The board sits left at `split%` (30–70, double-click resets to 50);
 * the chat column sits right and folds to a 32px edge tab. The chat stays
 * mounted while folded (`inert` + `invisible absolute`) so the transcript
 * virtualizer keeps its measurements. The board grows in from zero on
 * its first appearance unless it was already there on mount.
 */

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
  const entered = useLiveEntry(hasBoard);
  const boardBasis = !hasBoard || !entered ? "0%" : collapsed ? "100%" : `${split}%`;
  return (
    <div ref={rootRef} className={`relative flex min-h-0 min-w-0 flex-1 ${className}`}>
      {hasBoard ? (
        <div
          className="z-board flex min-h-0 min-w-0 flex-col overflow-hidden"
          data-dragging={dragging}
          style={{ flexBasis: boardBasis, flexGrow: 0, flexShrink: 1, opacity: entered ? 1 : 0 }}
        >
          {board}
        </div>
      ) : null}
      {hasBoard && !collapsed ? (
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
      {hasBoard && collapsed ? (
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
        inert={hasBoard && collapsed}
        style={hasBoard && collapsed ? { width: `${100 - split}%` } : undefined}
        className={`flex min-h-0 min-w-0 flex-col ${
          hasBoard && collapsed ? "invisible absolute inset-y-0 right-0" : "flex-1"
        }`}
      >
        {chat}
      </div>
    </div>
  );
}
