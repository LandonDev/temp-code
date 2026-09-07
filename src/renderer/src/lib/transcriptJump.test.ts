import { describe, expect, it } from "vitest";
import { foldAll } from "./tcserver/fold";
import type { AgentEvent, EventRow } from "./tcserver/types";
import {
  blockForSeq,
  pendingTranscriptJump,
  requestTranscriptJump,
  takeTranscriptJump,
} from "./transcriptJump";

const rows = (events: AgentEvent[]): EventRow[] =>
  events.map((event, i) => ({ sessionId: "s", seq: i + 1, ts: 1_000 + i, event }));

describe("blockForSeq", () => {
  it("maps a server hit's row to the block that row belongs to", () => {
    const state = foldAll(
      rows([
        { type: "user-text", text: "find the zebra" }, // seq 1
        { type: "assistant-text", text: "Looking", delta: true }, // seq 2
        { type: "assistant-text", text: "Looking at the zebra.", delta: false }, // seq 3
        { type: "tool-call", callId: "c1", name: "Bash", input: {} }, // seq 4
        { type: "tool-result", callId: "c1", output: "" }, // seq 5
        { type: "user-text", text: "thanks" }, // seq 6
      ]),
      "/repo",
    );
    const user = blockForSeq(state.blocks, 1);
    expect(user?.role).toBe("user");
    expect(user?.id).toBe("u:1");
    // Deltas open the assistant block at seq 2; its final row (3) lands there,
    // and so do the tool rows that follow it (4, 5) — no prose of their own.
    const assistant = blockForSeq(state.blocks, 3);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.seq).toBe(2);
    expect(assistant?.text).toBe("Looking at the zebra.");
    expect(blockForSeq(state.blocks, 5)?.seq).toBe(2);
    expect(blockForSeq(state.blocks, 6)?.id).toBe("u:6");
    expect(blockForSeq(state.blocks, 0)).toBeNull();
  });
});

describe("transcript jump requests", () => {
  it("waits for the named session and is consumed once", () => {
    requestTranscriptJump("a", 7);
    expect(pendingTranscriptJump("b")).toBeNull();
    expect(pendingTranscriptJump("a")).toEqual({ sessionId: "a", seq: 7 });
    expect(takeTranscriptJump("a")).toEqual({ sessionId: "a", seq: 7 });
    expect(takeTranscriptJump("a")).toBeNull();
  });
});
