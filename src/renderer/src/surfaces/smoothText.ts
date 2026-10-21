import { useLayoutEffect, useRef, useState } from "react";
import { usePaneVisible } from "../hooks/paneVisibility";

/**
 * Smooth streaming reveal. Text arrives in chunks whose size and spacing
 * depend on the path: a local harness sends a delta every few ms, a remote
 * host over the tunnel sends a frame every 33–100 ms with jitter and the
 * odd stall. This hook decouples what ARRIVED from what is SHOWN and works
 * as a jitter buffer, the way a media player plays packets that arrive
 * unevenly:
 *
 * - It measures the stream: the arrival rate (chars/s, a moving average)
 *   and a high percentile of the gaps between arrivals.
 * - It reveals at that rate, holding a lag behind the live end of about
 *   twice the high-percentile gap (TARGET_LAG_GAPS), clamped to
 *   MIN_LAG_MS–MAX_LAG_MS: enough buffer that the next chunk arrives
 *   before the shown text catches up, so the pace never sees the gaps.
 * - It corrects gently toward that lag (LAG_GAIN): too far behind reveals
 *   a little faster, too close a little slower, never a surge.
 * - As the buffer runs low (a stall) it eases down rather than stopping
 *   dead at the live end, and a pause past PAUSE_MS starts a new spurt
 *   without poisoning the estimates.
 * - Until the stream has shown its rhythm (the first gap), and once it
 *   ends, the original exponential catch-up runs: τ 320 ms while
 *   streaming, τ 90 ms draining at the end, a 25 chars/s floor.
 * - Lag cap 900 chars: a torrent (pasted code) skips ahead rather than
 *   replaying at length.
 * - Paints at most every 33ms so markdown re-parses at ~30fps, not 60.
 * - A non-append rewrite (final text differing from the deltas) snaps.
 * - Mount baselines to the full text: history and re-attach show instantly;
 *   only text that arrives while we watch animates.
 */

export const TAU_STREAM_MS = 320;
export const TAU_DRAIN_MS = 90;
export const FLOOR_CPS = 25;
export const MAX_LAG = 900;
export const PAINT_EVERY_MS = 33;
/** Frame deltas clamp here so a background tab does not dump everything at once. */
export const MAX_FRAME_MS = 100;

/** The lag held behind the live end is this many high-percentile gaps… */
export const TARGET_LAG_GAPS = 2;
/** …and never less than this (a local stream: deltas every few ms)… */
export const MIN_LAG_MS = 120;
/** …nor more than this (a choppy link: past it, waiting costs more than a hitch). */
export const MAX_LAG_MS = 500;
/** The gap percentile the lag covers: most gaps, not the one-off stall. */
export const GAP_PERCENTILE = 0.9;
/** Recent gaps kept for the percentile. */
export const GAP_SAMPLES = 32;
/** The rate's moving average forgets with this time constant. */
export const RATE_TAU_MS = 1500;
/** How hard the pace leans toward the target lag: at 0.3 a lag 10% off
 *  moves the pace 3%, and a lag converges in about target / 0.3. */
export const LAG_GAIN = 0.3;
/** The pace never runs faster than this many times the arrival rate. */
export const MAX_SURGE = 1.5;
/** A gap this long is a pause (the model thinking, a tool running), not
 *  jitter: the next arrival starts a new spurt and the estimates keep
 *  what they knew. */
export const PAUSE_MS = 1000;

/**
 * One frame of the exponential catch-up: where the revealed position lands
 * after `dt` ms, given the live end and whether the stream is still open.
 * The pacer's fallback before it knows the stream's rhythm and its drain
 * once the stream ends.
 */
export function advanceReveal(
  pos: number,
  end: number,
  dt: number,
  live: boolean,
): number {
  const remaining = end - pos;
  if (remaining <= 0) return end;
  const step = Math.max(
    remaining * (1 - Math.exp(-dt / (live ? TAU_STREAM_MS : TAU_DRAIN_MS))),
    (dt * FLOOR_CPS) / 1000,
  );
  const next = Math.min(end, pos + step);
  return end - next > MAX_LAG ? end - MAX_LAG : next;
}

/** True when the already-revealed prefix changed under us (a rewrite, not an append). */
export function isRewrite(prev: string, next: string, revealed: number): boolean {
  const whole = Math.floor(revealed);
  return next.slice(0, whole) !== prev.slice(0, whole);
}

/** The jitter buffer's state: what is shown, what arrived, and what the
 *  stream's rhythm has been. Plain data so the hook and the tests share it. */
export interface Pacer {
  /** fractional revealed length */
  pos: number;
  /** arrived length (the live end) */
  end: number;
  /** when the last chunk arrived (ms), NaN before the first */
  lastArrival: number;
  /** gaps folded into the averages since the pacer started */
  samples: number;
  /** moving averages of chars per arrival and ms between arrivals */
  avgChars: number;
  avgGap: number;
  /** recent gaps (ms), oldest first */
  gaps: number[];
}

export function newPacer(length: number): Pacer {
  return { pos: length, end: length, lastArrival: NaN, samples: 0, avgChars: 0, avgGap: 0, gaps: [] };
}

/** The shown text jumps to `length` (mount, a rewrite, a hidden pane);
 *  the stream's rhythm is kept. */
export function snapPacer(p: Pacer, length: number): void {
  p.pos = length;
  p.end = length;
}

