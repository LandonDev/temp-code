import { describe, expect, it } from "vitest";
import {
  peekTranscriptScroll,
  saveTranscriptScroll,
  takeTranscriptScroll,
} from "./transcriptScrollMemory";

describe("transcript scroll memory", () => {
  it("round-trips a reader's place per session and clears it for a follower", () => {
    saveTranscriptScroll("s1", { anchor: { key: "a0", offset: 12 } });
    expect(peekTranscriptScroll("s1")).toEqual({ anchor: { key: "a0", offset: 12 } });
    expect(takeTranscriptScroll("s1")).toEqual({ anchor: { key: "a0", offset: 12 } });
    expect(takeTranscriptScroll("s1")).toBeUndefined();
    saveTranscriptScroll("s2", { anchor: { key: "b0", offset: 0 } });
    saveTranscriptScroll("s2", null);
    expect(peekTranscriptScroll("s2")).toBeUndefined();
    saveTranscriptScroll("", { anchor: { key: "b0", offset: 0 } });
    expect(peekTranscriptScroll("")).toBeUndefined();
  });
});
