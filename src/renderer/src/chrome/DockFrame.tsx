import { useSashKeys } from "../hooks/useSashKeys";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { animate } from "motion/react";
import { clampDockSize, DOCK_SIZE_DEFAULT } from "../lib/projectTerminal";
import { pushSample, releaseVelocity, rubber, suppressTextSelection, type DragSample } from "../lib/drag";
import { SPRING_GLIDE } from "../lib/ease";

/**
 * The bottom dock's shell: the hairline on its top edge, the focus tint,
 * and the sash that resizes it (painted per frame, committed on
 * release, double-click for the default size). Past its bounds the dock
 * follows the rubber band and, released, settles back on SPRING_GLIDE with
 * the pointer's speed, then commits. The terminal dock and the
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
  const drag = useRef<{ start: number; size: number; samples: DragSample[]; release: (now: number) => void } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pending = useRef(size);
  const frame = useRef<number | null>(null);
  const settle = useRef<{ stop: () => void } | null>(null);

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
      settle.current?.stop();
    },
    [],
  );

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

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

  /** Settle a released drag inside the bounds with `velocity` (px/s of the size), then commit. */
  const settleTo = (velocity: number) => {
    const from = pending.current;
    const to = clampDockSize(from, viewport());
    if (frame.current != null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (to === Math.round(from) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pending.current = to;
      commit();
      return;
    }
    settle.current = animate(from, to, {
      ...SPRING_GLIDE,
      velocity,
      onUpdate: (value) => {
        pending.current = value;
        onSizePaint(value);
      },
      onComplete: () => {
        settle.current = null;
        pending.current = to;
        commit();
      },
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    // A drag that catches the dock mid-settle starts from where it is drawn.
    const live = settle.current ? pending.current : sizeRef.current;
    settle.current?.stop();
    settle.current = null;
    pending.current = live;
    const restoreSelection = suppressTextSelection();
    document.documentElement.classList.add("is-resizing");
    const samples: DragSample[] = [];
    // `now` is the release's time; a blur carries no speed.
    const onBlur = () => release(Infinity);
    const release = (now: number) => {
      if (!drag.current) return;
      drag.current = null;
      window.removeEventListener("blur", onBlur);
      restoreSelection();
      document.documentElement.classList.remove("is-resizing");
      setDragging(false);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      // The size grows as the pointer rises.
      settleTo(-releaseVelocity(samples, now));
    };
    drag.current = { start: event.clientY, size: live, samples, release };
    window.addEventListener("blur", onBlur);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    pushSample(drag.current.samples, event.clientY, event.timeStamp);
    const raw = drag.current.size + drag.current.start - event.clientY;
    const bounds = viewport();
    paint(rubber(raw, clampDockSize(0, bounds), clampDockSize(Number.MAX_SAFE_INTEGER, bounds)));
  };

  /** A release, a cancel or a lost capture (a drag over an iframe, out of the window) all end the drag. */
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current?.release(event.timeStamp);
  };

  const keys = useSashKeys({
    label,
    orientation: "horizontal",
    value: size,
    getSpan: (handle) => handle.parentElement?.parentElement?.getBoundingClientRect().height || window.innerHeight,
    direction: -1,
    onChange: (next) => {
      pending.current = clampDockSize(next, { width: window.innerWidth, height: window.innerHeight });
      commit();
    },
    onReset: () => {
      pending.current = DOCK_SIZE_DEFAULT;
      commit();
    },
  });

  return (
    <section
      {...data}
      className={`relative flex h-full min-h-0 min-w-0 flex-col ${
        focused ? "bg-background" : "bg-sidebar"
      } border-t border-border`}
      onMouseDown={onFocus}
    >
      <div
        {...keys}
        className={`absolute inset-x-0 -top-px z-10 h-1.5 cursor-row-resize touch-none outline-none focus-visible:bg-accent ${dragging ? "bg-foreground/12" : "hover:bg-foreground/7"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      />
      {children}
    </section>
  );
}
