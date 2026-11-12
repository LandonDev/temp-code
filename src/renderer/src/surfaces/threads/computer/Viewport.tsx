import { forwardRef, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import type { ComputerPreviewEndReason, HistoryPictureNone } from "@server/shared/contract-computer";
import { Button } from "@renderer/components/ui/button";
import { CONSOLE } from "@renderer/components/ui/console";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { FADE_IN } from "@renderer/components/ui/reveal";
import { cn } from "@renderer/lib/cn";
import { CLICK_MARK } from "../../../lib/ease";
import { useComputerPreview, type PreviewState } from "../../../lib/computerPreview";
import type { ComputerEntry } from "../../../lib/computerSessions";

/**
 * The Computer section's viewport (docs/DESIGN.md "Panels"): the window as
 * it is or as it was, in one box at the pane's width less its insets, in the
 * picture's shape and at most `min(400px, 45cqh)` of the section's height. It
 * has four faces and never two at once: the live stream on a canvas with the
 * agent's click ringed for a moment; a kept picture, which opens the
 * lightbox; the text the model read, where there is no picture; a skeleton
 * in the picture's shape while the first one is on its way. One 12px line
 * sits under it only when it has something to say. Nothing in it moves but
 * the click's ring: a frame, or a kept picture, replaces the last with no
 * transition.
 */

/** The box's tallest, in pixels; the section's height caps it sooner (`VIEWPORT_MAX`). */
export const VIEWPORT_MAX_HEIGHT = 400;
/** The cap as CSS: the section's body is a size container, so a short panel keeps its list. */
export const VIEWPORT_MAX = `min(${VIEWPORT_MAX_HEIGHT}px, 45cqh)`;
/** The section's 12px insets either side of the box. */
export const VIEWPORT_INSETS = 24;
/** The shape until a picture says its own. */
const DEFAULT_SIZE = { width: 16, height: 10 };

/** Why the live preview ended, as the line under the box says it. */
export const ENDED_WORDS: Record<ComputerPreviewEndReason, string> = {
  closed: "The preview stopped",
  "window-closed": "The window closed",
  minimized: "The window is minimized",
  permission: "Turn on Screen Recording for TempCode in System Settings",
  restarted: "The preview stopped",
  error: "The preview stopped",
};
/**
 * The ends the person can retry; the rest name what to do instead. A minimized window is one: the host starts the
 * stream again when the service says the window was restored, and Retry is there for a restore it did not hear.
 */
export const RETRY_ENDS: ReadonlySet<ComputerPreviewEndReason> = new Set(["restarted", "error", "minimized"]);

/** Why a step kept no picture, where that is worth a line: nothing for a switch that was off, a call with no read, or a capture that failed. */
export const NO_PICTURE_WORDS: Partial<Record<HistoryPictureNone, string>> = {
  permission: "Screen Recording was off",
  minimized: "The window was minimized",
  "not-drawn": "The window was not drawn",
  gone: "This picture is no longer kept",
};

const prefersReducedMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The ring the agent's click draws: a background halo under a foreground ring, so it reads on any window. */
export const ClickMark = forwardRef(function ClickMark({ at, frozen }: { at?: [number, number]; frozen?: boolean }, ref: Ref<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-slot="click-mark-at"
      className="pointer-events-none absolute size-0"
      style={at ? { left: `${at[0] * 100}%`, top: `${at[1] * 100}%` } : undefined}
    >
      <div ref={ref} className={cn("absolute -top-2.5 -left-2.5 size-5", frozen ? "scale-90" : "opacity-0")} data-slot="click-mark">
        <svg viewBox="0 0 20 20" className="size-5" fill="none">
          <circle cx="10" cy="10" r="8.5" className="stroke-background stroke-[3]" />
          <circle cx="10" cy="10" r="8.5" className="stroke-foreground stroke-[1.5]" />
        </svg>
      </div>
    </div>
  );
});

