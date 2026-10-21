import { describe, expect, it } from "vitest";
import {
  FLOOR_CPS,
  MAX_LAG,
  MAX_LAG_MS,
  MIN_LAG_MS,
  PAUSE_MS,
  TAU_DRAIN_MS,
  TAU_STREAM_MS,
  advanceReveal,
  arrivalRate,
  isRewrite,
  newPacer,
  noteArrival,
  stepPacer,
  targetLagMs,
} from "./smoothText";

describe("advanceReveal", () => {
  it("reveals remaining × (1 − e^(−dt/τ)) while streaming", () => {
    const next = advanceReveal(0, 1000, TAU_STREAM_MS, true);
    expect(next).toBeCloseTo(1000 * (1 - Math.exp(-1)), 6);
  });

  it("drains faster once the stream ends", () => {
    const live = advanceReveal(0, 1000, 50, true);
    const drain = advanceReveal(0, 1000, 50, false);
    expect(drain).toBeGreaterThan(live);
    expect(drain).toBeCloseTo(1000 * (1 - Math.exp(-50 / TAU_DRAIN_MS)), 6);
  });

  it("never moves slower than the 25 chars/s floor", () => {
    // 2 chars left: exponential step would be tiny; the floor wins.
    const next = advanceReveal(98, 100, 16, true);
    expect(next - 98).toBeCloseTo((16 * FLOOR_CPS) / 1000, 9);
  });

  it("never overshoots the live end", () => {
    expect(advanceReveal(99.9, 100, 1000, false)).toBe(100);
    expect(advanceReveal(100, 100, 16, true)).toBe(100);
  });

  it("skips ahead when the lag exceeds the cap", () => {
    const next = advanceReveal(0, 5000, 16, true);
    expect(5000 - next).toBe(MAX_LAG);
  });

  it("converges to the end in a bounded number of frames", () => {
    let pos = 0;
    let frames = 0;
    while (pos < 400 && frames < 1000) {
      pos = advanceReveal(pos, 400, 16, true);
      frames++;
    }
    expect(pos).toBe(400);
    // Exponential toward the tail then the floor: well under a second of frames.
    expect(frames).toBeLessThan(300);
  });
});

describe("isRewrite", () => {
  it("treats an append as no rewrite", () => {
    expect(isRewrite("hello", "hello world", 5)).toBe(false);
  });

  it("flags a change inside the revealed prefix", () => {
    expect(isRewrite("hello", "jello world", 5)).toBe(true);
  });

  it("ignores changes past the revealed position", () => {
    // "hello " is shared; the first differing glyph sits at index 6.
    expect(isRewrite("hello world", "hello there", 6)).toBe(false);
    expect(isRewrite("hello world", "hello there", 6.9)).toBe(false);
    expect(isRewrite("hello world", "hello there", 7)).toBe(true);
  });
});

// ── the jitter buffer, simulated ─────────────────────────────────────
//
// A stream at CPS chars/s reaches the renderer as one of the patterns
// below; a 60 fps loop notes what arrived by each frame (the store bumps
// once per frame, so that is when the hook sees it) and steps the reveal.
// The measure is the reveal speed per frame while the stream is live,
// after a warm-up: its coefficient of variation (sd / mean) is how jerky
// the text reads. `legacy` runs the backlog-proportional catch-up the
// pacer replaced, for comparison.

const CPS = 300;
const DURATION_MS = 8000;
const WARMUP_MS = 1500;
const FRAME_MS = 1000 / 60;

