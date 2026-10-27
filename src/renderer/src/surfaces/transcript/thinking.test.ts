import { describe, expect, it } from "vitest";
import { latestLine, thoughtLabel, thoughtMs } from "./thinking";

describe("thoughtLabel", () => {
  it("reads the span, never under a second", () => {
    expect(thoughtLabel(400)).toBe("Thought for 1s");
    expect(thoughtLabel(4_000)).toBe("Thought for 4s");
    expect(thoughtLabel(72_000)).toBe("Thought for 1m 12s");
    expect(thoughtLabel(120_000)).toBe("Thought for 2m");
    expect(thoughtLabel()).toBe("Thought");
  });
});

describe("thoughtMs", () => {
  it("runs from the block to the end it is given", () => {
    expect(thoughtMs({ ts: 1_000 }, 5_000)).toBe(4_000);
    expect(thoughtMs({ ts: 1_000 })).toBeUndefined();
    expect(thoughtMs({}, 5_000)).toBeUndefined();
  });
});

describe("latestLine", () => {
  it("is the newest finished sentence, leaving a partial one out", () => {
    expect(latestLine("First I read the file. Then I check the tests. Now the")).toBe("Then I check the tests.");
    expect(latestLine("First I read the file. Then I check the tests.")).toBe("Then I check the tests.");
  });

  it("takes a partial sentence when it is all there is", () => {
    expect(latestLine("Looking at the")).toBe("Looking at the");
  });

  it("drops code fences, open or closed, and markdown markers", () => {
    expect(latestLine("Check **this** file.\n```ts\nconst a = 1;\n```")).toBe("Check this file.");
    expect(latestLine("Read `a.ts` first.\n```ts\nconst a")).toBe("Read a.ts first.");
    expect(latestLine("- Look at [the docs](https://x.dev).")).toBe("Look at the docs.");
  });

  it("is empty for an empty thought and cut at 160 characters", () => {
    expect(latestLine("")).toBe("");
    expect(latestLine("   \n\n")).toBe("");
    const long = latestLine(`${"word ".repeat(60)}end.`);
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });
});
