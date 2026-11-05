// @vitest-environment jsdom
/**
 * No jerk in any scenario (docs/TRANSCRIPT.md): the whole transcript under
 * timed pushes, as a thread lives them. After every step: a row still on
 * screen is the same element and takes no fade again, the turn's line once
 * live is the same element, and every morph settles to one set of words
 * (`watch` in transcriptScenario.testkit.ts). The box recording
 * (`measure-renderer-soak.ts --scene scenarios --screencast`) looks at the
 * same steps frame by frame.
 */
import { act, cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";
import { setEditorConfigForTest } from "../lib/editorConfig";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { revealDrainForTest } from "./revealDrain";
import { installTranscriptLayout, phaseLog, scene, settle, settleUntil, watch, type Scene } from "./transcriptScenario.testkit";

const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduce,
}));

installTranscriptLayout();
beforeAll(() => setEditorConfigForTest(null));
beforeEach(() => {
  // Motion's frames finish at once on jsdom's clock; the transcript's own rules are what is judged.
  MotionGlobalConfig.skipAnimations = true;
});
afterEach(() => {
  cleanup();
  sessionStore.reset();
  revealDrainForTest.reset();
  MotionGlobalConfig.skipAnimations = false;
  motion.reduce = false;
  vi.restoreAllMocks();
});

const CWD = "/r";
const T0 = 1_700_000_000_000;
const pending: Block = { id: "pending:1", role: "user", text: "Add the index", pending: true };
const echoed = (over: Partial<Block> = {}): Block => ({ id: "u:1", rowKey: "pending:1", role: "user", text: "Add the index", seq: 1, startedAt: T0, ...over });
const done = (ms: number) => echoed({ doneTs: T0 + ms });
const tool = (id: string, name: string, kind: string, input: unknown, status = "running", extra: Partial<Block> = {}): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, kind, title: name, status, input },
  ...extra,
});
const read = (id: string, status?: string) => tool(id, "Read", "read", { file_path: `${CWD}/src/${id}.ts` }, status);
const bash = (id: string, status?: string) => tool(id, "Bash", "execute", { command: `bun test ${id}` }, status);
const edit = (id: string, status?: string) => tool(id, "Edit", "edit", { file_path: `${CWD}/src/${id}.ts`, old_string: "a", new_string: "b\nc" }, status);
const prose = (id: string, text: string, streaming = false): Block => ({ id, role: "assistant", text, streaming });
const thought = (id: string, text: string, streaming = true): Block => ({ id, role: "reasoning", text, streaming });

/** Push each step, let it settle, and check the rules after it. */
async function play(view: Scene, steps: [string, Block[], boolean, { status?: string; activity?: string }?][], wait = 400) {
  const rules = watch(view);
  for (const [label, blocks, busy, extra] of steps) {
    view.show(blocks, busy, extra);
    rules.check(`${label} (at once)`);
    await settle(wait);
    rules.check(label);
    rules.settled(label);
  }
}

