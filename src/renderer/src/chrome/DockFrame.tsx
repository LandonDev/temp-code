import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clampDockSize, DOCK_SIZE_DEFAULT } from "../lib/projectTerminal";

/**
 * The bottom dock's shell: the hairline on its top edge, the focus tint,
 * and the sash that resizes it (painted per frame, committed on
 * release, double-click for the default size). The terminal dock and the
 * Dev servers pane both sit in it; what goes inside is theirs.
 */
export function DockFrame({
  size,
  focused,
  label,
  onFocus,
  onSizePaint,
  onSizeCommit,
  children,
  ...data
}: {
  size: number;
  focused: boolean;
  /** The sash's accessible name: "Resize terminal". */
  label: string;
  onFocus: () => void;
  onSizePaint: (size: number) => void;
  onSizeCommit: (size: number) => void;
  children: ReactNode;
} & { [key: `data-${string}`]: string }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pending = useRef(size);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "row-resize";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [dragging]);

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
    drag.current = { start: event.clientY, size: sizeRef.current };
    pending.current = sizeRef.current;
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = drag.current.start - event.clientY;
    paint(
      clampDockSize(drag.current.size + delta, {
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

  return (
    <section
      {...data}
      className={`relative flex h-full min-h-0 min-w-0 flex-col ${
        focused ? "bg-background" : "bg-sidebar"
      } border-t border-border`}
      onMouseDown={onFocus}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuenow={size}
        className={`absolute inset-x-0 -top-px z-10 h-1.5 cursor-row-resize touch-none ${dragging ? "bg-foreground/12" : "hover:bg-foreground/7"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          pending.current = DOCK_SIZE_DEFAULT;
          commit();
        }}
      />
      {children}
    </section>
  );
}
