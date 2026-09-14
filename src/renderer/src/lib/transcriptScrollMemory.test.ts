import { describe, expect, it } from "vitest";
import {
  peekTranscriptScroll,
  saveTranscriptScroll,
  takeTranscriptScroll,
} from "./transcriptScrollMemory";

describe("transcript scroll memory", () => {
  it("round-trips a reader's place per session and clears it for a follower", () => {
    saveTranscriptScroll("s1", { fromBottom: 420, rowCount: 60 });
    expect(peekTranscriptScroll("s1")).toEqual({ fromBottom: 420, rowCount: 60 });
    expect(takeTranscriptScroll("s1")).toEqual({ fromBottom: 420, rowCount: 60 });
    expect(takeTranscriptScroll("s1")).toBeUndefined();
    saveTranscriptScroll("s2", { fromBottom: 1, rowCount: 20 });
    saveTranscriptScroll("s2", null);
    expect(peekTranscriptScroll("s2")).toBeUndefined();
    saveTranscriptScroll("", { fromBottom: 1, rowCount: 20 });
    expect(peekTranscriptScroll("")).toBeUndefined();
  });
});