describe("no jerk in any scenario", () => {
  it("a turn from the composer: Sending, the host's words, Thinking, calls, prose, the group opening, the closing line", async () => {
    const view = scene("s", [pending], true);
    const bubble = view.bubble();
    const line = view.line();
    await play(view, [
      ["echo", [echoed()], true, { activity: "Waiting for the provider" }],
      ["thought", [echoed(), thought("t1", "The schema has no index.")], true],
      ["first call", [echoed(), thought("t1", "The schema has no index.", false), read("a")], true],
      ["prose", [echoed(), thought("t1", "x", false), read("a", "completed"), prose("p1", "Reading it", true)], true],
      ["next call", [echoed(), thought("t1", "x", false), read("a", "completed"), prose("p1", "Reading it now."), bash("b")], true],
      ["second call: the group opens", [echoed(), thought("t1", "x", false), read("a", "completed"), prose("p1", "Reading it now."), bash("b", "completed"), edit("c")], true],
    ]);
    // Open on its own at two calls, its rows in the table.
    expect(view.container.querySelector("[data-table]")).not.toBeNull();
    await play(view, [
      ["settled", [done(124_000), thought("t1", "x", false), read("a", "completed"), prose("p1", "Reading it now."), bash("b", "completed"), edit("c", "completed"), prose("p2", "Done.")], false],
    ]);
    // The last prose was born live: it reveals and drains, and the closing line waits for it.
    await settleUntil(() => !!line?.textContent?.includes("Worked"));
    expect(view.bubble()).toBe(bubble);
    expect(view.line()).toBe(line);
    expect(line?.textContent).toContain("Worked for 2m 4s");
  });

  it("a fast turn: every phase that paints stays 300 ms, the closing line included, and none flashes", async () => {
    const view = scene("s", [pending], true);
    const phases = phaseLog(view);
    const at = (ms: number) => settle(ms);
    await at(20);
    view.show([echoed()], true);
    await at(20);
    view.show([echoed(), thought("t1", "Short.")], true);
    await at(20);
    view.show([echoed(), thought("t1", "Short.", false), prose("p", "Yes", true)], true);
    await at(140);
    view.show([done(200), thought("t1", "Short.", false), prose("p", "Yes.")], false);
    // The prose drains and fades, then the last phase's hold: the closing line after.
    // (In steps: one act spanning it all would batch the renders the hold's timers chain through.)
    for (let i = 0; i < 5; i++) await at(400);
    phases.stop();
    const keys = phases.log.map((p) => p.key);
    expect(keys[0]).toBe("sending");
    expect(keys[keys.length - 1]).toBe("closed");
    for (let i = 0; i + 1 < phases.log.length; i++) {
      expect(phases.log[i + 1].at - phases.log[i].at, `${keys[i]} -> ${keys[i + 1]}`).toBeGreaterThanOrEqual(280);
    }
    // No word came back: each key paints once.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a long call with no output, then a burst: the line's chevron leaves with its words, the group's rows stay", async () => {
    const view = scene("s", [echoed(), read("a", "completed"), bash("b")], true);
    const words = view.line()!.querySelector('[data-morph-key^="call:"]');
    expect(words?.querySelector("svg")).not.toBeNull();
    await play(view, [
      ["the call settles, a burst of three", [echoed(), read("a", "completed"), bash("b", "completed"), read("c", "completed"), read("d", "completed"), edit("e")], true],
      ["more", [echoed(), read("a", "completed"), bash("b", "completed"), read("c", "completed"), read("d", "completed"), edit("e", "completed"), read("f")], true],
    ]);
  });

  it("thinking sentences every 100 ms, then every 2 s: one sentence at a time, the line kept", async () => {
    const view = scene("s", [echoed(), thought("t", "")], true);
    const line = view.line();
    let text = "";
    for (let i = 0; i < 8; i++) {
      text += `Sentence ${i}. `;
      view.show([echoed(), thought("t", text)], true);
      await settle(100);
      expect(view.line()).toBe(line);
    }
    await settle(400);
    expect(line!.querySelectorAll("[data-morph-key]")).toHaveLength(1);
    expect(line!.textContent).toBe("Sentence 7.");
    text += "And one long sentence that runs on and on past the edge of the column, so the row cuts it with an ellipsis rather than wrapping. ";
    view.show([echoed(), thought("t", text)], true);
    await settle(2_000);
    expect(line!.querySelectorAll("[data-morph-key]")).toHaveLength(1);
    expect(line!.querySelector('[data-slot="working-text"]')?.className).toContain("truncate");
  });

  it("a steer, a pause and resume, a compaction mid-turn, a Stop: each changes in place", async () => {
    const steered: Block = { id: "u:2", role: "user", text: "Use the other table", seq: 2, steerId: "st1", steer: { state: "sent", ts: T0 + 10 } } as Block;
    const compacting: Block = { id: "cmp", role: "system", text: "", compaction: { phase: "start", startedAt: T0 } } as Block;
    const compacted: Block = { id: "cmp", role: "system", text: "", compaction: { phase: "done", preTokens: 40_000, postTokens: 4_000, durationMs: 3_000 } } as Block;
    const stop: Block = { id: "err:1", role: "system", text: "Stopped", stopped: true };
    const view = scene("s", [echoed(), bash("a")], true);
    const line = view.line();
    await play(view, [
      ["steer sent", [echoed(), bash("a"), steered], true],
      ["steer received", [echoed(), bash("a"), { ...steered, steer: { state: "received", how: "in-turn", ts: T0 + 20 } } as Block], true],
      ["paused", [echoed(), bash("a"), steered], false, { status: "paused" }],
      ["resumed", [echoed(), bash("a"), steered], true],
      ["compaction starts", [echoed(), bash("a", "completed"), steered, compacting], true],
      ["compaction done", [echoed(), bash("a", "completed"), steered, compacted, read("b")], true],
      ["stopped", [echoed(), bash("a", "completed"), steered, compacted, read("b", "completed"), stop], true],
    ]);
    expect(view.line()).toBe(line);
    expect(view.container.querySelectorAll('[data-state="stopped"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-slot="notice-line"]').length).toBeGreaterThan(0);
  });

  it("a subagent spawned, waited on and finished, then the thread watching: rows and lines change in place", async () => {
    const child = { id: "c1", parentId: "s", provider: "claude", model: "claude-sonnet-5-5", title: "Review the perf pass", cwd: CWD, environmentId: "local", archived: false, status: "running", createdAt: 0 } as unknown as SessionMeta;
    const spawn = tool("sp", "mcp__orchestrator__spawn_agent", "other", { task: "Review it", title: "Review the perf pass" }, "completed");
    spawn.tool!.spawned = ["c1"];
    const wait = (status: string, detail?: string) => tool("w", "mcp__orchestrator__wait_for_agent", "other", { agentId: "c1" }, status, detail ? { tool: { callId: "w", name: "mcp__orchestrator__wait_for_agent", status, input: { agentId: "c1" }, detail } } : {});
    const view = scene("s", [echoed(), spawn], true);
    await play(view, [
      ["waiting", [echoed(), spawn, wait("running")], true],
      ["the child's title and state land", [echoed(), spawn, wait("running")], true],
    ]);
    await act(async () => {
      sessionStore.injectPush({ push: "session", session: child }, "local");
      await new Promise((r) => setTimeout(r, 50));
    });
    await play(view, [
      ["finished", [done(60_000), spawn, wait("completed", JSON.stringify({ agentId: "c1", status: "idle", reply: "Fine." })), prose("p", "It is fine.")], false],
      ["watching", [done(60_000), spawn, wait("completed", JSON.stringify({ agentId: "c1", status: "idle", reply: "Fine." })), prose("p", "It is fine.")], false, { status: "watching" }],
    ]);
  });

  it("scrolled up while it all streams: the reader's place never moves", async () => {
    // Long history above the live turn's end, the reader up in it.
    const history = Array.from({ length: 40 }, (_, i) => prose(`h${i}`, `Paragraph ${i} of the history, long enough to fill a line or two of the column.`));
    const view = scene("s", [echoed(), ...history, prose("p0", "First.")], true);
    const scroller = view.scroller();
    let top = 120;
    const writes: number[] = [];
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { writes.push(v); top = v; } });
    // A transcript taller than its viewport, so 120px down is far from the bottom.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 4_000 });
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      scroller.dispatchEvent(new Event("scroll"));
    });
    writes.length = 0;
    await play(view, [
      ["streams", [echoed(), ...history, prose("p0", "First."), read("a"), prose("p1", "More text", true)], true],
      ["calls", [echoed(), ...history, prose("p0", "First."), read("a", "completed"), prose("p1", "More text."), bash("b"), bash("c")], true],
      ["settles", [done(5_000), ...history, prose("p0", "First."), read("a", "completed"), prose("p1", "More text."), bash("b", "completed"), bash("c", "completed")], false],
    ]);
    expect(writes).toEqual([]);
    expect(top).toBe(120);
  });

  it("a resync replaying the same rows, and the pane remounted: no settled row animates again", async () => {
    const blocks = [done(9_000), read("a", "completed"), bash("b", "completed"), prose("p", "Done.")];
    const view = scene("s", blocks, false);
    // The same rows again as new objects: a resync's replay.
    await play(view, [["resync", blocks.map((b) => ({ ...b }) as Block), false]]);
    expect(view.container.querySelector(".z-fade-in, .step-land, .stream-step, .glyph-in, .table-frame-in")).toBeNull();
    view.unmount();
    const again = scene("s", blocks, false);
    expect(again.container.querySelector(".z-fade-in, .step-land, .stream-step, .glyph-in, .table-frame-in")).toBeNull();
  });

  it("reduced motion: the closing line settles with no slide, and nothing glides", async () => {
    motion.reduce = true;
    const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ cancel() {}, finished: Promise.resolve(), onfinish: null }) as unknown as Animation);
    const view = scene("s", [echoed(), read("a")], true);
    await play(view, [
      ["group", [echoed(), read("a", "completed"), bash("b")], true],
      ["settled", [done(3_000), read("a", "completed"), bash("b", "completed"), prose("p", "Done.")], false],
    ]);
    await settleUntil(() => !!view.line()?.textContent?.includes("Worked"));
    const moved = animate.mock.calls.filter(([frames]) => JSON.stringify(frames).includes("translate"));
    expect(moved).toEqual([]);
    expect(view.line()?.textContent).toBe("Worked for 3s");
  });

  it("a burst lands whole and the turn ends 30 ms later: the mark stays until the text is all shown, then the closing line", async () => {
    const burst = "The index goes on the owner and the updated time. ".repeat(12);
    const view = scene("s", [echoed()], true);
    const line = view.line();
    view.show([echoed(), prose("p", burst, true)], true);
    await settle(30);
    view.show([done(4_000), prose("p", burst)], false);
    // The text is still being shown: no closing line above it yet.
    await settle(30);
    expect(view.line()).toBe(line);
    expect(view.line()?.querySelector('[data-slot="working-mark"]')).not.toBeNull();
    expect(view.line()?.textContent).not.toMatch(/Worked/);
    // Once every step has painted and the last fade is done, the line morphs. The drain takes about 2 s on an idle
    // machine, so wait on the mark leaving rather than a fixed time: under the gate's parallel lanes it runs longer.
    await settleUntil(() => !view.line()?.querySelector('[data-slot="working-mark"]'), 10_000);
    expect(view.line()).toBe(line);
    expect(view.line()?.querySelector('[data-slot="working-mark"]')).toBeNull();
    expect(view.line()?.textContent).toBe("Worked for 4s");
  });
});

