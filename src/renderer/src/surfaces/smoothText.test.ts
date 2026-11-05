import { describe, expect, it } from "vitest";
import {
  BASE_MAX_CPS,
  CATCH_UP_MS,
  DEFAULT_CPS,
  FLOOR_CPS,
  LEAD_DECAY_MS,
  LEAD_LOCAL_MS,
  LEAD_MAX_MS,
  LEAD_MIN_MS,
  LEAD_REMOTE_MS,
  MAX_SURGE,
  PAUSE_MS,
  arrivalRate,
  basePace,
  catchUpPace,
  currentLead,
  isRewrite,
  leadFloor,
  newPacer,
  noteArrival,
  revealCut,
  stepPacer,
} from "./smoothText";
import { REVEAL } from "../lib/ease";
import { cov, frames, localDeltas, prng, simulate, type Arrival, type SimRun } from "../test/revealSim";

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
// test/revealSim.ts drives the pacer the way the hook does: a step every
// REVEAL.stepMs plus 0–16 ms of timer jitter, arrivals noted as they land.
// The cadences are the ones measured on 2026-11-05 between the box and the
// Mac (docs/TRANSCRIPT.md "The stream reveals a phrase at a time").

const CPS = 500;

/** The steps after the first one that moved. */
function afterStart(run: SimRun) {
  const first = run.steps.findIndex((s) => s.chars > 0);
  return run.steps.slice(first);
}

/**
 * The rules every run keeps: once a spurt has started no step shows nothing
 * while text is in hand (a hold is the only empty step with text in hand),
 * and no step shows more than the faster of the surge on the base pace and
 * the catch-up's pace on the largest backlog of the last CATCH_UP_MS, plus
 * the one long token a word cut may release.
 */
function keepsTheRules(run: SimRun): void {
  const steps = afterStart(run);
  for (const s of steps) if (s.inHand > 0 && !s.held) expect(s.chars, `step at ${s.t}`).toBeGreaterThan(0);
  for (let i = 0; i < run.steps.length; i++) {
    const s = run.steps[i];
    const recent = run.steps.filter((o) => o.t <= s.t && o.t > s.t - CATCH_UP_MS);
    const backlog = Math.max(...recent.map((o) => o.inHand));
    const bound = Math.max(MAX_SURGE * s.base * s.dt, (backlog * s.dt) / (CATCH_UP_MS - REVEAL.stepMs)) + REVEAL.longTokenChars;
    expect(s.chars, `step at ${s.t}`).toBeLessThanOrEqual(bound);
  }
}

/** The steady stretch's per-step speed: chars over dt, live, after `from`. */
function speedCov(run: SimRun, from: number, to = Infinity): number {
  return cov(run.steps.filter((s) => s.live && s.t >= from && s.t < to && s.chars > 0).map((s) => s.chars / s.dt));
}

/** The Mac's measured remote cadence: frames every 33 ms, each 0–100 ms late
 *  and never before the one ahead of it. */
const macRemote = (): Arrival[] => {
  const r = prng(3);
  return frames(33, CPS, 8000, () => 100 * r());
};
/** A lagging box: frames every 250 ± 60 ms. */
const laggingBox = (durationMs = 8000): Arrival[] => {
  const r = prng(5);
  return frames(250, CPS, durationMs, () => 60 * r());
};
/** The same with the link holding everything for a second from 4 s. */
const stalledBox = (durationMs = 8000): Arrival[] =>
  laggingBox(durationMs).map((a) => (a.t > 4000 && a.t < 5000 ? { ...a, t: 5000 } : a));
/** A whole reply: 3,342 chars inside 20 ms, the stream ending 30 ms later. */
const WHOLE = 3342;
const wholeReply = (): Arrival[] =>
  Array.from({ length: 143 }, (_, i) => ({ t: 1000 + (i * 20) / 143, chars: i < 142 ? 23 : WHOLE - 23 * 142 }));
/** One 1,632-char frame in a 33 ms stream. */
const BURST = 1632;
const burstFrame = (): { arrivals: Arrival[]; at: number } => {
  const r = prng(9);
  const arrivals = frames(33, CPS, 6000, () => 20 * r());
  const k = Math.floor(arrivals.length / 2);
  arrivals[k] = { ...arrivals[k], chars: BURST };
  return { arrivals, at: arrivals[k].t };
};

