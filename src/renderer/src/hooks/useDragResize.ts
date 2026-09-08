import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { animate } from "motion/react";
import { SPRING_LAYOUT } from "../lib/ease";
import { suppressTextSelection } from "../lib/drag";

type Options = {
  min: number;
  max: () => number;
  defaultWidth: number;
  initial: number;
  onCommit?: (width: number) => void;
};

function clampTo(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Diminishing overshoot past a bound: the pane stretches, but ever more reluctantly. */
function rubberband(over: number) {
  return (over * 300 * 0.55) / (300 + 0.55 * over);
}

function rubber(raw: number, min: number, max: number) {
  if (raw > max) return max + rubberband(raw - max);
  if (raw < min) return min - rubberband(min - raw);
  return raw;
}

/** Drag a pane's width by writing the DOM directly so React re-renders can't fight the cursor. */
export function useDragResize({
  min,
  max,
  defaultWidth,
  initial,
  onCommit,
}: Options) {
  const minRef = useRef(min);
  minRef.current = min;
  const maxRef = useRef(max);
  maxRef.current = max;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const defaultRef = useRef(defaultWidth);
  defaultRef.current = defaultWidth;

  const clamp = useCallback((value: number) => {
    return clampTo(value, minRef.current, maxRef.current());
  }, []);

  const [width, setWidth] = useState(() => clamp(initial));
  const [dragging, setDragging] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  const widthRef = useRef(width);
  const stopDrag = useRef<(() => void) | null>(null);

  const apply = (next: number) => {
    widthRef.current = next;
    const pane = paneRef.current;
    if (pane) pane.style.width = `${next}px`;
  };

  const setPaneRef = useCallback((el: HTMLElement | null) => {
    paneRef.current = el;
    if (el) el.style.width = `${widthRef.current}px`;
  }, []);

  const settle = useRef<{ stop: () => void } | null>(null);

  const commit = (next: number) => {
    const value = clamp(next);
    const pane = paneRef.current;
    const from = widthRef.current;
    settle.current?.stop();
    settle.current = null;
    widthRef.current = value;
    setWidth(value);
    onCommitRef.current?.(value);
    if (!pane) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (from === value || reduce) {
      pane.style.width = `${value}px`;
      return;
    }
    // Spring from the stretched (or previous) width to the committed one.
    settle.current = animate(pane, { width: [`${from}px`, `${value}px`] }, SPRING_LAYOUT);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    settle.current?.stop();
    settle.current = null;
    const startW = paneRef.current?.offsetWidth ?? widthRef.current;
    handle.setPointerCapture(pointerId);
    setDragging(true);
    const restoreSelection = suppressTextSelection();
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.documentElement.classList.add("is-resizing");

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      apply(rubber(startW + (ev.clientX - startX), minRef.current, maxRef.current()));
    };

    const stop = () => {
      if (stopDrag.current !== stop) return;
      stopDrag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      restoreSelection();
      document.body.style.cursor = previousCursor;
      document.documentElement.classList.remove("is-resizing");
      setDragging(false);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      commit(widthRef.current);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop();
    };

    stopDrag.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  useEffect(() => () => stopDrag.current?.(), []);

  const onDoubleClick = () => {
    commit(defaultRef.current);
  };

  return {
    width,
    dragging,
    setPaneRef,
    onPointerDown,
    onDoubleClick,
  };
}