interface Arrival {
  t: number;
  chars: number;
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A local harness: a delta every 7 ms of a varying few chars. */
function localDeltas(): Arrival[] {
  const r = prng(1);
  const out: Arrival[] = [];
  let owed = 0;
  for (let t = 0; t < DURATION_MS; t += 7) {
    owed += (CPS * 7) / 1000;
    const chars = Math.max(1, Math.round(owed * (0.5 + r())));
    owed -= chars;
    out.push({ t, chars });
  }
  return out;
}

/** A remote host: a frame every `every` ms, each sent frame delivered
 *  `delay` ms later and never before the one ahead of it. */
function frames(every: number, delay: (sent: number) => number): Arrival[] {
  const out: Arrival[] = [];
  let last = 0;
  for (let t = 0; t < DURATION_MS; t += every) {
    last = Math.max(last, t + delay(t));
    out.push({ t: last, chars: (CPS * every) / 1000 });
  }
  return out;
}

const steady100 = (): Arrival[] => frames(100, () => 20);
const jittered100 = (): Arrival[] => {
  const r = prng(7);
  return frames(100, () => 20 + 60 * r());
};
const jittered33 = (): Arrival[] => {
  const r = prng(3);
  return frames(33, () => 20 + 30 * r());
};
/** The link holds everything for `stallMs` after the frame sent at 4 s:
 *  one gap of 100 + stallMs ms, then the held frames land together. */
const stalled = (stallMs: number) => (): Arrival[] =>
  frames(100, (t) => 20 + (t > 4000 && t < 4000 + stallMs + 100 ? 4000 + stallMs + 100 - t : 0));

interface Run {
  cov: number;
  mean: number;
  min: number;
  max: number;
  /** mean ms of text between shown and arrived */
  lagMs: number;
  /** speeds by frame time, for a window of the run */
  speeds: { t: number; v: number }[];
}

function simulate(arrivals: Arrival[], legacy = false): Run {
  const pacer = newPacer(0);
  let legacyPos = 0;
  let end = 0;
  let next = 0;
  const speeds: { t: number; v: number }[] = [];
  let lag = 0;
  const live = arrivals[arrivals.length - 1].t;
  for (let t = 0; t <= live; t += FRAME_MS) {
    while (next < arrivals.length && arrivals[next].t <= t) end += arrivals[next++].chars;
    noteArrival(pacer, end, t);
    const before = legacy ? legacyPos : pacer.pos;
    const after = legacy
      ? (legacyPos = advanceReveal(legacyPos, end, FRAME_MS, true))
      : stepPacer(pacer, FRAME_MS, t, true);
    if (t >= arrivals[0].t + WARMUP_MS) {
      speeds.push({ t, v: ((after - before) / FRAME_MS) * 1000 });
      lag += ((end - after) / CPS) * 1000;
    }
  }
  return { ...stats(speeds.map((s) => s.v)), lagMs: lag / speeds.length, speeds };
}

function stats(vs: number[]): { cov: number; mean: number; min: number; max: number } {
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  return { cov: sd / mean, mean, min: Math.min(...vs), max: Math.max(...vs) };
}

describe("jitter buffer (simulated streams)", () => {
  it("local deltas every 7 ms: as smooth as before, keeping up with the stream at the minimum lag", () => {
    const now = simulate(localDeltas());
    const before = simulate(localDeltas(), true);
    expect(now.cov).toBeLessThan(0.05);
    expect(now.cov).toBeLessThanOrEqual(before.cov + 0.005);
    expect(Math.abs(now.mean - CPS) / CPS).toBeLessThan(0.02);
    // at most the minimum lag plus a frame of arrivals; the old catch-up
    // trailed by τ (about 320 ms)
    expect(now.lagMs).toBeLessThan(MIN_LAG_MS + 2 * FRAME_MS);
    expect(now.lagMs).toBeLessThan(before.lagMs);
  });

  it("steady 100 ms frames: an even pace, where the old catch-up surged on every frame", () => {
    const now = simulate(steady100());
    const before = simulate(steady100(), true);
    expect(now.cov).toBeLessThan(0.05);
    expect(before.cov).toBeGreaterThan(0.05);
    expect(Math.abs(now.mean - CPS) / CPS).toBeLessThan(0.02);
    // the playout delay is twice the gap, plus half a gap on average
    expect(now.lagMs).toBeGreaterThan(200);
    expect(now.lagMs).toBeLessThan(300);
  });

  it("100 ms frames with 0–60 ms of jitter: still an even pace", () => {
    const now = simulate(jittered100());
    const before = simulate(jittered100(), true);
    expect(now.cov).toBeLessThan(0.05);
    expect(before.cov).toBeGreaterThan(0.05);
    expect(now.lagMs).toBeLessThan(MAX_LAG_MS);
  });

  it("33 ms frames with jitter (the remote events window): an even pace at the minimum lag", () => {
    const now = simulate(jittered33());
    expect(now.cov).toBeLessThan(0.05);
    expect(now.lagMs).toBeLessThan(MIN_LAG_MS + 50);
  });

  it("a 300 ms gap (a frame 200 ms late, the edge of the buffer): an even pace", () => {
    const now = simulate(stalled(200)());
    const before = simulate(stalled(200)(), true);
    expect(now.cov).toBeLessThan(0.05);
    expect(before.cov).toBeGreaterThan(0.1);
    expect(now.min).toBeGreaterThan(0.4 * CPS);
    expect(now.max).toBeLessThan(1.05 * CPS);
  });

  it("one 300 ms stall (a 400 ms gap): eases down and back without stopping or surging, and is even again within a second", () => {
    const now = simulate(stalled(300)());
    const before = simulate(stalled(300)(), true);
    // The buffer (twice the 100 ms gap) cannot cover a frame 300 ms late:
    // when the frame is first overdue 200 ms of text is left for 300 ms of
    // wait, so any reveal that does not see the future dips here (its CoV
    // over this run cannot go much under 0.07). It never stops and never
    // surges...
    expect(now.min).toBeGreaterThan(0.1 * CPS);
    expect(now.max).toBeLessThan(1.15 * CPS);
    expect(before.max).toBeGreaterThan(1.5 * CPS);
    expect(now.cov).toBeLessThan(before.cov);
    // ...and away from it the pace is as even as a steady stream's.
    const calm = (from: number, to: number) => stats(now.speeds.filter((s) => s.t >= from && s.t < to).map((s) => s.v));
    expect(calm(0, 4000).cov).toBeLessThan(0.05);
    expect(calm(5500, DURATION_MS).cov).toBeLessThan(0.05);
  });
});

describe("pacer", () => {
  it("learns nothing from the first chunk and reveals it with the exponential catch-up", () => {
    const p = newPacer(0);
    noteArrival(p, 50, 0);
    expect(arrivalRate(p)).toBe(0);
    expect(stepPacer(p, 16, 16, true)).toBeCloseTo(advanceReveal(0, 50, 16, true), 9);
  });

  it("measures the arrival rate and holds a lag of twice the high gap, within its clamps", () => {
    const p = newPacer(0);
    for (let i = 0; i <= 20; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    expect(arrivalRate(p) * 1000).toBeCloseTo(300, 6);
    expect(targetLagMs(p)).toBeCloseTo(200, 6);
    const fast = newPacer(0);
    for (let i = 0; i <= 50; i++) noteArrival(fast, 2 * (i + 1), 7 * i);
    expect(targetLagMs(fast)).toBe(MIN_LAG_MS);
    const slow = newPacer(0);
    for (let i = 0; i <= 10; i++) noteArrival(slow, 300 * (i + 1), 900 * i);
    expect(targetLagMs(slow)).toBe(MAX_LAG_MS);
  });

  it("a pause past PAUSE_MS starts a new spurt without dragging the rate down", () => {
    const p = newPacer(0);
    for (let i = 0; i <= 20; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    const rate = arrivalRate(p);
    noteArrival(p, 30 * 22, 2000 + PAUSE_MS + 1);
    expect(arrivalRate(p)).toBe(rate);
  });

  it("drains with the end-of-stream catch-up once the stream ends", () => {
    const p = newPacer(0);
    for (let i = 0; i <= 20; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    p.pos = 400;
    expect(stepPacer(p, 16, 2016, false)).toBeCloseTo(advanceReveal(400, 630, 16, false), 9);
  });

  it("keeps the lag cap: a torrent skips ahead", () => {
    const p = newPacer(0);
    for (let i = 0; i <= 20; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    noteArrival(p, 5000, 2050);
    expect(p.end - stepPacer(p, 16, 2066, true)).toBe(MAX_LAG);
  });

  it("never passes the live end", () => {
    const p = newPacer(0);
    for (let i = 0; i <= 20; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    p.pos = 629.99;
    expect(stepPacer(p, 100, 2100, true)).toBe(630);
    expect(stepPacer(p, 16, 2116, true)).toBe(630);
  });
});
