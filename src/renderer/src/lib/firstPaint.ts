import { useEffect, useRef } from "react";
import { registry } from "./connection";

/**
 * A pane's first rows, timed from the moment it opened to the paint after
 * they land. Later than FIRST_PAINT_MS, the window reports one line through
 * `stall.report` (`[renderer] first-paint session=<id> host=<env> ms=<n>` in
 * stalls.log), once per open; a pane closed before its rows says nothing.
 */
export const FIRST_PAINT_MS = 500;

export interface FirstPaintOptions {
  now?: () => number;
  /** Runs `fn` after the next paint (double rAF); a test passes its own. */
  afterPaint?: (fn: () => void) => void;
  report?: (line: string) => void;
}

export interface FirstPaintWatch {
  /** The pane has rows on screen now. */
  rows(): void;
  dispose(): void;
}

const doubleRaf = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

const reportLine = (line: string): void =>
  void registry
    .primary()
    .request("stall.report", { line })
    .catch(() => undefined);

export function watchFirstPaint(sessionId: string, environmentId: string, options: FirstPaintOptions = {}): FirstPaintWatch {
  const now = options.now ?? (() => performance.now());
  const afterPaint = options.afterPaint ?? doubleRaf;
  const report = options.report ?? reportLine;
  const openedAt = now();
  let done = false;
  return {
    rows() {
      if (done) return;
      done = true;
      afterPaint(() => {
        const ms = Math.round(now() - openedAt);
        if (ms > FIRST_PAINT_MS) report(`first-paint session=${sessionId} host=${environmentId} ms=${ms}`);
      });
    },
    dispose() {
      done = true;
    },
  };
}

/** SessionPane's hook: one watch per open thread, told when its rows arrive. */
export function useFirstPaintReport(sessionId: string, environmentId: string, hasRows: boolean): void {
  const watch = useRef<FirstPaintWatch | null>(null);
  useEffect(() => {
    const current = watchFirstPaint(sessionId, environmentId);
    watch.current = current;
    return () => current.dispose();
  }, [sessionId, environmentId]);
  useEffect(() => {
    if (hasRows) watch.current?.rows();
  }, [hasRows, sessionId, environmentId]);
}
