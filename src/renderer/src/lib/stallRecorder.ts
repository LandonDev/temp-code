/**
 * Renderer half of the stall recorder. Two sources:
 *   - `longtask` PerformanceObserver entries at or over STALL_MS
 *   - a switch timer: every `tab-switch` / `page-switch` / `open-click`
 *     mark is measured to the next paint, and logged when it took STALL_MS
 * Each line carries the most recent switch mark (within SWITCH_WINDOW_MS)
 * and its target, the session/event pushes of the last second, the
 * requests still pending, the running thread count and the visibility
 * state, and goes to `<userData>/logs/stalls.log` through `stall.report`.
 * At most LINES_PER_SECOND lines a second; nothing allocates per push.
 */
import { LIVE_STATUSES } from "@shared/session-lifecycle";
import { onPerfMark } from "./perfMarks";
import { client } from "./tcserver/client";
import { sessionStore } from "./tcserver/store";

export const STALL_MS = 150;
const SWITCH_WINDOW_MS = 5000;
const LINES_PER_SECOND = 10;
const SWITCH_MARKS = new Set(["tab-switch", "page-switch", "open-click"]);

export interface StallContext {
  /** Cumulative push counters; the recorder differences them per second. */
  pushes(): { session: number; event: number };
  pendingMethods(): string[];
  runningCount(): number;
  visibility(): string;
}

export interface StallRecorderOptions {
  report: (line: string) => void;
  ctx: StallContext;
  now?: () => number;
  /** Runs `fn` after the next paint (double rAF); a test passes its own. */
  afterPaint?: (fn: () => void) => void;
}

export interface StallRecorder {
  longtask(durationMs: number): void;
  /** A switch began: measured to the next paint and remembered for later lines. */
  switched(name: string, target: string | undefined): void;
  /** Once a second: settles the push window and the line budget. */
  tick(): void;
  dispose(): void;
}

const doubleRaf = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

export function createStallRecorder(options: StallRecorderOptions): StallRecorder {
  const now = options.now ?? (() => performance.now());
  const afterPaint = options.afterPaint ?? doubleRaf;
  let lastSwitch: { name: string; target: string | undefined; at: number } | null = null;
  let budget = LINES_PER_SECOND;
  let seen = options.ctx.pushes();
  let lastSecond = { session: 0, event: 0 };
  let live = true;

  const write = (head: string): void => {
    if (!live || budget <= 0) return;
    budget -= 1;
    const cur = options.ctx.pushes();
    const pushes = {
      session: cur.session - seen.session + lastSecond.session,
      event: cur.event - seen.event + lastSecond.event,
    };
    const at = now();
    const sw =
      lastSwitch && at - lastSwitch.at <= SWITCH_WINDOW_MS
        ? `${lastSwitch.name}:${lastSwitch.target ?? "-"}@${Math.round(at - lastSwitch.at)}ms`
        : "-";
    const pending = options.ctx.pendingMethods().slice(0, 12).join(",") || "-";
    options.report(
      `${head} switch=${sw} pushes=session:${pushes.session},event:${pushes.event} pending=${pending} running=${options.ctx.runningCount()} visibility=${options.ctx.visibility()}`,
    );
  };

  return {
    longtask(durationMs) {
      if (durationMs >= STALL_MS) write(`longtask ${Math.round(durationMs)}ms`);
    },
    switched(name, target) {
      const at = now();
      lastSwitch = { name, target, at };
      afterPaint(() => {
        const ms = now() - at;
        if (ms >= STALL_MS) write(`switch ${name}:${target ?? "-"} ${Math.round(ms)}ms`);
      });
    },
    tick() {
      const cur = options.ctx.pushes();
      lastSecond = { session: cur.session - seen.session, event: cur.event - seen.event };
      seen = cur;
      budget = LINES_PER_SECOND;
    },
    dispose() {
      live = false;
    },
  };
}

/** The live context: store counters, the socket's pending map, the metas. */
export function liveStallContext(): StallContext {
  let running: number | null = null;
  sessionStore.onMetaChange(() => {
    running = null;
  });
  return {
    pushes: () => sessionStore.pushCounts(),
    pendingMethods: () => client.pendingMethods(),
    runningCount: () => {
      if (running == null) {
        running = 0;
        for (const meta of sessionStore.metas()) if (LIVE_STATUSES.has(meta.status)) running += 1;
      }
      return running;
    },
    visibility: () => (typeof document === "undefined" ? "-" : document.visibilityState),
  };
}

/** Once per window: the longtask observer, the switch timer and the reporter. */
export function installStallRecorder(): () => void {
  const recorder = createStallRecorder({
    ctx: liveStallContext(),
    report: (line) => void client.request("stall.report", { line }).catch(() => {}),
  });
  const offMark = onPerfMark((name, id) => {
    if (SWITCH_MARKS.has(name)) recorder.switched(name, id);
  });
  const timer = setInterval(() => recorder.tick(), 1000);
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver === "function") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) recorder.longtask(entry.duration);
      });
      observer.observe({ type: "longtask", buffered: false });
    } catch {
      observer = null;
    }
  }
  return () => {
    offMark();
    clearInterval(timer);
    observer?.disconnect();
    recorder.dispose();
  };
}
