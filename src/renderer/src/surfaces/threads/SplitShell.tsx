import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Toggle } from "../../components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { MessageSquare } from "../../chrome/icons";

/**
 * The board | sash | chat recipe every thread view with a board shares.
 * The board sits left at `split%` (30–70, double-click resets to 50) under
 * one 36px header: the view's title, one muted state line, its actions and
 * the conversation toggle. Folding is a toggle, never a tween: the board
 * takes the full width at once and the chat stays mounted (`inert`,
 * `invisible`, parked at its last width) so the transcript keeps its
 * measurements; unfolding returns it to its slot, its content fading in.
 * The board fades in on its first live appearance, not when it was already
 * there at mount. Beside the board the chat never goes under 360px: the
 * board yields first (DESIGN "Panels").
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
 *  `has` was already true at mount, so a restored board skips the fade. */
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
        <MessageSquare className="size-4" />
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
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-background px-3">
      <div className="flex min-w-0 flex-1 items-baseline">
        <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        {detail ? (
          <span className="ml-2 truncate text-xs text-muted-foreground tabular-nums">{detail}</span>
        ) : null}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        {actions}
        <span className="ml-1 flex">
          <ChatToggle open={chatOpen} onToggle={onToggleChat} />
        </span>
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
  className?: string;
}) {
  const { split, setSplit, dragging, rootRef, startDrag } = useSplit(50);
  const entered = useLiveEntry(hasBoard);
  const folded = hasBoard && collapsed;
  const chatRef = useRef<HTMLDivElement | null>(null);
  const width = useShownWidth(chatRef, !folded);
  return (
    <div ref={rootRef} className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${className}`}>
      {hasBoard ? (
        <div
          data-board
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden transition-opacity duration-(--dur-base) ease-(--ease-out) [contain:layout_style] motion-reduce:transition-none ${
            entered ? "opacity-100" : "opacity-0"
          }`}
          style={{ flexBasis: folded ? "100%" : `${split}%`, flexGrow: 0, flexShrink: 1 }}
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
          {folded && held ? (
            <div data-board-held className="shrink-0 border-b border-border">
              {held}
            </div>
          ) : null}
          {board}
        </div>
      ) : null}
      {hasBoard && !folded ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize"
          onPointerDown={startDrag}
          onDoubleClick={() => setSplit(50)}
          className={`relative w-px shrink-0 cursor-col-resize transition-colors duration-(--dur-fast) hover:bg-foreground/12 motion-reduce:transition-none ${
            dragging ? "bg-foreground/12" : "bg-border"
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
