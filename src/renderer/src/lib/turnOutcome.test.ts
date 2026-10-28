import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { emptyThread } from "./tcserver/todos";
import { fallbackFailure } from "@server/shared/failureFallback";
import { errorRowOf, isErrorBlock, lastErrorBlock, type OutcomeSession } from "./turnOutcome";

const err = (n: number, text = "boom", stopped?: boolean): Block => ({
  id: `err:${n}`,
  role: "system",
  text,
  ...(stopped ? { stopped } : {}),
});
const note = (n: number): Block => ({ id: `s:${n}`, role: "system", text: "Context compacted" });

function session(blocks: Block[], extra: Partial<OutcomeSession> = {}): OutcomeSession {
  return { blocks, status: "error", thread: emptyThread(), ...extra };
}

describe("isErrorBlock", () => {
  it("is the fold's err: system row and nothing else", () => {
    expect(isErrorBlock(err(1))).toBe(true);
    expect(isErrorBlock(note(1))).toBe(false);
    expect(lastErrorBlock([err(1), note(2), err(3), note(4)])?.id).toBe("err:3");
  });
});

describe("errorRowOf", () => {
  it("renders a stop as Stopped with no verdict", () => {
    const s = session([err(1, "Stopped", true)]);
    expect(errorRowOf(s, s.blocks[0])).toEqual({ stopped: true, message: "Stopped", failure: null });
  });

  it("reads the thread flag for the trailing error when the row is unstamped", () => {
    const s = session([err(1), err(2, "Stopped")], { thread: { ...emptyThread(), stopped: true } });
    expect(errorRowOf(s, s.blocks[1]).stopped).toBe(true);
    expect(errorRowOf(s, s.blocks[0]).stopped).toBe(false);
  });

  it("gives a failure with no verdict the shared fallback", () => {
    const s = session([err(1, "turn ended: error_during_execution")]);
    expect(errorRowOf(s, s.blocks[0])).toEqual({
      stopped: false,
      message: "turn ended: error_during_execution",
      failure: fallbackFailure(),
    });
  });

  it("keeps the host's verdict when the row carries one", () => {
    const failure = { kind: "network" as const, account: null, summary: "Could not reach Anthropic", cause: "The connection dropped." };
    const s = session([{ ...err(1), failure }]);
    expect(errorRowOf(s, s.blocks[0]).failure).toEqual(failure);
  });
});