describe("jitter buffer (simulated streams)", () => {
  it("the Mac's remote cadence: an even pace at the stream's rate, no underrun", () => {
    const run = simulate(macRemote(), { leadMs: LEAD_REMOTE_MS });
    keepsTheRules(run);
    expect(run.underruns).toEqual([]);
    expect(speedCov(run, 1500)).toBeLessThan(0.1);
    const live = run.steps.filter((s) => s.live && s.t >= 1500);
    const pace = (live.reduce((a, s) => a + s.chars, 0) / (live[live.length - 1].t - live[0].t)) * 1000;
    expect(Math.abs(pace - CPS) / CPS).toBeLessThan(0.1);
    // The rest drains in steps after the stream ends, within a lead or two.
    expect(run.doneAt - run.endAt).toBeLessThan(2 * LEAD_REMOTE_MS + REVEAL.stepMs);
  });

  it("a lagging box (250 ± 60 ms frames): an even pace after warm-up, at most one underrun", () => {
    const run = simulate(laggingBox(), { leadMs: LEAD_REMOTE_MS });
    keepsTheRules(run);
    expect(run.underruns.length).toBeLessThanOrEqual(1);
    expect(speedCov(run, 1500)).toBeLessThan(0.15);
    // The lead covers the link: twice its high gap.
    expect(currentLead(run.pacer)).toBeGreaterThanOrEqual(500);
  });

  it("a 1 s stall: exactly one underrun, the lead grown after it, and back near its floor ten steady seconds on", () => {
    const run = simulate(stalledBox(16_000), { leadMs: LEAD_REMOTE_MS });
    keepsTheRules(run);
    expect(run.underruns.length).toBe(1);
    expect(run.underruns[0]).toBeGreaterThan(4000);
    expect(run.underruns[0]).toBeLessThan(5000);
    const before = run.steps.filter((s) => s.t < run.underruns[0]).at(-1)!.lead;
    const after = run.steps.find((s) => s.t > 5000)!.lead;
    expect(after).toBeGreaterThan(before);
    expect(speedCov(run, 5500)).toBeLessThan(0.15);
    // Ten steady seconds after the stall the lead is within 10% of its floor.
    const later = run.steps.find((s) => s.t >= 15_000)!;
    expect(later.lead).toBeGreaterThan(later.floor);
    expect(later.lead).toBeLessThanOrEqual(1.1 * later.floor);
  });

  it("a whole reply inside 20 ms: shown over at least ten steps, all of it within CATCH_UP_MS", () => {
    const run = simulate(wholeReply(), { leadMs: LEAD_REMOTE_MS, endAt: 1050 });
    keepsTheRules(run);
    const moving = run.steps.filter((s) => s.chars > 0);
    expect(moving.length).toBeGreaterThanOrEqual(10);
    expect(run.doneAt - 1000).toBeLessThanOrEqual(CATCH_UP_MS + 2 * REVEAL.stepMs);
    // The stream ended 30 ms in: the rest drained over steps, never at once.
    const drain = run.steps.filter((s) => !s.live && s.chars > 0);
    expect(drain.length).toBeGreaterThanOrEqual(10);
    for (const s of drain) expect(s.chars).toBeLessThan(WHOLE / 5);
  });

  it("one 1,632-char frame in a 33 ms stream: played out over steps within CATCH_UP_MS, no underrun after", () => {
    const { arrivals, at } = burstFrame();
    const run = simulate(arrivals, { leadMs: LEAD_REMOTE_MS });
    keepsTheRules(run);
    const during = run.steps.filter((s) => s.t >= at && s.t <= at + CATCH_UP_MS + 2 * REVEAL.stepMs);
    expect(during.filter((s) => s.chars > 0).length).toBeGreaterThanOrEqual(10);
    // Everything that had arrived with the burst showed within the catch-up.
    const shownBy = during.reduce((a, s) => a + s.chars, 0);
    const before = run.steps.filter((s) => s.t < at).reduce((a, s) => a + s.chars, 0);
    const arrivedWith = arrivals.filter((a) => a.t <= at).reduce((a, b) => a + b.chars, 0);
    expect(before + shownBy).toBeGreaterThanOrEqual(arrivedWith);
    expect(run.underruns).toEqual([]);
  });

  it("local deltas every 7 ms: a lead under 150 ms, the pace within 2% of the stream", () => {
    const local = 300;
    const run = simulate(localDeltas(local, 8000), { leadMs: LEAD_LOCAL_MS });
    keepsTheRules(run);
    expect(run.underruns).toEqual([]);
    const live = run.steps.filter((s) => s.live && s.t >= 1500);
    const pace = (live.reduce((a, s) => a + s.chars, 0) / (live[live.length - 1].t - live[0].t)) * 1000;
    expect(Math.abs(pace - local) / local).toBeLessThan(0.02);
    // What is left behind the live end after each step, in ms of the stream.
    const lagMs = (live.reduce((a, s) => a + (s.inHand - s.chars), 0) / live.length / local) * 1000;
    expect(lagMs).toBeLessThan(150);
    expect(speedCov(run, 1500)).toBeLessThan(0.05);
  });
});

