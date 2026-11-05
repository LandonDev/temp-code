import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePaneVisible } from "../hooks/paneVisibility";
import { REVEAL } from "../lib/ease";

/**
 * Smooth streaming reveal. Text arrives in chunks whose size and spacing
 * depend on the path: a local harness sends a delta every ~20 ms, a remote
 * host over the tunnel a frame every 33–100 ms with jitter, the odd stall,
 * and now and then a whole reply inside a few ms. This hook decouples what
 * ARRIVED from what is SHOWN and works as an adaptive jitter buffer, the
 * way a media player plays packets that arrive unevenly:
 *
 * - It measures the stream: the arrival rate (chars/s, a moving average,
 *   clamped to FLOOR_CPS–BASE_MAX_CPS, DEFAULT_CPS before the first gap)
 *   is the base pace, and a high percentile of the gaps between arrivals
 *   sets the floor of the lead.
 * - It holds a lead behind the live end: seeded by the host (LEAD_LOCAL_MS
 *   for this machine, LEAD_REMOTE_MS for another), never under the floor
 *   (twice the high-percentile gap, LEAD_MIN_MS–LEAD_MAX_MS). An underrun
 *   (the shown text reached the live end and waited) grows it by
 *   LEAD_GROWTH or by the wait, whichever is more; while arrivals keep
 *   coming its excess decays toward the floor (LEAD_DECAY_MS).
 * - Each spurt (the first chunk, and the chunk that ends an underrun) holds
 *   until a lead and a step of text are in hand, or as long has passed: it
 *   waits until there is enough to stream smoothly, once.
 * - Then it reveals at the base pace, never slower while text is in hand,
 *   leaning faster (LEAD_GAIN, at most MAX_SURGE) when more than the lead
 *   is buffered, and every character shows within CATCH_UP_MS of arriving,
 *   so a burst (a whole reply at once) plays out over steps instead of
 *   landing in one.
 * - A pause past PAUSE_MS starts a new spurt without poisoning the rate.
 * - The stream's end does not snap: what is in hand drains at the same pace
 *   (no hold), the last step showing the whole text.
 * - Steps every REVEAL.stepMs (100 ms), as Claude's reveal does, so each step
 *   carries what 100 ms of the stream holds (a phrase), and asks for a frame
 *   only when a step is due: between steps it waits on a timer, since every
 *   requested frame runs the page's style and paint lifecycle (144 a second
 *   on a 144 Hz screen, a fifth of a core).
 * - Shows whole words (`revealCut`): a step ends at a word boundary, and a
 *   bare block marker or a table's header row waits for its content. Each
 *   step fades in whole (lib/streamReveal.ts).
 * - A non-append rewrite (final text differing from the deltas) and a
 *   hidden pane snap.
 * - Mount baselines to the full text (history, a re-attach, a row scrolled
 *   back into view), unless the row was born live (`fromStart`): then it
 *   reveals from its first word, whatever its first commit carried.
 */

export const FLOOR_CPS = 25;
/** Frame deltas clamp here so a background tab does not dump everything at
 *  once; above a step plus the frame's wait, so the pace is not shaved. */
export const MAX_FRAME_MS = 250;

/** The seed lead on this machine: the host's own deltas come every ~20 ms
 *  (p99 24 ms), so one step covers them. */
export const LEAD_LOCAL_MS = 100;
/** The seed lead for a thread on another host: the tunnel's gaps ran p90
 *  99 ms and p99 120 ms; this is twice the p99 and a little. */
export const LEAD_REMOTE_MS = 250;
/** The lead never drops under this… */
export const LEAD_MIN_MS = 100;
/** …nor grows past this: a longer wait costs more than a hitch. */
export const LEAD_MAX_MS = 800;
/** An underrun multiplies the lead by this (or adds the wait, if more). */
export const LEAD_GROWTH = 1.5;
/** With no underrun, the lead's excess over its floor decays with this
 *  time constant: ten steady seconds after a stall it has shed 80% of what
 *  the stall added. */
export const LEAD_DECAY_MS = 6000;
/** Every character shows within this long of arriving. */
export const CATCH_UP_MS = 1500;
/** The base pace before the stream has shown its rate (prose measured at
 *  512 to 2,361 chars/s). */