// The question card's own steps: it arrives, Next moves between its questions, the answer folds it.
describe("no jerk in any scenario: the question card", () => {
  const questions = [
    { question: "Which table gets the index?", header: "Index", options: [{ label: "inbox" }, { label: "threads" }] },
    { question: "Backfill the old rows?", options: [{ label: "Yes", description: "One pass at deploy" }, { label: "No" }] },
  ];
  const ask = (answers?: string[][] | null): Block =>
    tool("ask", "AskUserQuestion", "other", { questions }, answers === undefined ? "running" : "completed", {
      question: { sessionId: "s", requestId: "ask-1", questions, answers },
    });
  const click = (view: Scene, name: RegExp | string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? ""),
    )!;
    act(() => button.click());
  };

  it("arrives, pages and folds into its answered lines in place: the row and the card keep their elements", async () => {
    const view = scene("s", [echoed(), read("a", "completed")], true);
    const rules = watch(view);
    view.show([echoed(), read("a", "completed"), ask()], true);
    rules.check("the question arrives");
    const card = view.container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    // It enters as a row does, once: a fade and a 4px rise.
    expect(card.className).toContain("starting:translate-y-1");
    const row = card.closest<HTMLElement>("[data-row]")!;
    await settle();
    rules.check("the question arrived");
    click(view, /inbox$/);
    click(view, /^Next/);
    await settle();
    rules.check("Next");
    rules.settled("Next");
    expect(view.container.querySelector('[data-slot="question-card"]')).toBe(card);
    expect(card.querySelector('[data-slot="question-progress"]')!.textContent).toBe("2 of 2");
    // The host takes the answer: the card folds on .collapsible-auto, the lines open in its place.
    view.show([echoed(), read("a", "completed"), ask([["inbox"], ["Yes"]])], true);
    await settle();
    rules.check("answered");
    expect(view.rows().get(row.dataset.row!)).toBe(row);
    const lines = [...row.querySelectorAll('[data-slot="notice-line"]')].map((l) => l.textContent);
    expect(lines).toEqual(["AnsweredIndexinbox", "AnsweredBackfill the old rows?Yes"]);
    expect(row.querySelector('[data-slot="notice-line"]')!.closest('[data-slot="collapsible-content"]')!.className).toContain("collapsible-auto");
  });

  it("scrolled up while a question arrives, pages and is answered: the reader's place never moves", async () => {
    // Enough history that the reader is far from the bottom, little enough that the card's row is mounted below them.
    const history = Array.from({ length: 6 }, (_, i) => prose(`h${i}`, `Paragraph ${i} of the history, long enough to fill a line or two of the column.`));
    const view = scene("s", [echoed(), ...history, read("a", "completed")], true);
    const scroller = view.scroller();
    let top = 120;
    const writes: number[] = [];
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { writes.push(v); top = v; } });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 4_000 });
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      scroller.dispatchEvent(new Event("scroll"));
    });
    writes.length = 0;
    const rules = watch(view);
    view.show([echoed(), ...history, read("a", "completed"), ask()], true);
    await settle();
    rules.check("the question arrives");
    // Next changes the card's height: the card sits below the reader's anchor, so nothing above it moves.
    click(view, /inbox$/);
    click(view, /^Next/);
    await settle();
    rules.check("Next");
    view.show([echoed(), ...history, read("a", "completed"), ask([["inbox"], ["No"]])], true);
    await settle();
    rules.check("answered");
    expect(writes).toEqual([]);
    expect(top).toBe(120);
  });
});
