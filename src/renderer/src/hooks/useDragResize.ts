import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { animate } from "motion/react";
import { SPRING_GLIDE } from "../lib/ease";
import { pushSample, releaseVelocity, rubber, suppressTextSelection, type DragSample } from "../lib/drag";

type Options = {
  min: number;
  max: () => number;
  defaultWidth: number;
  initial: number;
  onCommit?: (width: number) => void;
  /** The edge the handle sits on: a left-edge handle widens the pane when dragged left. */
  edge?: "left" | "right";
};

function clampTo(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Drag a pane's width by writing the DOM directly so React re-renders can't fight the cursor. */
export function useDragResize({
  min,
  max,
  defaultWidth,
  initial,
  onCommit,
  edge = "right",
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

  const attachPane = useCallback((el: HTMLElement | null) => {
    paneRef.current = el;
    if (el) el.style.width = `${widthRef.current}px`;
  }, []);

  const settle = useRef<{ stop: () => void } | null>(null);

  /** `velocity` is the width's speed at release in px/s, handed to the settle
   *  so the pane carries on as the hand moved it instead of starting from rest. */
  const commit = (next: number, immediate = false, velocity = 0) => {
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
    if (immediate || from === value || reduce) {
      pane.style.width = `${value}px`;
      return;
    }
    // Spring from the stretched (or previous) width to the committed one.
    settle.current = animate(pane, { width: [from, value] }, { ...SPRING_GLIDE, velocity });
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

    const sign = edge === "left" ? -1 : 1;
    const samples: DragSample[] = [];

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pushSample(samples, ev.clientX, ev.timeStamp);
      apply(rubber(startW + sign * (ev.clientX - startX), minRef.current, maxRef.current()));
    };

    // `now` is the release's time; a drag ended any other way (a blur, an unmount) carries no speed.
    const stop = (now = Infinity) => {
      if (stopDrag.current !== stop) return;
      stopDrag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onBlur);
      handle.removeEventListener("lostpointercapture", onLost);
      restoreSelection();
      document.body.style.cursor = previousCursor;
      document.documentElement.classList.remove("is-resizing");
      setDragging(false);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      commit(widthRef.current, false, sign * releaseVelocity(samples, now));
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop(ev.timeStamp);
    };
    // A drag that ends outside the window, or loses its capture, still ends.
    const onLost = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop(ev.timeStamp);
    };
    const onBlur = () => stop();

    stopDrag.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
    handle.addEventListener("lostpointercapture", onLost);
  };

  useEffect(() => () => stopDrag.current?.(), []);

  /** Keyboard and reset changes commit at once, without a settling spring. */
  const resizeTo = (next: number) => commit(next, true);
  const reset = () => resizeTo(defaultRef.current);

  return {
    width,
    dragging,
    attachPane,
    onPointerDown,
    resizeTo,
    reset,
  };
}
