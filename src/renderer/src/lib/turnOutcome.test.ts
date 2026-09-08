import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { emptyThread } from "./tcserver/todos";
import { errorRowOf, isErrorBlock, lastErrorBlock, type OutcomeSession } from "./turnOutcome";

const err = (n: number, text = "boom", stopped?: boolean): Block => ({
  id: `err:${n}`,
  role: "system",
  text,
  ...(stopped ? { stopped } : {}),
});
const note = (n: number): Block => ({ id: `s:${n}`, role: "system", text: "Context compacted" });

function session(blocks: Block[], extra: Partial<OutcomeSession> = {}): OutcomeSession {
  return { blocks, status: "error", treeCanContinue: true, thread: emptyThread(), ...extra };
}

describe("isErrorBlock", () => {
  it("is the fold's err: system row and nothing else", () => {
    expect(isErrorBlock(err(1))).toBe(true);
    expect(isErrorBlock(note(1))).toBe(false);
    expect(lastErrorBlock([err(1), note(2), err(3), note(4)])?.id).toBe("err:3");
  });
});

describe("errorRowOf", () => {
  it("renders a stop as Stopped without Continue", () => {
    const s = session([err(1, "Stopped", true)]);
    expect(errorRowOf(s, s.blocks[0])).toEqual({ stopped: true, message: "Stopped", showContinue: false });
  });

  it("reads the thread flag for the trailing error when the row is unstamped", () => {
    const s = session([err(1), err(2, "Stopped")], { thread: { ...emptyThread(), stopped: true } });
    expect(errorRowOf(s, s.blocks[1]).stopped).toBe(true);
    expect(errorRowOf(s, s.blocks[0]).stopped).toBe(false);
  });

  it("offers Continue on the last error only, when the tree can continue", () => {
    const s = session([err(1), err(2)]);
    expect(errorRowOf(s, s.blocks[0]).showContinue).toBe(false);
    expect(errorRowOf(s, s.blocks[1])).toEqual({ stopped: false, message: "boom", showContinue: true });
  });

  it("holds Continue back while paused or when the server says no", () => {
    const paused = session([err(1)], { status: "paused" });
    expect(errorRowOf(paused, paused.blocks[0]).showContinue).toBe(false);
    const closed = session([err(1)], { treeCanContinue: false });
    expect(errorRowOf(closed, closed.blocks[0]).showContinue).toBe(false);
  });
});
