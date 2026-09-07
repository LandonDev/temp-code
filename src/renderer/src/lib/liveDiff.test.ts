import { describe, expect, it } from "vitest";
import { liveDiffLines } from "./liveDiff";

describe("liveDiffLines", () => {
  it("turns a unified diff into numbered preview rows", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,3 @@", " a", "-b", "+B", "+c", ""].join("\n");
    expect(liveDiffLines(diff, false)).toEqual([
      { number: 1, kind: "context", text: "a" },
      { number: 2, kind: "del", text: "b" },
      { number: 2, kind: "add", text: "B" },
      { number: 3, kind: "add", text: "c" },
    ]);
  });

  it("shows a created file as all additions", () => {
    expect(liveDiffLines("one\ntwo\n", true)).toEqual([
      { number: 1, kind: "add", text: "one" },
      { number: 2, kind: "add", text: "two" },
    ]);
    expect(liveDiffLines("", true)).toEqual([]);
  });
});