export const DEFAULT_CPS = 400;
/** A burst's arrival rate (a whole reply in 4 ms reads as 800,000 chars/s)
 *  is clamped here before it becomes the base pace. */
export const BASE_MAX_CPS = 1500;
/** The lead's floor is this many high-percentile gaps. */
export const TARGET_LAG_GAPS = 2;
/** The gap percentile the lead covers: most gaps, not the one-off stall. */
export const GAP_PERCENTILE = 0.9;
/** Recent gaps kept for the percentile. */
export const GAP_SAMPLES = 32;
/** The arrival rate is the text that arrived over this long, divided by
 *  the time it took: clumped frames count whole, unlike an average of
 *  chars and gaps, which reads low when frames land together. A gap counts
 *  as PAUSE_MS at most, so the frames a stalled link releases at once read
 *  as the stream's rate, not a surge, and a pause only dims it. */
export const RATE_WINDOW_MS = 1500;
/** How hard the pace leans faster when more than the lead is in hand: at
 *  0.3 a buffer 10% over the lead runs 3% faster. */
export const LEAD_GAIN = 0.3;
/** The lean never runs faster than this many times the base pace. */
export const MAX_SURGE = 1.5;
/** A gap this long is a pause (the model thinking, a tool running), not
 *  jitter: the next arrival starts a new spurt and the rate keeps what it
 *  knew. */
export const PAUSE_MS = 1000;
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
 * whole; neither inside an open code fence. Inside one a code line shows
 * whole once its newline arrives: the cut is held to the line's start, unless
 * `holdOpenLine` is false (the line has been held REVEAL.lineHoldMs), when it
 * steps by words like prose. Once nothing is left to reveal (the stream
 * ended and drained) the cut is the whole text.
 */
