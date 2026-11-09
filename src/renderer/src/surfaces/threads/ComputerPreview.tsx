import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComputerPreviewEndReason } from "@server/shared/contract-computer";
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
/** The stream's shape until its start answers. */
const DEFAULT_ASPECT = 10 / 16;

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

/** The box's size and the picture's inside it, for a stream of `w` × `h` in a box `boxWidth` wide. */
export function previewBox(boxWidth: number, w: number | undefined, h: number | undefined): { height: number; pictureWidth: number } {
  const aspect = w && h ? h / w : DEFAULT_ASPECT;
  const height = Math.min(PREVIEW_MAX_HEIGHT, Math.round(boxWidth * aspect));
  return { height, pictureWidth: Math.min(boxWidth, Math.round(height / aspect)) };
}

function previewName(state: PreviewState, entry: ComputerEntry): string {
  const app = state.status === "live" ? state.app : (entry.row.apps[0]?.name ?? "");
  const window = state.status === "live" ? state.window : (entry.row.apps[0]?.window ?? null);
  if (!app) return "Preview of the computer session";
  return `Preview of ${window ? `${window} in ${app}` : app}`;
}

export function ComputerPreview({ entry, open }: { entry: ComputerEntry; open: boolean }) {
  const paneShown = usePaneVisible();
  const docShown = useDocumentVisible();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [marks, setMarks] = useState(0);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    setBoxWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setBoxWidth(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The click mark: placed at the click's share of the picture, then one Web Animation restarted per click.
  const pictureSize = useRef({ width: 0, height: 0 });
  const onClick = useCallback((x: number, y: number) => {
    const at = mark.current;
    const el = ring.current;
    if (!at || !el) return;
    const { width, height } = pictureSize.current;
    at.style.transform = `translate(${Math.round(x * width)}px, ${Math.round(y * height)}px)`;
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

  const dims = state.status === "live" || state.status === "starting" ? state : null;
  const { height, pictureWidth } = previewBox(boxWidth || 1, dims?.width, dims?.height);
  useEffect(() => {
    pictureSize.current = { width: pictureWidth, height };
  }, [height, pictureWidth]);

  const row = entry.row;
  const line = row.asking ? (
    <StatusMark state="waiting" detail={row.asking.line} data-slot="computer-asking" />
  ) : row.running?.held ? (
    <StatusMark state="queued" detail={row.running.words} data-slot="computer-held" />
  ) : state.status === "ended" || state.status === "failed" ? (
    <span data-slot="computer-ended" className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{state.status === "ended" ? ENDED_WORDS[state.reason] : "The preview stopped"}</span>
      {state.status === "failed" || RETRY.has(state.reason) ? (
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </span>
  ) : null;

  if (!entry.previewable) return line ? <div className="px-2 pt-0.5 pb-2">{line}</div> : null;

  const live = state.status === "live" && state.frames > 0;
  return (
    <div className="px-2 pt-0.5 pb-2" data-slot="computer-preview">
      <div
        ref={frame}
        role="img"
        aria-label={previewName(state, entry)}
        data-frames={state.status === "live" ? state.frames : 0}
        data-marks={marks}
        className={cn("relative flex w-full justify-center overflow-hidden rounded-lg bg-card", FADE_IN)}
        style={{ height }}
      >
        <div className="relative h-full" style={{ width: pictureWidth }}>
          {live ? null : <Skeleton className="absolute inset-0 rounded-lg" />}
          <canvas
            ref={canvas}
            aria-hidden="true"
            className={cn("block size-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline", !live && "invisible")}
          />
          {/* The mark sits at the click by its wrapper's translate; the ring alone animates. */}
          <div ref={mark} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 size-0">
            <div ref={ring} className="absolute -top-2.5 -left-2.5 size-5 opacity-0" data-slot="click-mark">
              <svg viewBox="0 0 20 20" className="size-5" fill="none">
                {/* A background halo under a foreground ring, so the mark reads on any window. */}
                <circle cx="10" cy="10" r="8.5" className="stroke-background stroke-[3]" />
                <circle cx="10" cy="10" r="8.5" className="stroke-foreground stroke-[1.5]" />
              </svg>
            </div>
          </div>
        </div>
      </div>
      {line ? <div className="pt-1">{line}</div> : null}
    </div>
  );
}
