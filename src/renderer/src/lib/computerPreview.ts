import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  PREVIEW_MAX_EDGE,
  PREVIEW_MIN_EDGE,
  type ComputerPreviewEndReason,
  type ComputerPreviewStart,
} from "@server/shared/contract-computer";
import type { ServerPush } from "@server/shared/contract";
import { registry } from "./connection/registry";
import type { ComputerEntry } from "./computerSessions";

/**
 * The live preview of a computer session (docs/computer-protocol.md §6 and
 * "What the person sees"): `computer.preview.start` on this Mac's own link,
 * then frames, clicks and the preview's state as pushes to this socket alone.
 * A frame is decoded off the main thread (`createImageBitmap`), drawn onto the
 * canvas and only then acked, so the rate is what the pane can paint. It runs
 * only while it is seen; anything else stops it on the host.
 *
 * A frame repaints the canvas and nothing else: React hears when the stream
 * starts, draws its first frame, changes shape or ends, and the frame count
 * goes to the box's `data-frames` by hand (the Mac proof reads it), so four
 * frames a second never re-render the section around the picture.
 */

export type PreviewState =
  | { status: "starting"; width?: number; height?: number }
  | { status: "live"; app: string; window: string | null; width: number; height: number; /** a frame is on the canvas */ drawn: boolean }
  | { status: "ended"; reason: ComputerPreviewEndReason }
  | { status: "failed"; message: string };

/** A grown box asks again for frames this much larger than the edge in use, once the resize has been quiet this long. */
export const PREVIEW_REGROW = 1.25;
export const PREVIEW_QUIET_MS = 500;

/** The edge to ask for: the box's width in device pixels, rounded up to 64, inside the wire's bounds. */
export function previewEdge(boxWidth: number, dpr: number): number {
  const want = Math.ceil((Math.max(1, boxWidth) * Math.max(1, dpr)) / 64) * 64;
  return Math.min(PREVIEW_MAX_EDGE, Math.max(PREVIEW_MIN_EDGE, want));
}

