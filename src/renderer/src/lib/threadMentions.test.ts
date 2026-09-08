import { describe, expect, it } from "vitest";
import {
  threadIdFromHref,
  threadMentionParts,
  threadMentionsInText,
  threadMentionsToLinks,
  threadMentionsToTitles,
} from "./threadMentions";

const titles: Record<string, string> = { abcdef123456: "Auth rewrite", "x-y_z12345": "Billing" };
const titleOf = (id: string) => titles[id];

describe("threadMentionsInText", () => {
  it("lists unique ids in order and ignores short ones", () => {
    expect(
      threadMentionsInText("see @thread:abcdef123456 and @thread:x-y_z12345, again @thread:abcdef123456 @thread:ab"),
    ).toEqual(["abcdef123456", "x-y_z12345"]);
  });
});

describe("threadMentionParts", () => {
  it("splits known tokens into chips and leaves unknown ones as text", () => {
    expect(threadMentionParts("see @thread:abcdef123456 or @thread:unknown999", titleOf)).toEqual([
      { text: "see " },
      { id: "abcdef123456", title: "Auth rewrite" },
      { text: " or @thread:unknown999" },
    ]);
    expect(threadMentionParts("plain", titleOf)).toEqual([{ text: "plain" }]);
    expect(threadMentionParts("@thread:abcdef123456", titleOf)).toEqual([
      { id: "abcdef123456", title: "Auth rewrite" },
    ]);
  });
});

describe("rewrites", () => {
  it("turns known tokens into markdown links", () => {
    expect(threadMentionsToLinks("cf @thread:abcdef123456 @thread:nope000", titleOf)).toBe(
      "cf [@Auth rewrite](#thread:abcdef123456) @thread:nope000",
    );
  });

  it("turns known tokens into @title for copies", () => {
    expect(threadMentionsToTitles("cf @thread:x-y_z12345.", titleOf)).toBe("cf @Billing.");
  });
});

describe("threadIdFromHref", () => {
  it("reads only our thread hrefs", () => {
    expect(threadIdFromHref("#thread:abcdef123456")).toBe("abcdef123456");
    expect(threadIdFromHref("#top")).toBeUndefined();
    expect(threadIdFromHref(undefined)).toBeUndefined();
  });
});
