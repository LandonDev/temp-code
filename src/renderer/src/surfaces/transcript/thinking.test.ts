import { describe, expect, it } from "vitest";
import { spanWords, thoughtHasWords, thoughtLines } from "./thinking";

describe("spanWords", () => {
  it("is never shorter than a second, and counts minutes past one", () => {
    expect(spanWords(400)).toBe("1s");
    expect(spanWords(4_000)).toBe("4s");
    expect(spanWords(72_000)).toBe("1m 12s");
    expect(spanWords(120_000)).toBe("2m");
  });
});

describe("thoughtLines", () => {
  it("is every finished sentence, by paragraph, leaving the one being written out", () => {
    expect(thoughtLines("First I read the file. Then I check the tests. Now the")).toEqual([["First I read the file.", "Then I check the tests."]]);
    expect(thoughtLines("First I read the file. Then I check the tests.")).toEqual([["First I read the file.", "Then I check the tests."]]);
    expect(thoughtLines("One paragraph.\n\nA second one. Still going")).toEqual([["One paragraph."], ["A second one."]]);
  });

  it("gives nothing while the only sentence is unfinished, and drops an empty last paragraph", () => {
    expect(thoughtLines("Looking at the")).toEqual([]);
    expect(thoughtLines("Done.\n\nLooking at the")).toEqual([["Done."]]);
    expect(thoughtLines("")).toEqual([]);
    expect(thoughtLines("   \n\n")).toEqual([]);
  });

  it("drops code fences, open or closed, and markdown markers", () => {
    expect(thoughtLines("Check **this** file.\n```ts\nconst a = 1;\n```")).toEqual([["Check this file."]]);
    expect(thoughtLines("Read `a.ts` first.\n```ts\nconst a")).toEqual([["Read a.ts first."]]);
    expect(thoughtLines("- Look at [the docs](https://x.dev).")).toEqual([["Look at the docs."]]);
  });

  it("keeps a colon as a sentence's end, as a list's lead-in ends", () => {
    expect(thoughtLines("Two things:\n- one.\n- two")).toEqual([["Two things:"], ["one."]]);
  });
});

describe("thoughtHasWords", () => {
  it("is true from the first word, finished or not, and false for markers alone", () => {
    expect(thoughtHasWords("")).toBe(false);
    expect(thoughtHasWords("  \n")).toBe(false);
    expect(thoughtHasWords("```ts\n")).toBe(false);
    expect(thoughtHasWords("Looking")).toBe(true);
    expect(thoughtHasWords("Looking at the file.")).toBe(true);
  });
});
