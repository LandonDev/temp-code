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
 */

export type PreviewState =
  | { status: "starting"; width?: number; height?: number }
  | { status: "live"; app: string; window: string | null; width: number; height: number; frames: number }
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
  /** a click, as shares of the frame it is in (0..1 each way) */
  onClick: (x: number, y: number) => void;
}

/** The preview's state, and Retry for one that stopped. */
export function useComputerPreview(entry: ComputerEntry, opts: PreviewOptions): { state: PreviewState; retry: () => void } {
  const [state, setState] = useState<PreviewState>({ status: "starting" });
  const [attempt, setAttempt] = useState(0);
  // Unset until the box is measured: its first width sets it at once, a later growth after a quiet spell.
  const [edge, setEdge] = useState<number | null>(null);
  const onClick = useRef(opts.onClick);
  const canvas = opts.canvas;
  const host = entry.previewHost;
  const key = entry.previewKey;
  const run = opts.run && entry.previewable && !!host && !!key && edge !== null;

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
    let shown: { app: string; window: string | null; width: number; height: number } | null = null;
    setState((prev) => ({ status: "starting", ...(prev.status === "live" ? { width: prev.width, height: prev.height } : {}) }));

    const draw = async (push: Extract<ServerPush, { push: "computer-frame" }>): Promise<void> => {
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (el && ctx) {
        try {
          const bitmap = await createImageBitmap(frameBlob(push.data));
          if (!alive || over) return bitmap.close();
          if (el.width !== bitmap.width) el.width = bitmap.width;
          if (el.height !== bitmap.height) el.height = bitmap.height;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          frames++;
          if (shown) setState({ status: "live", ...shown, frames });
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
        over = false;
        shown = {
          app: push.app ?? shown?.app ?? "",
          window: push.window !== undefined ? push.window : (shown?.window ?? null),
          width: push.width ?? shown?.width ?? 16,
          height: push.height ?? shown?.height ?? 10,
        };
        setState({ status: "live", ...shown, frames });
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
        setState({ status: "live", ...shown, frames });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });

    return () => {
      alive = false;
      off();
      if (preview) void link.request("computer.preview.stop", { preview }).catch(() => undefined);
    };
  }, [attempt, canvas, edge, host, key, run]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