export function revealCut(text: string, pos: number, revealing: boolean, holdOpenLine = true): number {
  if (!revealing) return text.length;
  let cut = Math.max(0, Math.min(pos, text.length));
  if (cut === 0) return 0;
  let boundary = cut;
  while (boundary > 0 && !SPACE.test(text[boundary - 1])) boundary--;
  if (cut - boundary <= REVEAL.longTokenChars) cut = boundary;
  else if (isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return holdBlockStart(text, cut, holdOpenLine);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const TABLE_LINE = /^[ \t]*\|/;

/** The cut pulled back to the start of a trailing bare marker, an
 *  unfinished table or, with `holdOpenLine`, an open fence's unfinished line. */
function holdBlockStart(text: string, cut: number, holdOpenLine: boolean): number {
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
  // A code line shows once its newline has come; the closing fence as typed.
  if (fenced && !FENCE.test(last)) return holdOpenLine ? starts[lastIndex] : cut;
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
  /** gaps learned from since the pacer started */
  samples: number;
  /** the arrivals of the rate's window, oldest first: when each landed on
   *  the rate's clock (its gaps each PAUSE_MS at most) and the chars counted
   *  up to it (a burst counted at BASE_MAX_CPS) */
  window: { at: number; counted: number }[];
  /** recent gaps (ms), oldest first */
  gaps: number[];
  /** the lead (ms of text at the base pace) held behind the live end */
  lead: number;
  /** a spurt waits to start (see `stepPacer`) */
  holding: boolean;
  /** when the current spurt's first chunk arrived (ms) */
  spurtAt: number;
  /** when the shown text reached the live end while live (ms), NaN otherwise */
  dryAt: number;
  /** the arrivals not yet wholly shown, oldest first, one per step: where
   *  each ended and when it landed, for the catch-up's due times */
  due: { end: number; at: number }[];
}

export function newPacer(length: number, leadMs: number = LEAD_LOCAL_MS): Pacer {
  return {
    pos: length,
    end: length,
    lastArrival: NaN,
    samples: 0,
    window: [],
    gaps: [],
    lead: leadMs,
    holding: false,
    spurtAt: NaN,
    dryAt: NaN,
    due: [],
  };
}

/** The shown text jumps to `length` (a rewrite, a hidden pane); the
 *  stream's rhythm and the lead are kept. */
export function snapPacer(p: Pacer, length: number): void {
  p.pos = length;
  p.end = length;
  p.holding = false;
  p.dryAt = NaN;
  p.due = [];
}

/** The text grew to `end` at `now` (ms). */
export function noteArrival(p: Pacer, end: number, now: number): void {
  const chars = end - p.end;
  if (chars <= 0) {
    p.end = end;
    if (p.pos > end) p.pos = end;
    for (const d of p.due) d.end = Math.min(d.end, end);
    return;
  }
  const first = Number.isNaN(p.lastArrival);
  const gap = now - p.lastArrival;
  p.end = end;
  p.lastArrival = now;
  // Arrivals inside one step share an entry, due with the first of them.
  const lastDue = p.due[p.due.length - 1];
  if (lastDue && now - lastDue.at < REVEAL.stepMs) lastDue.end = end;
  else p.due.push({ end, at: now });
  if (!Number.isNaN(p.dryAt)) {
    // This chunk ends an underrun: the lead was too short for this link.
    const lead = currentLead(p);
    p.lead = Math.min(LEAD_MAX_MS, Math.max(lead * LEAD_GROWTH, lead + Math.min(now - p.dryAt, PAUSE_MS)));
    p.dryAt = NaN;
    startSpurt(p, now);
  } else if (first) startSpurt(p, now);
  if (first) {
    p.window = [{ at: 0, counted: 0 }];
    return;
  }
  // A burst counts at BASE_MAX_CPS over a step at most, so it never runs the
  // base fast for the rest of the stream: the catch-up plays it out.
  const counted = Math.min(chars, (Math.max(gap, REVEAL.stepMs) * BASE_MAX_CPS) / 1000);
  const last = p.window[p.window.length - 1];
  const at = last.at + Math.min(Math.max(0, gap), PAUSE_MS);
  p.window.push({ at, counted: last.counted + counted });
  // Keep one arrival at or before the window's start as its anchor.
  while (p.window.length > 2 && p.window[1].at <= at - RATE_WINDOW_MS) p.window.shift();
  p.samples++;
  // A pause is not jitter: the lead's floor learns from the gaps under it.
  if (gap > PAUSE_MS) return;
  p.gaps.push(gap);
  if (p.gaps.length > GAP_SAMPLES) p.gaps.shift();
}

function startSpurt(p: Pacer, now: number): void {
  p.holding = true;
  p.spurtAt = now;
}

/** Chars per ms the stream has been arriving at; 0 before the first gap. */
export function arrivalRate(p: Pacer): number {
  const w = p.window;
  const span = w.length < 2 ? 0 : w[w.length - 1].at - w[0].at;
  return span > 0 ? (w[w.length - 1].counted - w[0].counted) / span : 0;
}

/** The base pace (chars per ms): the arrival rate within its clamps, or
 *  DEFAULT_CPS before the stream has shown one. */
export function basePace(p: Pacer): number {
  const rate = arrivalRate(p);
  if (rate <= 0) return DEFAULT_CPS / 1000;
  return Math.min(BASE_MAX_CPS / 1000, Math.max(FLOOR_CPS / 1000, rate));
}

/** The GAP_PERCENTILE gap of the recent arrivals (ms). */
export function highGap(p: Pacer): number {
  if (p.gaps.length === 0) return 0;
  const sorted = p.gaps.slice().sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(GAP_PERCENTILE * sorted.length))];
}

/** The least lead the stream's gaps call for (ms). */
export function leadFloor(p: Pacer): number {
  return Math.min(LEAD_MAX_MS, Math.max(LEAD_MIN_MS, TARGET_LAG_GAPS * highGap(p)));
}

/** The lead the pacer holds now (ms): its own, never under the floor. */
export function currentLead(p: Pacer): number {
  return Math.max(leadFloor(p), p.lead);
}

/** The pace (chars per ms) that shows every arrival within CATCH_UP_MS of
 *  when it landed. */
export function catchUpPace(p: Pacer, now: number): number {
  while (p.due.length > 0 && p.due[0].end <= p.pos) p.due.shift();
  let pace = 0;
  for (const d of p.due) pace = Math.max(pace, (d.end - p.pos) / Math.max(REVEAL.stepMs, d.at + CATCH_UP_MS - now));
  return pace;
}