describe("pacer", () => {
  /** A pacer that has seen `n` 30-char chunks every 100 ms (300 chars/s). */
  function steady(n = 20, leadMs?: number) {
    const p = newPacer(0, leadMs);
    for (let i = 0; i <= n; i++) noteArrival(p, 30 * (i + 1), 100 * i);
    return p;
  }

  it("is seeded with the host's lead and starts where it mounts", () => {
    expect(newPacer(10)).toMatchObject({ pos: 10, end: 10, lead: LEAD_LOCAL_MS });
    const remote = newPacer(0, LEAD_REMOTE_MS);
    expect(currentLead(remote)).toBe(LEAD_REMOTE_MS);
    expect(currentLead(newPacer(0))).toBe(LEAD_LOCAL_MS);
  });

  it("measures the arrival rate over its window, and holds a lead floor of twice the high gap, within its clamps", () => {
    const p = steady();
    expect(arrivalRate(p) * 1000).toBeCloseTo(300, 6);
    expect(leadFloor(p)).toBeCloseTo(200, 6);
    const fast = newPacer(0);
    for (let i = 0; i <= 50; i++) noteArrival(fast, 2 * (i + 1), 7 * i);
    expect(leadFloor(fast)).toBe(LEAD_MIN_MS);
    const slow = newPacer(0);
    for (let i = 0; i <= 10; i++) noteArrival(slow, 300 * (i + 1), 900 * i);
    expect(leadFloor(slow)).toBe(LEAD_MAX_MS);
  });

  it("counts frames that land together whole", () => {
    // 33 ms frames released in pairs: the rate is still the stream's.
    const p = newPacer(0);
    for (let i = 0; i <= 40; i++) noteArrival(p, 17 * (i + 1), 66 * Math.floor(i / 2));
    expect(arrivalRate(p) * 1000).toBeGreaterThan(480);
    expect(arrivalRate(p) * 1000).toBeLessThan(540);
  });

  it("the base pace: DEFAULT_CPS before a gap, the rate within FLOOR_CPS and BASE_MAX_CPS", () => {
    const p = newPacer(0);
    noteArrival(p, 40, 0);
    expect(basePace(p)).toBe(DEFAULT_CPS / 1000);
    expect(basePace(steady()) * 1000).toBeCloseTo(300, 6);
    const whole = newPacer(0);
    for (const a of wholeReply()) noteArrival(whole, whole.end + a.chars, a.t);
    expect(basePace(whole)).toBe(BASE_MAX_CPS / 1000);
    const trickle = newPacer(0);
    for (let i = 0; i <= 5; i++) noteArrival(trickle, i + 1, 900 * i);
    expect(basePace(trickle)).toBe(FLOOR_CPS / 1000);
  });

  it("a burst counts at BASE_MAX_CPS over a step at most, so the base stays near the stream's", () => {
    const p = steady();
    noteArrival(p, p.end + 1632, 2100);
    expect(basePace(p) * 1000).toBeLessThan(500);
  });

  it("an underrun grows the lead by LEAD_GROWTH or by the wait, whichever is more, up to LEAD_MAX_MS", () => {
    const grow = (lead: number, stallMs: number) => {
      const p = newPacer(0, lead);
      noteArrival(p, 10, 0);
      p.pos = 10;
      p.dryAt = 1000;
      noteArrival(p, 20, 1000 + stallMs);
      return p;
    };
    expect(grow(200, 50).lead).toBe(300);
    expect(grow(200, 400).lead).toBe(600);
    expect(grow(400, 600).lead).toBe(LEAD_MAX_MS);
    // A pause past PAUSE_MS adds PAUSE_MS at most.
    expect(grow(100, 600).lead).toBe(700);
    expect(grow(100, 5 * PAUSE_MS).lead).toBe(LEAD_MAX_MS);
    // And it starts a spurt.
    const p = grow(200, 50);
    expect(p.holding).toBe(true);
    expect(p.dryAt).toBeNaN();
  });

  it("a pause past PAUSE_MS counts as PAUSE_MS on the rate's clock", () => {
    const pauses = [PAUSE_MS, 5 * PAUSE_MS].map((pause) => {
      const p = steady();
      noteArrival(p, p.end + 30, 2000 + pause);
      return arrivalRate(p);
    });
    expect(pauses[1]).toBeCloseTo(pauses[0], 9);
  });

  it("holds a spurt until a lead and a step of text are in hand, or as long has passed", () => {
    const enough = LEAD_LOCAL_MS + REVEAL.stepMs;
    // 50 chars at the default pace is 125 ms of text: the hold ends on time.
    const short = newPacer(0);
    noteArrival(short, 50, 0);
    expect(short.holding).toBe(true);
    expect(stepPacer(short, 100, 100, true)).toBe(0);
    expect(stepPacer(short, 100, enough, true)).toBeGreaterThan(0);
    // 100 chars is 250 ms of text: the hold ends at once.
    const long = newPacer(0);
    noteArrival(long, 100, 0);
    expect(stepPacer(long, 10, 10, true)).toBeGreaterThan(0);
    // Once the stream ended nothing holds.
    const ended = newPacer(0);
    noteArrival(ended, 50, 0);
    expect(stepPacer(ended, 10, 10, false)).toBeGreaterThan(0);
  });

  it("runs at the base pace while the buffer is within the lead, faster above it, never past the surge", () => {
    const p = steady(20, 200);
    p.holding = false;
    p.due = [];
    p.pos = p.end - 0.3 * 300; // 300 ms of text: a step and the lead
    const at = p.pos;
    stepPacer(p, 100, 2010, true);
    expect(p.pos - at).toBeCloseTo(30, 6);
    const q = steady(20, 200);
    q.holding = false;
    q.due = [];
    q.pos = q.end - 0.3 * 3000; // three seconds of text
    const from = q.pos;
    stepPacer(q, 100, 2010, true);
    expect(q.pos - from).toBeLessThanOrEqual(MAX_SURGE * 30 + 1e-9);
    expect(q.pos - from).toBeGreaterThan(30);
  });

  it("shows every arrival within CATCH_UP_MS: the catch-up's pace is the backlog over the time it has left", () => {
    const p = newPacer(0);
    noteArrival(p, 3000, 0);
    expect(catchUpPace(p, 0)).toBeCloseTo(3000 / CATCH_UP_MS, 9);
    p.pos = 1000;
    expect(catchUpPace(p, 500)).toBeCloseTo(2000 / (CATCH_UP_MS - 500), 9);
    expect(catchUpPace(p, CATCH_UP_MS + 500)).toBeCloseTo(2000 / REVEAL.stepMs, 9);
  });

  it("decays the lead's excess toward its floor while no underrun happens, and not during one", () => {
    const p = newPacer(100, LEAD_MAX_MS);
    noteArrival(p, 200, 0);
    stepPacer(p, LEAD_DECAY_MS, LEAD_DECAY_MS, false);
    expect(p.lead).toBeCloseTo(LEAD_MIN_MS + (LEAD_MAX_MS - LEAD_MIN_MS) * Math.exp(-1), 6);
    const dry = newPacer(0, LEAD_MAX_MS);
    dry.dryAt = 0;
    stepPacer(dry, 1000, 1000, true);
    expect(dry.lead).toBe(LEAD_MAX_MS);
  });

  it("marks an underrun when the shown text reaches the live end while live", () => {
    const p = steady();
    p.holding = false;
    p.pos = p.end - 1;
    stepPacer(p, 100, 2010, true);
    expect(p.pos).toBe(p.end);
    expect(p.dryAt).toBe(2010);
    const ended = steady();
    ended.holding = false;
    ended.pos = ended.end - 1;
    stepPacer(ended, 100, 2010, false);
    expect(ended.dryAt).toBeNaN();
  });

  it("never passes the live end", () => {
    const p = steady();
    p.holding = false;
    p.pos = 629.99;
    expect(stepPacer(p, 100, 2100, true)).toBe(630);
    expect(stepPacer(p, 16, 2116, true)).toBe(630);
  });
});