/** The text grew to `end` at `now` (ms). */
export function noteArrival(p: Pacer, end: number, now: number): void {
  const chars = end - p.end;
  if (chars <= 0) {
    p.end = end;
    if (p.pos > end) p.pos = end;
    return;
  }
  const gap = now - p.lastArrival;
  p.end = end;
  p.lastArrival = now;
  // The first chunk, or the first after a pause: no gap to learn from.
  if (!(gap >= 0) || gap > PAUSE_MS) return;
  p.samples++;
  // A plain mean while the averages fill, then time-weighted, so a stream
  // of 7 ms deltas and one of 100 ms frames forget at the same pace.
  const a = Math.max(1 / p.samples, 1 - Math.exp(-gap / RATE_TAU_MS));
  p.avgChars += a * (chars - p.avgChars);
  p.avgGap += a * (gap - p.avgGap);
  p.gaps.push(gap);
  if (p.gaps.length > GAP_SAMPLES) p.gaps.shift();
}

/** Chars per ms the stream has been arriving at; 0 before the first gap. */
export function arrivalRate(p: Pacer): number {
  return p.samples > 0 && p.avgGap > 0 ? p.avgChars / p.avgGap : 0;
}

/** The GAP_PERCENTILE gap of the recent arrivals (ms). */
export function highGap(p: Pacer): number {
  if (p.gaps.length === 0) return 0;
  const sorted = p.gaps.slice().sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(GAP_PERCENTILE * sorted.length))];
}

/** The lag (ms of text) the pacer holds behind the live end. */
export function targetLagMs(p: Pacer): number {
  return Math.min(MAX_LAG_MS, Math.max(MIN_LAG_MS, TARGET_LAG_GAPS * highGap(p)));
}

/**
 * One frame: advance the shown position by `dt` ms at `now` and return it.
 * While live and once the rate is known, the pace is the arrival rate
 * leaned toward the target lag. The lag is the playout delay: how much
 * text will be left when the next chunk is due, which is the buffer now
 * plus the time since the last arrival (up to a usual gap) minus the mean
 * gap. It holds still while the buffer drains between two chunks, so the
 * pace does not wobble with the chunking; only a chunk later than usual
 * reads as the buffer running low.
 */
export function stepPacer(p: Pacer, dt: number, now: number, live: boolean): number {
  const rate = arrivalRate(p);
  if (!live || rate <= 0) {
    p.pos = advanceReveal(p.pos, p.end, dt, live);
    return p.pos;
  }
  const remaining = p.end - p.pos;
  if (remaining <= 0) {
    p.pos = p.end;
    return p.pos;
  }
  const target = targetLagMs(p);
  const bufferMs = remaining / rate;
  const since = Math.max(0, now - p.lastArrival);
  const usual = Math.max(p.avgGap, highGap(p));
  const lagMs = bufferMs + Math.min(since, usual) - p.avgGap;
  const error = (lagMs - target) / target;
  let gain = Math.min(MAX_SURGE, Math.max(0, 1 + LAG_GAIN * error));
  // Running low (a stall): ease down as the buffer empties instead of
  // running into the live end at full pace. A steady stream never gets
  // here: its buffer bottoms out at the target lag.
  const low = target / 3;
  if (bufferMs < low) gain *= bufferMs / low;
  const step = Math.max(rate * gain * dt, (dt * FLOOR_CPS) / 1000);
  const next = Math.min(p.end, p.pos + step);
  p.pos = p.end - next > MAX_LAG ? p.end - MAX_LAG : next;
  return p.pos;
}

interface Reveal {
  pacer: Pacer;
  prev: string;
  target: string;
  live: boolean | undefined;
  raf: number;
  lastFrame: number;
  lastPaint: number;
}

export function useSmoothText(text: string, streaming: boolean | undefined): string {
  const [shown, setShown] = useState(text.length);
  const st = useRef<Reveal>({
    pacer: newPacer(text.length),
    prev: text,
    target: text,
    live: streaming,
    raf: 0,
    lastFrame: 0,
    lastPaint: 0,
  });

  const paneShown = usePaneVisible();
  useLayoutEffect(() => {
    const s = st.current;
    const p = s.pacer;
    s.live = streaming;
    s.target = text;
    if (!paneShown || isRewrite(s.prev, text, p.pos)) {
      snapPacer(p, text.length);
      setShown(text.length);
    } else {
      noteArrival(p, text.length, performance.now());
    }
    s.prev = text;
    if (p.pos >= text.length) return;
    s.lastFrame = performance.now();
    const tick = (now: number): void => {
      s.raf = 0;
      const dt = Math.min(now - s.lastFrame, MAX_FRAME_MS);
      s.lastFrame = now;
      const end = p.end;
      if (end - p.pos <= 0) return;
      stepPacer(p, dt, now, !!s.live);
      if (p.pos >= end) {
        s.lastPaint = now;
        setShown(end);
        return;
      }
      if (now - s.lastPaint >= PAINT_EVERY_MS) {
        s.lastPaint = now;
        setShown(Math.floor(p.pos));
      }
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
    return () => {
      if (s.raf) {
        cancelAnimationFrame(s.raf);
        s.raf = 0;
      }
    };
  }, [text, streaming, paneShown]);

  return shown >= text.length ? text : text.slice(0, shown);
}