/** The line under the box: muted, wrapping rather than losing its end, with Retry where retrying can help. */
export function ViewportLine({ words, onRetry }: { words: string; onRetry?: () => void }) {
  return (
    <span data-slot="computer-line" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-4 text-muted-foreground">
      <span className="min-w-0">{words}</span>
      {onRetry ? (
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/** The class a picture's surface takes: the box's size, the image outline, hidden until it has something to show. */
export const pictureClass = (drawn: boolean): string =>
  cn("block size-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline", !drawn && "invisible");

export type ViewportFace =
  /** the live stream: `picture` is the canvas (a still in a fixture) */
  | { kind: "live"; picture: ReactNode; drawn: boolean; mark?: ReactNode }
  /** a kept picture; `dim` while the next one is on its way; a click opens the lightbox from the box */
  | { kind: "picture"; src: string; dim?: boolean; onOpen?: (from: DOMRect) => void }
  /** what the model read, where there is no picture */
  | { kind: "text"; text: string }
  /** the first picture is on its way */
  | { kind: "skeleton" }
  /** a pinned step that kept nothing: the box keeps its place, with the line inside it */
  | { kind: "none" };

export interface ViewportProps {
  /** null: the line alone (nothing will come into a box) */
  face: ViewportFace | null;
  /** what the box shows, as its accessible name: "Live view of Untitled in TextEdit", "Untitled in TextEdit at 2:04 PM" */
  label: string;
  /** the picture's shape; 16:10 until one says its own */
  size?: { width: number; height: number } | null;
  /** one line, only when it has something to say */
  line?: ReactNode;
  /** while a row is pinned: the height the box had when the pin began, so a picture of another shape sits inside it */
  height?: number | null;
  /** the live face's counts as rendered; the stream then writes them by hand */
  frames?: number;
  marks?: number;
}

/**
 * The box, pure. Its height is the picture's by CSS alone (the shape as an
 * aspect ratio under the cap), so a static render has the right size; pinned,
 * it keeps the height it is given and centres a picture of another shape.
 */
export const Viewport = forwardRef(function Viewport({ face, label, size, line, height, frames = 0, marks = 0 }: ViewportProps, ref: Ref<HTMLElement>) {
  const { width, height: tall } = size && size.width > 0 && size.height > 0 ? size : DEFAULT_SIZE;
  const aspect = `${width} / ${tall}`;
  const boxStyle = height ? { height, maxHeight: VIEWPORT_MAX } : { aspectRatio: aspect, maxHeight: VIEWPORT_MAX };
  // In its own shape the picture fills the box's height. In a kept height it is as wide as that height allows and no
  // wider than the box, so a picture of any shape sits whole inside it, centred both ways.
  const fit = height ? { aspectRatio: aspect, width: `min(100%, ${Math.round((height * width) / tall)}px)` } : { aspectRatio: aspect };
  const boxClass = cn("relative flex w-full justify-center overflow-hidden rounded-lg bg-card", height && "items-center");
  // The fade is the section's first picture arriving: it rides the wrapper, which stays through every change of face,
  // so a pin, Go live and a step by key swap one face for another with nothing moving.
  const wrap = { "data-slot": "computer-viewport", className: FADE_IN } as const;
  const below = line ? <div className={face ? "pt-1" : undefined}>{line}</div> : null;
  if (!face) return below ? <div {...wrap}>{below}</div> : null;
  if (face.kind === "none") {
    return (
      <div {...wrap}>
        <div ref={ref as Ref<HTMLDivElement>} data-face="none" className={cn(boxClass, "items-center px-3 text-center")} style={boxStyle}>
          {line}
        </div>
      </div>
    );
  }
  if (face.kind === "text") {
    return (
      <div {...wrap}>
        <pre
          ref={ref as Ref<HTMLPreElement>}
          tabIndex={0}
          aria-label={label}
          data-face="text"
          className={cn(CONSOLE, "m-0 w-full overflow-x-auto overflow-y-auto whitespace-pre")}
          style={boxStyle}
        >
          {face.text}
        </pre>
        {below}
      </div>
    );
  }
  // Until a picture is there the skeleton is the whole box, never a box inside the box.
  const waiting = face.kind === "skeleton" || (face.kind === "live" && !face.drawn);
  const picture = (
    <div data-slot="computer-picture" className={cn(height ? "max-h-full" : "h-full max-w-full", !waiting && "relative")} style={fit}>
      {waiting ? <Skeleton className="absolute inset-0 rounded-lg" /> : null}
      {face.kind === "live" ? face.picture : null}
      {face.kind === "picture" ? (
        <img
          src={face.src}
          alt=""
          draggable={false}
          data-dim={face.dim || undefined}
          // The old picture dims while the next is on its way; nothing else about a picture moves.
          className={cn(pictureClass(true), "object-contain transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-opacity", face.dim && "opacity-40")}
        />
      ) : null}
      {face.kind === "live" ? <div className="pointer-events-none absolute inset-0">{face.mark}</div> : null}
    </div>
  );
  if (face.kind === "picture" && face.onOpen) {
    const open = face.onOpen;
    return (
      <div {...wrap}>
        <button
          ref={ref as Ref<HTMLButtonElement>}
          type="button"
          aria-label={label}
          data-face="picture"
          onClick={(e) => open(e.currentTarget.getBoundingClientRect())}
          className={cn(boxClass, "cursor-zoom-in")}
          style={boxStyle}
        >
          {picture}
        </button>
        {below}
      </div>
    );
  }
  return (
    <div {...wrap}>
      <div
        ref={ref as Ref<HTMLDivElement>}
        role="img"
        aria-label={label}
        data-face={face.kind}
        {...(face.kind === "live" ? { "data-frames": frames, "data-marks": marks } : {})}
        className={boxClass}
        style={boxStyle}
      >
        {picture}
      </div>
      {below}
    </div>
  );
});

/** The live stream for the viewport: its state, the canvas and the ring to draw into the live face, and Retry for one that stopped. */
export interface LiveStream {
  state: PreviewState;
  retry: () => void;
  canvas: RefObject<HTMLCanvasElement | null>;
  ring: RefObject<HTMLDivElement | null>;
}

/**
 * The stream of `entry`'s window while `run` holds (the section shown, the
 * document visible, the section following). The box's width decides the edge
 * it asks for. A click moves the ring to its share of the picture and plays
 * it; the frame and click counts go to the box's `data-frames` and
 * `data-marks` by hand, so neither re-renders anything.
 */
export function useLiveStream(entry: ComputerEntry | null, run: boolean, box: RefObject<HTMLElement | null>, measure: RefObject<HTMLElement | null>): LiveStream {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const marks = useRef(0);

  // The measured element is the section's own, which never unmounts while it is shown, so Retry finds the width it had.
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const inner = (w: number): number => Math.max(0, Math.round(w) - VIEWPORT_INSETS);
    setBoxWidth(inner(el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setBoxWidth(inner(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const onClick = useCallback(
    (x: number, y: number) => {
      const el = ring.current;
      const at = el?.parentElement;
      if (!at || !el) return;
      at.style.left = `${Math.min(1, Math.max(0, x)) * 100}%`;
      at.style.top = `${Math.min(1, Math.max(0, y)) * 100}%`;
      el.getAnimations?.().forEach((a) => a.cancel());
      el.animate?.(prefersReducedMotion() ? CLICK_MARK.reduced : CLICK_MARK.keyframes, CLICK_MARK.timing);
      marks.current += 1;
      if (box.current) box.current.dataset.marks = String(marks.current);
    },
    [box],
  );

  const { state, retry } = useComputerPreview(entry ?? NO_ENTRY, { run: run && !!entry && boxWidth > 0, boxWidth, canvas, box, onClick });
  return { state, retry, canvas, ring };
}

/** The live face from a stream: its canvas, hidden until the first frame, and the ring a click plays. */
export function liveFace(stream: LiveStream): Extract<ViewportFace, { kind: "live" }> {
  const drawn = stream.state.status === "live" && stream.state.drawn;
  return { kind: "live", drawn, picture: <canvas ref={stream.canvas} aria-hidden="true" className={pictureClass(drawn)} />, mark: <ClickMark ref={stream.ring} /> };
}

/** The stream's shape while it starts or runs; null before it is known. */
export function streamSize(state: PreviewState): { width: number; height: number } | null {
  if (state.status !== "live" && state.status !== "starting") return null;
  return state.width && state.height ? { width: state.width, height: state.height } : null;
}

/** A stand-in while no session is live: nothing to preview, so the stream never starts. */
const NO_ENTRY: ComputerEntry = { host: "", row: { threadId: "", since: 0, lastCallAt: 0, apps: [], running: null, tier: null }, previewable: false };
