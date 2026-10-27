import { useSashKeys } from "../hooks/useSashKeys";
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { suppressTextSelection } from "../lib/drag";
import { clampSashBoundary, type LayoutSash, type PaneEdge } from "../lib/layout";
import { MOD } from "../lib/platform";

const titleClass = (focused: boolean) =>
  cn("min-w-0 flex-1 truncate text-[13px]", focused ? "text-foreground" : "text-muted-foreground");

/**
 * A split pane's header: the thread's title and Close. The focused pane's
 * header is the content's own background with the title in foreground; the
 * others sit on the rail's gray with a muted title. The whole header drags
 * the pane; a press inside `[data-no-drag]` does not.
 */
export function PaneHeader({
  title,
  focused,
  titleHint = false,
  onClose,
  onDragStart,
}: {
  title: string;
  focused: boolean;
  /** The full title on hover, for a thread the strip has no chip for (a subagent). */
  titleHint?: boolean;
  onClose: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-pane-header
      data-focused={focused}
      className={cn(
        "flex h-9 shrink-0 touch-none items-center gap-2 border-b border-border px-3 select-none",
        focused ? "bg-background" : "bg-sidebar",
        onDragStart && "cursor-grab active:cursor-grabbing",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !onDragStart) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        onDragStart(event);
      }}
    >
      {titleHint ? (
        <Tooltip>
          <TooltipTrigger render={<span className={titleClass(focused)} />}>{title}</TooltipTrigger>
          <TooltipContent>{title}</TooltipContent>
        </Tooltip>
      ) : (
        <span className={titleClass(focused)}>{title}</span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close pane"
              data-no-drag
              className="-mr-1.5"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Close pane
          <Kbd size="sm">{`${MOD}W`}</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export { SASH_STEP, SASH_BIG_STEP } from "../hooks/useSashKeys";

/**
 * The boundary between two panes: a hairline with a 6px hit area each side.
 * Dragging previews every frame and commits on release (Escape cancels);
 * the arrow keys along its axis move it a step at a time; a double-click
 * makes the group's panes equal.
 */
export function Sash({
  sash,
  containerRef,
  onPreview,
  onCommit,
  onCancel,
  onEqualize,
}: {
  sash: LayoutSash;
  containerRef: { current: HTMLDivElement | null };
  onPreview: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  onCancel: () => void;
  onEqualize: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const row = sash.dir === "right";
  const boundary = sash.sizes.slice(0, sash.index + 1).reduce((sum, size) => sum + size, 0);
  const group = sash.group;
  // A row sash keeps both panes at THREAD_MIN where the group is wide enough.
  const clamp = (next: number, spanPx: number) =>
    row ? clampSashBoundary(sash.sizes, sash.index, next, spanPx) : next;
  const groupSpan = () => (containerRef.current?.getBoundingClientRect().width ?? 0) * group.w;
  const keys = useSashKeys({
    label: "Resize panes",
    orientation: row ? "vertical" : "horizontal",
    value: boundary * 100,
    min: 0,
    max: 100,
    getSpan: () => 100,
    onChange: (next) => onCommit(clamp(next / 100, groupSpan())),
    onReset: onEqualize,
  });

  return (
    <div
      {...keys}
      className={cn("group/sash absolute z-10 bg-border outline-none", row ? "w-px" : "h-px")}
      style={
        row
          ? {
              left: `${(group.x + boundary * group.w) * 100}%`,
              top: `${group.y * 100}%`,
              height: `${group.h * 100}%`,
            }
          : {
              left: `${group.x * 100}%`,
              top: `${(group.y + boundary * group.h) * 100}%`,
              width: `${group.w * 100}%`,
            }
      }
    >
      <div
        className={cn(
          "absolute touch-none",
          row ? "inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" : "inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize",
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const handle = e.currentTarget;
          const parent = containerRef.current;
          if (!parent) return;
          handle.setPointerCapture(e.pointerId);
          setDragging(true);
          const rect = parent.getBoundingClientRect();
          const restoreSelection = suppressTextSelection();
          const previousCursor = document.body.style.cursor;
          document.body.style.cursor = row ? "col-resize" : "row-resize";
          const origin = row ? rect.left + group.x * rect.width : rect.top + group.y * rect.height;
          const span = row ? group.w * rect.width : group.h * rect.height;
          let nextBoundary = boundary;
          let moved = false;
          let frame: number | null = null;

          const move = (ev: PointerEvent) => {
            const pos = row ? ev.clientX : ev.clientY;
            if (span <= 0) return;
            moved = true;
            nextBoundary = clamp((pos - origin) / span, span);
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              onPreview(nextBoundary);
            });
          };
          const finish = (commit: boolean) => {
            if (frame != null) {
              cancelAnimationFrame(frame);
              frame = null;
            }
            if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", keydown);
            restoreSelection();
            document.body.style.cursor = previousCursor;
            setDragging(false);
            if (!moved) return;
            if (commit) onCommit(nextBoundary);
            else onCancel();
          };
          const up = () => finish(true);
          const cancel = () => finish(false);
          const keydown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            finish(false);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", cancel);
          window.addEventListener("keydown", keydown);
        }}
      >
        <div
          className={cn(
            "absolute transition-colors duration-(--dur-fast) ease-(--ease-out) group-focus-visible/sash:bg-accent motion-reduce:transition-none",
            dragging ? "bg-foreground/12" : "group-hover/sash:bg-foreground/7",
            row ? "inset-y-0 left-1/2 w-1 -translate-x-1/2" : "inset-x-0 top-1/2 h-1 -translate-y-1/2",
          )}
        />
      </div>
    </div>
  );
}

const HALF: Record<PaneEdge, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
};

/**
 * Where a dragged pane will land: the half it will take, drawn as a quiet
 * box inset from the pane's edges. It fades in once per pane; moving to
 * another edge redraws it in place.
 */
export function PaneDropHint({ edge }: { edge: PaneEdge }) {
  return (
    <div
      data-pane-drop-hint
      data-edge={edge}
      className={cn("pointer-events-none absolute z-20 animate-in fade-in duration-(--dur-fast) ease-(--ease-out)", HALF[edge])}
    >
      <div className="absolute inset-1 rounded-lg border border-border bg-muted/70" />
    </div>
  );
}