describe("revealCut", () => {
  const shown = (text: string, pos: number, revealing = true) => text.slice(0, revealCut(text, pos, revealing));

  it("ends at a word boundary, never inside a word", () => {
    expect(shown("the transcript reads", 8)).toBe("the ");
    expect(shown("the transcript reads", 15)).toBe("the transcript ");
    expect(shown("the transcript reads", 4)).toBe("the ");
    expect(shown("the transcript reads", 3)).toBe("");
    expect(shown("one\ntwo three", 6)).toBe("one\n");
  });

  it("holds the live end's unfinished word", () => {
    expect(shown("the transcri", 12)).toBe("the ");
  });

  it("cuts a token longer than REVEAL.longTokenChars at the position", () => {
    const url = "see https://example.com/a/very/long/path/to/a/file.ts";
    const pos = 4 + REVEAL.longTokenChars + 6;
    expect(shown(url, pos)).toBe(url.slice(0, pos));
    expect(shown("see " + "x".repeat(REVEAL.longTokenChars), 4 + REVEAL.longTokenChars)).toBe("see ");
  });

  it("never splits a surrogate pair", () => {
    const text = "a".repeat(REVEAL.longTokenChars + 2) + "😀😀";
    const pos = REVEAL.longTokenChars + 3; // inside the first emoji
    const cut = revealCut(text, pos, true);
    expect(cut).toBe(pos - 1);
    expect(text.charCodeAt(cut - 1)).toBeLessThan(0xd800);
  });

  it.each([
    ["# ", "# Title "],
    ["### ", "### Title "],
    ["- ", "- item "],
    ["* ", "* item "],
    ["+ ", "+ item "],
    ["1. ", "1. item "],
    ["2) ", "2) item "],
    ["- [ ] ", "- [ ] task "],
    ["- [x] ", "- [x] done "],
    ["> - ", "> - quoted "],
    ["> ", "> quoted "],
  ])("holds a bare %j until its line has content", (marker, full) => {
    const before = "Intro line\n";
    expect(shown(before + full, (before + marker).length)).toBe(before);
    expect(shown(before + full, (before + full).length)).toBe(before + full);
  });

  it("holds a table's header row until its delimiter row is whole", () => {
    const table = "Text\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const header = "Text\n| a | b |\n";
    expect(shown(table, header.length)).toBe("Text\n");
    expect(shown(table, header.length + 5)).toBe("Text\n");
    expect(shown(table, header.length + "|---|---|\n".length)).toBe(header + "|---|---|\n");
    expect(shown(table, table.length)).toBe(table);
  });

  it("holds a table row being typed until a cell has content", () => {
    const head = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(shown(`${head}| `, `${head}| `.length)).toBe(head);
    expect(shown(`${head}| | `, `${head}| | `.length)).toBe(head);
    expect(shown(`${head}| 3 | `, `${head}| 3 | `.length)).toBe(`${head}| 3 | `);
  });

  it("holds nothing inside an open code fence", () => {
    const code = "```sh\nls\n| grep x\n- \n";
    expect(shown(code, code.length)).toBe(code);
  });

  it("holds an open fence's unfinished line to its start, and shows it whole at its newline", () => {
    const code = "Look:\n```ts\nconst a = 1;\nconst b = 2;\n";
    const open = "Look:\n```ts\nconst a = 1;\n";
    expect(shown(code, open.length + 6)).toBe(open);
    expect(shown(code, code.length - 1)).toBe(open);
    expect(shown(code, code.length)).toBe(code);
  });

  it("steps an open fence's line by words once the hold lets it go", () => {
    const code = "```ts\nconst answer = compute(input);";
    expect(code.slice(0, revealCut(code, code.length - 3, true, false))).toBe("```ts\nconst answer = ");
    expect(code.slice(0, revealCut(code, code.length - 3, true, true))).toBe("```ts\n");
  });

  it("holds no line outside a fence, nor the closing fence as it is typed", () => {
    const prose = "one line\nand the next half";
    expect(revealCut(prose, prose.length, true)).toBe(revealCut(prose, prose.length, true, false));
    const closing = "```ts\nx\n```\nAfter";
    expect(shown(closing, closing.length - 5)).toBe("```ts\nx\n```\n");
  });

  it("still cuts at words while a stream that ended drains", () => {
    // The hook passes `revealing` while text is still in hand after the end.
    expect(shown("the reply has ended", 9, true)).toBe("the ");
  });

  it("shows everything once nothing is left to reveal", () => {
    for (const text of ["the transcri", "Intro\n- ", "| a | b |\n|--", "x".repeat(40)]) {
      expect(revealCut(text, 3, false)).toBe(text.length);
    }
  });
});
