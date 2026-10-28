import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { emptyThread } from "./tcserver/todos";
import { fallbackFailure } from "@server/shared/failureFallback";
import { errorRowOf, isErrorBlock, lastErrorBlock, stopClosesTurn, turnEndsStopped, type OutcomeSession } from "./turnOutcome";

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
      canRetry: true,
    });
  });

  it("offers Retry on the last error only, when the tree can continue and nothing is paused", () => {
    const s = session([err(1), err(2)]);
    expect(errorRowOf(s, s.blocks[0])).toMatchObject({ canRetry: false });
    expect(errorRowOf(s, s.blocks[1])).toMatchObject({ canRetry: true });
    const closed = session([err(1)], { treeCanContinue: false });
    expect(errorRowOf(closed, closed.blocks[0])).toMatchObject({ canRetry: false });
    const paused = session([err(1)], { status: "paused" });
    expect(errorRowOf(paused, paused.blocks[0])).toMatchObject({ canRetry: false });
  });

  it("keeps the host's verdict when the row carries one", () => {
    const failure = { kind: "network" as const, account: null, summary: "Could not reach Anthropic", cause: "The connection dropped." };
    const s = session([{ ...err(1), failure }]);
    expect(errorRowOf(s, s.blocks[0]).failure).toEqual(failure);
  });
});

describe("turnEndsStopped", () => {
  const user = (n: number): Block => ({ id: `u:${n}`, role: "user", text: "go" });
  const reply = (n: number): Block => ({ id: `a:${n}`, role: "assistant", text: "ok" });

  it("is true when the turn's last error is a stop and only notices follow it", () => {
    const blocks = [user(1), reply(1), err(1, "Stopped", true), note(2)];
    expect(turnEndsStopped(session(blocks), blocks)).toBe(true);
  });

  it("is false for a failure, a completed turn, or a stop the turn ran on past", () => {
    const failed = [user(1), err(1)];
    expect(turnEndsStopped(session(failed), failed)).toBe(false);
    const done = [user(1), reply(1)];
    expect(turnEndsStopped(session(done), done)).toBe(false);
    const resumed = [user(1), err(1, "Stopped", true), reply(2)];
    expect(turnEndsStopped(session(resumed), resumed)).toBe(false);
  });
});

describe("stopClosesTurn", () => {
  const user = (n: number): Block => ({ id: `u:${n}`, role: "user", text: "go" });

  it("hides the row of a settled turn that ends on it, the last turn or an earlier one", () => {
    const blocks = [user(1), err(1, "Stopped", true), user(2), err(2, "Stopped", true)];
    const s = { ...session(blocks), status: "idle" as const };
    expect(stopClosesTurn(s, blocks[1])).toBe(true);
    expect(stopClosesTurn(s, blocks[3])).toBe(true);
  });

  it("keeps the row while its turn is open, and for a failure", () => {
    const blocks = [user(1), err(1, "Stopped", true)];
    expect(stopClosesTurn({ ...session(blocks), status: "running", busy: true }, blocks[1])).toBe(false);
    expect(stopClosesTurn({ ...session(blocks), status: "paused" }, blocks[1])).toBe(false);
    const failed = [user(1), err(1)];
    expect(stopClosesTurn(session(failed), failed[1])).toBe(false);
  });
});
