/**
 * Drives the pacer the way useSmoothText does, for the tests: a step every
 * REVEAL.stepMs plus 0–16 ms of timer jitter, each arrival noted when it
 * lands, the loop resting once the shown text reached the live end and
 * starting again (its clock from the arrival) when the next chunk lands.
 */
import { REVEAL } from "../lib/ease";
import { MAX_FRAME_MS, basePace, currentLead, leadFloor, newPacer, noteArrival, stepPacer, type Pacer } from "../surfaces/smoothText";

export interface Arrival {
  t: number;
  chars: number;
}

export interface SimStep {
  t: number;
  /** the ms the step advanced by */
  dt: number;
  /** chars revealed this step */
  chars: number;
  /** chars in hand before the step */
  inHand: number;
  /** the base pace (chars per ms) the step ran at */
  base: number;
  /** the lead held (ms), and the floor the gaps call for */
  lead: number;
  floor: number;
  live: boolean;
  /** the step was a spurt's hold */
  held: boolean;
}

export interface SimRun {
  steps: SimStep[];
  /** when an underrun began (the shown text reached the live end while live) */
  underruns: number[];
  /** when the last character showed */
  doneAt: number;
  /** when the stream ended (the last arrival, or `endAt`) */
  endAt: number;
  pacer: Pacer;
}

export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function simulate(
  arrivals: Arrival[],
  { leadMs, endAt, seed = 11 }: { leadMs?: number; endAt?: number; seed?: number } = {},
): SimRun {
  const r = prng(seed);
  const p = newPacer(0, leadMs);
  const streamEnd = endAt ?? arrivals[arrivals.length - 1].t;
  const steps: SimStep[] = [];
  const underruns: number[] = [];
  let next = 0;
  let end = 0;
  let running = false;
  let lastFrame = 0;
  let lastPaint = -Infinity;
  let stepAt = Infinity;
  const total = arrivals.reduce((a, b) => a + b.chars, 0);
  const land = (until: number): void => {
    while (next < arrivals.length && arrivals[next].t <= until) {
      const a = arrivals[next++];
      end += a.chars;
      noteArrival(p, end, a.t);
      if (!running && p.pos < p.end) {
        running = true;
        lastFrame = a.t;
        stepAt = Math.max(a.t, lastPaint + REVEAL.stepMs) + 16 * r();
      }
    }
  };
  for (let guard = 0; guard < 100_000; guard++) {
    if (!running) {
      if (next >= arrivals.length) break;
      land(arrivals[next].t);
      continue;
    }
    land(stepAt);
    const t = stepAt;
    const live = t < streamEnd;
    const dryBefore = p.dryAt;
    const before = p.pos;
    const inHand = p.end - p.pos;
    const base = basePace(p);
    const lead = currentLead(p);
    const floor = leadFloor(p);
    const holding = p.holding;
    const dt = Math.min(t - lastFrame, MAX_FRAME_MS);
    stepPacer(p, dt, t, live);
    lastFrame = t;
    lastPaint = t;
    if (Number.isNaN(dryBefore) && !Number.isNaN(p.dryAt)) underruns.push(t);
    steps.push({ t, dt, chars: p.pos - before, inHand, base, lead, floor, live, held: holding && p.pos === before });
    if (p.pos >= p.end) {
      running = false;
      if (p.end >= total) return { steps, underruns, doneAt: t, endAt: streamEnd, pacer: p };
      continue;
    }
    stepAt = t + REVEAL.stepMs + 16 * r();
  }
  return { steps, underruns, doneAt: NaN, endAt: streamEnd, pacer: p };
}

/** A remote host: a frame every `every` ms carrying `cps` worth of text,
 *  each delivered `delay(sent)` ms after it was sent and never before the
 *  one ahead of it. */
export function frames(every: number, cps: number, durationMs: number, delay: (sent: number) => number): Arrival[] {
  const out: Arrival[] = [];
  let last = 0;
  for (let t = 0; t < durationMs; t += every) {
    last = Math.max(last, t + delay(t));
    out.push({ t: last, chars: Math.round((cps * every) / 1000) });
  }
  return out;
}

/** A local harness: a delta every 7 ms of a varying few chars. */
export function localDeltas(cps: number, durationMs: number): Arrival[] {
  const r = prng(1);
  const out: Arrival[] = [];
  let owed = 0;
  for (let t = 0; t < durationMs; t += 7) {
    owed += (cps * 7) / 1000;
    const chars = Math.max(1, Math.round(owed * (0.5 + r())));
    owed -= chars;
    out.push({ t, chars });
  }
  return out;
}

export function cov(vs: number[]): number {
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  return sd / mean;
}