/**
 * One step: advance the shown position by `dt` ms at `now` and return it.
 * The lead decays toward its floor; a spurt that is holding waits until a
 * lead and a step of text are in hand, or as long has passed (live only); then
 * the pace is the base, leaned faster while more than the lead is in hand,
 * and never under the catch-up's. With nothing in hand while live an
 * underrun begins, which the next arrival measures.
 */
export function stepPacer(p: Pacer, dt: number, now: number, live: boolean): number {
  const floor = leadFloor(p);
  if (p.lead > floor && Number.isNaN(p.dryAt)) p.lead = floor + (p.lead - floor) * Math.exp(-dt / LEAD_DECAY_MS);
  const inHand = p.end - p.pos;
  if (inHand <= 0) {
    p.pos = p.end;
    if (live && Number.isNaN(p.dryAt)) p.dryAt = now;
    return p.pos;
  }
  const base = basePace(p);
  const lead = currentLead(p);
  const bufferMs = inHand / base;
  if (p.holding) {
    // Enough that a lead is left once the first step has shown its share.
    const enough = lead + REVEAL.stepMs;
    if (live && bufferMs < enough && now - p.spurtAt < enough) return p.pos;
    p.holding = false;
  }
  // The lead is what is left once this step has shown its share, so a
  // steady stream settles a lead ahead rather than at the live end.
  const gain = Math.min(MAX_SURGE, 1 + (LEAD_GAIN * Math.max(0, bufferMs - dt - lead)) / lead);
  const pace = Math.max(base * gain, catchUpPace(p, now));
  p.pos = Math.min(p.end, p.pos + pace * dt);
  if (live && p.pos >= p.end) p.dryAt = now;
  return p.pos;
}

interface Reveal {
  pacer: Pacer;
  prev: string;
  target: string;
  live: boolean | undefined;
  /** The row was born live and has not run its first effect yet. */
  born: boolean;
  raf: number;
  /** The wait for the next paint's frame. */
  timer: number;
  /** A reveal is under way: an arrival keeps its clock instead of restarting it. */
  running: boolean;
  lastFrame: number;
  lastPaint: number;
}

export interface SmoothTextOptions {
  /** The row was born live: reveal from its first word, whatever its first
   *  commit carried, streaming or not. */
  fromStart?: boolean;
  /** The seed lead (ms): LEAD_REMOTE_MS for a thread on another host. */
  leadMs?: number;
}

export function useSmoothText(text: string, streaming: boolean | undefined, opts?: SmoothTextOptions): string {
  const fromStart = !!opts?.fromStart;
  const [shown, setShown] = useState(fromStart ? 0 : text.length);
  const st = useRef<Reveal>({
    pacer: newPacer(fromStart ? 0 : text.length, opts?.leadMs),
    prev: fromStart ? "" : text,
    target: text,
    live: streaming,
    born: fromStart,
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
    // A settled row whose text changes with nothing in hand (not born live)
    // shows it at once; a stream, or one still draining, paces it.
    const pacing = streaming || p.pos < p.end || s.born;
    s.born = false;
    if (!paneShown || !pacing || isRewrite(s.prev, text, p.pos)) {
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
      // Stepped even with nothing in hand, so the pacer marks the underrun.
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

  // A code line held open past REVEAL.lineHoldMs (a long line, or a model
  // that writes code with no newline for a while) steps by words from then
  // on, so every character still shows within the catch-up's promise. The
  // hold is keyed by the line's start, so the next line holds afresh.
  const revealing = !!streaming || shown < text.length;
  const held = revealCut(text, shown, revealing);
  const free = revealCut(text, shown, revealing, false);
  const heldAt = held < free ? held : null;
  const [released, setReleased] = useState<number | null>(null);
  useEffect(() => {
    if (heldAt === null) return;
    const timer = window.setTimeout(() => setReleased(heldAt), REVEAL.lineHoldMs);
    return () => clearTimeout(timer);
  }, [heldAt]);
  const cut = heldAt !== null && released === heldAt ? free : held;
  return cut >= text.length ? text : text.slice(0, cut);
}
