import { useLayoutEffect, useRef, useState } from "react";
import { usePaneVisible } from "../hooks/paneVisibility";
import { REVEAL } from "../lib/ease";

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
 * - Steps every REVEAL.stepMs (100 ms), as Claude's reveal does, so each step
 *   carries what 100 ms of the stream holds (a phrase), and asks for a frame
 *   only when a step is due: between steps it waits on a timer, since every
 *   requested frame runs the page's style and paint lifecycle (144 a second
 *   on a 144 Hz screen, a fifth of a core).
 * - Shows whole words (`revealCut`): a step ends at a word boundary, and a
 *   bare block marker or a table's header row waits for its content. Each
 *   step fades in whole (lib/streamReveal.ts).
 * - A non-append rewrite (final text differing from the deltas) snaps.
 * - Mount baselines to the full text: history and re-attach show instantly;
 *   only text that arrives while we watch animates. Once the stream ends the
 *   whole text shows, as the last step.
 */

export const TAU_STREAM_MS = 320;
export const TAU_DRAIN_MS = 90;
export const FLOOR_CPS = 25;
export const MAX_LAG = 900;
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

const SPACE = /\s/;
/** A trailing line that is only a block marker: a heading's hashes, a list
 *  bullet or number, a task box, under any quote prefixes. */
const BARE_MARKER = /^(?:[ \t]*>)*[ \t]*(?:#{1,6}|[-*+](?:[ \t]+\[[ xX]?\]?)?|\d{1,9}[.)])?[ \t]*$/;
/** A table's delimiter row: `| --- | :-: |`. */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FENCE = /^[ \t]{0,3}(?:```|~~~)/;

/**
 * Where the shown text ends when the pace has reached `pos`: the last word
 * boundary at or before it (just past a whitespace run), or `pos` itself in
 * a token longer than REVEAL.longTokenChars with no boundary (a URL, a path,
 * a hash), never inside a surrogate pair. While live, a trailing line that
 * is only a block marker (`#`, `-`, `1.`, `- [ ]`, under any `>`) is held to
 * its line start until it has content, and a trailing table (lines that
 * start with `|`) is held to its first line until its delimiter row is
 * whole; neither inside an open code fence. Once the stream ends the cut is
 * the whole text.
 */
export function revealCut(text: string, pos: number, live: boolean): number {
  if (!live) return text.length;
  let cut = Math.max(0, Math.min(pos, text.length));
  if (cut === 0) return 0;
  let boundary = cut;
  while (boundary > 0 && !SPACE.test(text[boundary - 1])) boundary--;
  if (cut - boundary <= REVEAL.longTokenChars) cut = boundary;
  else if (isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return holdBlockStart(text, cut);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const TABLE_LINE = /^[ \t]*\|/;

/** The cut pulled back to the start of a trailing bare marker or an
 *  unfinished table. */
function holdBlockStart(text: string, cut: number): number {
  const lines = text.slice(0, cut).split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  // Inside an open fence a `-` or a `|` is code.
  let fenced = false;
  for (let i = 0; i < lines.length - 1; i++) if (FENCE.test(lines[i])) fenced = !fenced;
  const lastIndex = lines.length - 1;
  const last = lines[lastIndex];
  if (fenced || FENCE.test(last)) return cut;
  if (last !== "" && BARE_MARKER.test(last)) return starts[lastIndex];
  // The trailing run of lines that start with `|` (the last one possibly
  // unfinished, or a newline just past it); it stands once its second line
  // is a whole delimiter row.
  const end = last === "" ? lastIndex - 1 : lastIndex;
  if (end < 0 || !TABLE_LINE.test(lines[end])) return cut;
  let first = end;
  while (first > 0 && TABLE_LINE.test(lines[first - 1])) first--;
  // A line is whole once a newline follows it.
  const delimiterWhole = first + 1 < lastIndex && TABLE_DELIMITER.test(lines[first + 1]);
  return delimiterWhole ? cut : starts[first];
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
  /** The wait for the next paint's frame. */
  timer: number;
  /** A reveal is under way: an arrival keeps its clock instead of restarting it. */
  running: boolean;
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
    timer: 0,
    running: false,
    lastFrame: 0,
    lastPaint: 0,
  });

  const paneShown = usePaneVisible();
  useLayoutEffect(() => {
    const s = st.current;
    const p = s.pacer;
    s.live = streaming;
    s.target = text;
    if (!paneShown || !streaming || isRewrite(s.prev, text, p.pos)) {
      snapPacer(p, text.length);
      setShown(text.length);
    } else {
      noteArrival(p, text.length, performance.now());
    }
    s.prev = text;
    if (p.pos >= text.length) {
      s.running = false;
      return;
    }
    // A reveal under way keeps its clock: its next step counts the time since
    // the last one, the wait for the paint included, however many arrivals
    // restarted the loop meanwhile.
    if (!s.running) s.lastFrame = performance.now();
    s.running = true;
    // The next frame when a paint is due; until then a timer, not a frame.
    const next = (now: number): void => {
      const wait = s.lastPaint + REVEAL.stepMs - now;
      if (wait <= 0) {
        s.raf = requestAnimationFrame(tick);
        return;
      }
      s.timer = window.setTimeout(() => {
        s.timer = 0;
        s.raf = requestAnimationFrame(tick);
      }, wait);
    };
    const tick = (now: number): void => {
      s.raf = 0;
      const dt = Math.min(now - s.lastFrame, MAX_FRAME_MS);
      s.lastFrame = now;
      const end = p.end;
      if (end - p.pos <= 0) {
        s.running = false;
        return;
      }
      stepPacer(p, dt, now, !!s.live);
      if (p.pos >= end) {
        s.running = false;
        s.lastPaint = now;
        setShown(end);
        return;
      }
      if (now - s.lastPaint >= REVEAL.stepMs) {
        s.lastPaint = now;
        setShown(Math.floor(p.pos));
      }
      next(now);
    };
    next(performance.now());
    return () => {
      if (s.raf) {
        cancelAnimationFrame(s.raf);
        s.raf = 0;
      }
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = 0;
      }
    };
  }, [text, streaming, paneShown]);

  const cut = revealCut(text, shown, !!streaming);
  return cut >= text.length ? text : text.slice(0, cut);
}
