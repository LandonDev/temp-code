import { describe, expect, it } from "vitest";
import type { ResearchSource } from "../tcserver/todos";
import { EMPTY_BOARD, foldResearchBoard, hostOf, mergeAngles } from "./researchBoard";

const row = (p: Partial<ResearchSource> & { callId: string }): ResearchSource => ({
  agentId: "a1",
  agentLabel: "Angle one",
  ts: 0,
  ...p,
});

describe("foldResearchBoard", () => {
  it("returns the shared empty board for no rows", () => {
    expect(foldResearchBoard([])).toBe(EMPTY_BOARD);
  });

  it("groups queries per agent with sources under the latest query", () => {
    const board = foldResearchBoard([
      row({ callId: "q1", query: "react 19" }),
      row({ callId: "s1", url: "https://react.dev/blog", title: "React blog" }),
      row({ callId: "q2", query: "react compiler" }),
      row({ callId: "s2", url: "https://react.dev/compiler" }),
      row({ callId: "s3", url: "https://www.example.com", agentId: "a2", agentLabel: "Angle two" }),
    ]);
    expect(board.angles.map((a) => [a.agentId, a.label])).toEqual([
      ["a1", "Angle one"],
      ["a2", "Angle two"],
    ]);
    expect(board.angles[0].queries).toEqual([
      { query: "react 19", sources: [{ callId: "s1", url: "https://react.dev/blog", title: "React blog", claim: undefined }] },
      { query: "react compiler", sources: [{ callId: "s2", url: "https://react.dev/compiler", title: undefined, claim: undefined }] },
    ]);
    expect(board.angles[1].queries).toEqual([
      { query: null, sources: [{ callId: "s3", url: "https://www.example.com", title: undefined, claim: undefined }] },
    ]);
    expect(board.sources).toBe(3);
    expect(board.searches).toBe(2);
  });

  it("lets a repeat callId enrich the earlier row and counts unique urls and queries once", () => {
    const board = foldResearchBoard([
      row({ callId: "q1", query: "same" }),
      row({ callId: "s1", url: "https://a.dev" }),
      row({ callId: "s1", url: "https://a.dev", title: "A" }),
      row({ callId: "q1b", query: "same", agentId: "a2", agentLabel: "Two" }),
      row({ callId: "s2", url: "https://a.dev", agentId: "a2", agentLabel: "Two" }),
    ]);
    expect(board.angles[0].queries[0].sources).toMatchObject([{ url: "https://a.dev", title: "A" }]);
    expect(board.angles[1].queries[0].sources).toHaveLength(1);
    expect(board.sources).toBe(1);
    expect(board.searches).toBe(1);
  });
});

describe("citations on the board", () => {
  it("a cited fetch stays one row with its claim; a further claim is its own row; totals count urls once", () => {
    const board = foldResearchBoard([
      row({ callId: "q1", query: "a pricing" }),
      row({ callId: "s1", url: "https://a.dev/x" }),
      row({ callId: "s1", url: "https://a.dev/x", title: "A pricing", claim: "A charges $42 a seat" }),
      row({ callId: "cite:1", url: "https://a.dev/x", claim: "A has a free tier" }),
      row({ callId: "cite:2", url: "https://b.org", claim: "B has none" }),
    ]);
    expect(board.angles[0].queries[0].sources).toEqual([
      { callId: "s1", url: "https://a.dev/x", title: "A pricing", claim: "A charges $42 a seat" },
      { callId: "cite:1", url: "https://a.dev/x", title: undefined, claim: "A has a free tier" },
      { callId: "cite:2", url: "https://b.org", title: undefined, claim: "B has none" },
    ]);
    expect(board.sources).toBe(2);
    expect(board.searches).toBe(1);
  });
});

describe("hostOf", () => {
  it("strips www and survives bad urls", () => {
    expect(hostOf("https://www.react.dev/x")).toBe("react.dev");
    expect(hostOf("not a url")).toBe("");
  });
});

describe("mergeAngles", () => {
  it("lists every spawned child in spawn order, boarded or not, after the root's own group", () => {
    const board = foldResearchBoard([
      row({ callId: "r1", query: "overview", agentId: "root", agentLabel: "Research" }),
      row({ callId: "b1", url: "https://b.dev", agentId: "b", agentLabel: "Angle B" }),
    ]);
    const angles = mergeAngles(board, ["a", "b", "c"]);
    expect(angles.map((a) => a.agentId)).toEqual(["root", "a", "b", "c"]);
    expect(angles[1]).toEqual({ agentId: "a", label: "", queries: [] });
    expect(angles[2].queries[0].sources).toMatchObject([{ url: "https://b.dev" }]);
  });

  it("is the board's own angles when nothing was spawned", () => {
    const board = foldResearchBoard([row({ callId: "s1", url: "https://a.dev" })]);
    expect(mergeAngles(board, [])).toBe(board.angles);
  });
});