function frameBlob(data: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

export interface PreviewOptions {
  /** the fold is open, the panel's section shown and the document visible */
  run: boolean;
  /** the box's CSS width */
  boxWidth: number;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** the box that carries `data-frames`: each drawn frame is counted on it by hand */
  box?: RefObject<HTMLElement | null>;
  /** a click, as shares of the frame it is in (0..1 each way) */
  onClick: (x: number, y: number) => void;
}

/** Starting again, in the shape the box last had: a stream that was live, or one already starting in a shape. */
const starting = (prev: PreviewState): PreviewState =>
  (prev.status === "live" || prev.status === "starting") && prev.width && prev.height ? { status: "starting", width: prev.width, height: prev.height } : { status: "starting" };

/** The preview's state, and Retry for one that stopped. */
export function useComputerPreview(entry: ComputerEntry, opts: PreviewOptions): { state: PreviewState; retry: () => void } {
  const [state, setState] = useState<PreviewState>({ status: "starting" });
  const [attempt, setAttempt] = useState(0);
  // Unset until the box is measured: its first width sets it at once, a later growth after a quiet spell.
  const [edge, setEdge] = useState<number | null>(null);
  const onClick = useRef(opts.onClick);
  const canvas = opts.canvas;
  const box = opts.box;
  const host = entry.previewHost;
  const key = entry.previewKey;
  // The state is its session's. When the section follows another session, what the last one drew is not this
  // one's picture: it starts from nothing before anything paints, whether or not its stream can start yet (a
  // session that has read no window has none), so the canvas's old frame is never shown under the new row.
  const owner = `${host ?? ""}\n${key ?? ""}`;
  const [owned, setOwned] = useState(owner);
  if (owned !== owner) {
    setOwned(owner);
    setState({ status: "starting" });
  }
  // The host previews the window the thread last read: before its first read there is none, and a start would be
  // refused for good. The stream starts when the row names a window, and one that failed tries again when that
  // window changes.
  const target = entry.row.apps[0] ? `${entry.row.apps[0].name}\n${entry.row.apps[0].window ?? ""}` : "";
  const run = opts.run && entry.previewable && !!host && !!key && edge !== null && target !== "";
  const failedAt = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "failed") failedAt.current = null;
    else if (failedAt.current === null) failedAt.current = target;
    else if (failedAt.current !== target) {
      failedAt.current = null;
      setAttempt((n) => n + 1);
    }
  }, [state.status, target]);

  useLayoutEffect(() => {
    onClick.current = opts.onClick;
  });

  // A box that grew well past the edge in use asks again once the drag is quiet.
  useEffect(() => {
    if (opts.boxWidth <= 0) return;
    const next = previewEdge(opts.boxWidth, window.devicePixelRatio);
    if (edge === null) return setEdge(next);
    if (next <= edge * PREVIEW_REGROW) return;
    const timer = setTimeout(() => setEdge(next), PREVIEW_QUIET_MS);
    return () => clearTimeout(timer);
  }, [edge, opts.boxWidth]);

  useEffect(() => {
    if (!run || !host || !key || edge === null) return;
    const link = registry.link(host);
    if (!link) {
      setState({ status: "failed", message: "This Mac is not connected" });
      return;
    }
    let alive = true;
    /** the preview ended: a frame still decoding must not bring the box back */
    let over = false;
    let preview: string | null = null;
    let frames = 0;
    /** the stream's target: it goes up when the host moves the stream to another window, or brings it back after an end */
    let generation = 0;
    let shown: { app: string; window: string | null; width: number; height: number } | null = null;
    /** which window the stream is of, as the host tells windows apart: two of one app can share a title */
    let target: string | undefined;
    setState(starting);

    const draw = async (push: Extract<ServerPush, { push: "computer-frame" }>): Promise<void> => {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (el && ctx) {
        try {
          const mine = generation;
          const bitmap = await createImageBitmap(frameBlob(push.data));
          if (!alive || over) return bitmap.close();
          // A frame of the window the stream has since left is not the new window's picture: it is dropped, and
          // acked all the same, so the host's gate lets the new window's frames through.
          if (mine !== generation) {
            bitmap.close();
            void link.request("computer.preview.ack", { preview: push.preview, seq: push.seq }).catch(() => undefined);
            return;
          }
          if (el.width !== bitmap.width) el.width = bitmap.width;
          if (el.height !== bitmap.height) el.height = bitmap.height;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          frames++;
          if (box?.current) box.current.dataset.frames = String(frames);
          // A window that changed shape under the stream (resized, another pane of Settings) sends frames of the new
          // shape with no word of it: the box takes the frame's own, or the picture would be stretched into the old one.
          const reshaped = shown !== null && Math.abs(bitmap.width * shown.height - bitmap.height * shown.width) > Math.max(bitmap.width, bitmap.height);
          if (shown && reshaped) shown = { ...shown, width: bitmap.width, height: bitmap.height };
          // React hears the first frame, and a change of shape: every other frame is the canvas's business
          if (shown && (frames === 1 || reshaped)) setState({ status: "live", ...shown, drawn: true });
        } catch {
          // An undecodable frame: skip it; the ack still lets the next one come.
        }
      }
      if (alive) void link.request("computer.preview.ack", { preview: push.preview, seq: push.seq }).catch(() => undefined);
    };

    const off = link.onPush((push) => {
      if (!alive || !preview) return;
      if (push.push === "computer-frame" && push.preview === preview) void draw(push);
      else if (push.push === "computer-click" && push.preview === preview && push.width > 0 && push.height > 0) {
        onClick.current(push.at[0] / push.width, push.at[1] / push.height);
      } else if (push.push === "computer-preview" && push.preview === preview) {
        if (push.state === "ended") {
          over = true;
          setState({ status: "ended", reason: push.reason ?? "closed" });
          return;
        }
        const next = {
          app: push.app ?? shown?.app ?? "",
          window: push.window !== undefined ? push.window : (shown?.window ?? null),
          width: push.width ?? shown?.width ?? 16,
          height: push.height ?? shown?.height ?? 10,
        };
        // Another window, or the stream back after it ended: what the canvas holds is not this window's picture.
        // Nothing is drawn until its own first frame (the skeleton, in the new shape), and a frame of the old
        // one still decoding is dropped.
        const moved = push.target !== undefined && target !== undefined ? push.target !== target : shown !== null && (next.app !== shown.app || next.window !== shown.window);
        if (over || moved) {
          generation++;
          frames = 0;
        }
        target = push.target ?? target;
        over = false;
        shown = next;
        setState({ status: "live", ...shown, drawn: frames > 0 });
      }
    });

    link
      .request<ComputerPreviewStart>("computer.preview.start", { threadId: key, maxEdge: edge })
      .then((started) => {
        if (!alive) {
          void link.request("computer.preview.stop", { preview: started.preview }).catch(() => undefined);
          return;
        }
        preview = started.preview;
        if (started.ended) {
          over = true;
          setState({ status: "ended", reason: started.ended });
          return;
        }
        shown = { app: started.app, window: started.window, width: started.width, height: started.height };
        target = started.target;
        setState({ status: "live", ...shown, drawn: frames > 0 });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });

    // The stream is the socket's: when it drops the host forgets this viewer, so the picture on screen is no longer
    // live. It says so (the skeleton, in the picture's shape) and a new stream is asked for when the socket opens.
    const offClose = link.onClose(() => {
      if (!alive) return;
      over = true;
      preview = null;
      setState(starting);
    });
    const offOpen = link.onOpen(() => {
      if (alive) setAttempt((n) => n + 1);
    });

    return () => {
      alive = false;
      off();
      offClose();
      offOpen();
      if (preview) void link.request("computer.preview.stop", { preview }).catch(() => undefined);
      // the stream is stopped (a row was pinned, the pane hidden): its picture is not live any more, and the next
      // start begins from the skeleton in its shape, never from an empty box called live
      setState((prev) => (prev.status === "live" ? starting(prev) : prev));
    };
  }, [attempt, box, canvas, edge, host, key, run]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
