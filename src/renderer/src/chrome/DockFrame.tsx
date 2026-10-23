import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  clampDockSize,
  defaultDockSize,
  isVerticalDock,
  type DockSide,
} from "../lib/projectTerminal";

/**
 * The dock's shell: the hairline on the side facing the content, the focus
 * tint, and the sash that resizes it (painted per frame, committed on
 * release, double-click for the default size). The terminal dock and the
 * Dev servers pane both sit in it; what goes inside is theirs.
 */
export function DockFrame({
  side,
  size,
  focused,
  label,
  onFocus,
  onSizePaint,
  onSizeCommit,
  children,
  ...data
}: {
  side: DockSide;
  size: number;
  focused: boolean;
  /** The sash's accessible name: "Resize terminal". */
  label: string;
  onFocus: () => void;
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  children: ReactNode;
} & { [key: `data-${string}`]: string }) {
  const vertical = isVerticalDock(side);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pending = useRef(size);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = vertical ? "row-resize" : "col-resize";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [dragging, vertical]);

  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const paint = (next: number) => {
    pending.current = next;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      onSizePaint(pending.current);
    });
  };

  const commit = () => {
    if (frame.current != null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    onSizeCommit(pending.current);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      start: vertical ? event.clientY : event.clientX,
      size: sizeRef.current,
    };
    pending.current = sizeRef.current;
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const point = vertical ? event.clientY : event.clientX;
    const delta = point - drag.current.start;
    const signed = side === "bottom" || side === "right" ? -delta : delta;
    paint(
      clampDockSize(side, drag.current.size + signed, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    commit();
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const sash =
    side === "top"
      ? "absolute inset-x-0 -bottom-px z-10 h-1.5 cursor-row-resize touch-none"
      : side === "bottom"
        ? "absolute inset-x-0 -top-px z-10 h-1.5 cursor-row-resize touch-none"
        : side === "left"
          ? "absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none"
          : "absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none";
  const edge =
    side === "top"
      ? "border-b"
      : side === "bottom"
        ? "border-t"
        : side === "left"
          ? "border-r"
          : "border-l";

  return (
    <section
      {...data}
      className={`relative flex h-full min-h-0 min-w-0 flex-col ${
        focused ? "bg-content/5" : ""
      } ${edge} border-content/10`}
      onMouseDown={onFocus}
    >
      <div
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label={label}
        aria-valuenow={size}
        className={`${sash} ${dragging ? "bg-content/15" : "hover:bg-content/10"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          pending.current = defaultDockSize(side);
          commit();
        }}
      />
      {children}
    </section>
  );
}
