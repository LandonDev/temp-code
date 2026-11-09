import { forwardRef, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { ComputerPreviewEndReason, ComputerSessionRow } from "@server/shared/contract-computer";
import { Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { StatusMark } from "@renderer/components/ui/status";
import { FADE_IN } from "@renderer/components/ui/reveal";
import { cn } from "@renderer/lib/cn";
import { useDocumentVisible, usePaneVisible } from "../../hooks/paneVisibility";
import { CLICK_MARK } from "../../lib/ease";
import { useComputerPreview, type PreviewState } from "../../lib/computerPreview";
import type { ComputerEntry } from "../../lib/computerSessions";

/**
 * A computer session's window, live, under its Activity row (docs/DESIGN.md
 * "Panels"): the capture stream drawn at the pane's width in a box at most
 * 240px tall, the agent's last click marked for a moment, and one 12px line
 * under it for what the session waits on or why the preview stopped. It runs
 * only while it is seen. Nothing in it moves but the click mark; a frame
 * replaces the last with no transition. Lazy (`computerPreviewChunk`).
 */

/** The box's tallest; a taller window narrows inside it, centred. */
export const PREVIEW_MAX_HEIGHT = 240;
/** The fold's insets either side of the box (PreviewBox's `px-2`). */
const FOLD_INSETS = 16;
/** The stream's shape until its start answers. */
const DEFAULT_SIZE = { width: 16, height: 10 };

const ENDED_WORDS: Record<ComputerPreviewEndReason, string> = {
  closed: "The preview stopped",
  "window-closed": "The window closed",
  minimized: "The window is minimized",
  permission: "Turn on Screen Recording for TempCode in System Settings",
  restarted: "The preview stopped",
  error: "The preview stopped",
};
/** The ends the person can retry; the rest name what to do instead. */
const RETRY: ReadonlySet<ComputerPreviewEndReason> = new Set(["restarted", "error"]);

const prefersReducedMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function previewName(state: PreviewState, row: ComputerSessionRow): string {
  const app = state.status === "live" ? state.app : (row.apps[0]?.name ?? "");
  const window = state.status === "live" ? state.window : (row.apps[0]?.window ?? null);
  if (!app) return "Preview of the computer session";
  return `Preview of ${window ? `${window} in ${app}` : app}`;
}

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

/** The line under the box: a card waiting on the Mac, else a held step, else why the preview stopped. */
export function PreviewLine({ row, state, onRetry }: { row: ComputerSessionRow; state: PreviewState; onRetry?: () => void }): ReactNode {
  if (row.asking) return <StatusMark state="waiting" detail={row.asking.line} data-slot="computer-asking" />;
  if (row.running?.held) return <StatusMark state="queued" detail={row.running.words} data-slot="computer-held" />;
  if (state.status !== "ended" && state.status !== "failed") return null;
  const retry = state.status === "failed" || RETRY.has(state.reason);
  return (
    // A sentence that says what to do wraps rather than lose its end.
    <span data-slot="computer-ended" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-4 text-muted-foreground">
      <span className="min-w-0">{state.status === "ended" ? ENDED_WORDS[state.reason] : "The preview stopped"}</span>
      {retry && onRetry ? (
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The box, pure: the pane's width, the stream's shape and at most 240px tall
 * (CSS alone, so a static render has the right size), the picture centred
 * in it on the `image-outline` edge, a skeleton until the first frame, and
 * the line under it. `picture` is the canvas live, a still in a fixture.
 */
export const PreviewBox = forwardRef(function PreviewBox(
  {
    label,
    size,
    drawn,
    picture,
    mark,
    line,
    frames = 0,
    marks = 0,
    box = true,
  }: {
    /** false: the line alone (the session cannot be previewed here, or its preview ended and nothing more will come) */
    box?: boolean;
    label: string;
    size?: { width: number; height: number } | null;
    /** a frame is on the picture: the skeleton goes */
    drawn: boolean;
    picture: ReactNode;
    mark?: ReactNode;
    line?: ReactNode;
    frames?: number;
    marks?: number;
  },
  ref: Ref<HTMLDivElement>,
) {
  if (!box) return line ? <div className="px-2 pt-0.5 pb-2">{line}</div> : null;
  const { width, height } = size && size.width > 0 && size.height > 0 ? size : DEFAULT_SIZE;
  const aspect = `${width} / ${height}`;
  return (
    <div className="px-2 pt-0.5 pb-2" data-slot="computer-preview">
      <div
        ref={ref}
        role="img"
        aria-label={label}
        data-frames={frames}
        data-marks={marks}
        className={cn("flex w-full justify-center overflow-hidden rounded-lg bg-card", FADE_IN)}
        style={{ aspectRatio: aspect, maxHeight: PREVIEW_MAX_HEIGHT }}
      >
        <div data-slot="computer-picture" className="relative h-full max-w-full" style={{ aspectRatio: aspect }}>
          {drawn ? null : <Skeleton className="absolute inset-0 rounded-lg" />}
          {picture}
          <div className="pointer-events-none absolute inset-0">{mark}</div>
        </div>
      </div>
      {line ? <div className="pt-1">{line}</div> : null}
    </div>
  );
});

/** The class a frame's surface takes: the box's size, the image outline, hidden until its first frame. */
export const pictureClass = (drawn: boolean): string =>
  cn("block size-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline", !drawn && "invisible");

export function ComputerPreview({ entry, open }: { entry: ComputerEntry; open: boolean }) {
  const paneShown = usePaneVisible();
  const docShown = useDocumentVisible();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [marks, setMarks] = useState(0);

  // The box's width decides the edge the stream is asked for; nothing else is measured. The measured
  // element never unmounts (an ended preview drops its box), so Retry finds the width it had.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const inner = (w: number): number => Math.max(0, Math.round(w) - FOLD_INSETS);
    setBoxWidth(inner(el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setBoxWidth(inner(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The click mark sits at the click's share of the picture, so a resize keeps it right; the ring alone animates.
  const onClick = useCallback((x: number, y: number) => {
    const el = ring.current;
    const at = el?.parentElement;
    if (!at || !el) return;
    at.style.left = `${Math.min(1, Math.max(0, x)) * 100}%`;
    at.style.top = `${Math.min(1, Math.max(0, y)) * 100}%`;
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate?.(prefersReducedMotion() ? CLICK_MARK.reduced : CLICK_MARK.keyframes, CLICK_MARK.timing);
    setMarks((n) => n + 1);
  }, []);

  const { state, retry } = useComputerPreview(entry, {
    run: open && paneShown && docShown && boxWidth > 0,
    boxWidth,
    canvas,
    onClick,
  });

  const hasLine = !!entry.row.asking || entry.row.running?.held === true || state.status === "ended" || state.status === "failed";
  const line = hasLine ? <PreviewLine row={entry.row} state={state} onRetry={retry} /> : null;
  // Nothing more will come into the box once it ended: the line alone, never a skeleton that reads as loading.
  const over = state.status === "ended" || state.status === "failed";

  const drawn = state.status === "live" && state.frames > 0;
  const size = state.status === "live" || state.status === "starting" ? (state.width && state.height ? { width: state.width, height: state.height } : null) : null;
  return (
    <div ref={frame} data-slot="computer-preview-root">
      <PreviewBox
        box={entry.previewable && !over}
        label={previewName(state, entry.row)}
        size={size}
        drawn={drawn}
        frames={state.status === "live" ? state.frames : 0}
        marks={marks}
        picture={<canvas ref={canvas} aria-hidden="true" className={pictureClass(drawn)} />}
        mark={<ClickMark ref={ring} />}
        line={line}
      />
    </div>
  );
}
