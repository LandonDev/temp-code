import { describe, expect, it } from "vitest";
import {
  threadIdFromHref,
  threadMentionParts,
  threadMentionsInText,
  threadMentionsToLinks,
  threadMentionsToTitles,
  threadRefsInText,
  threadToken,
} from "./threadMentions";

const BOX = `env_${"b".repeat(22)}`;
const MAC = `env_${"m".repeat(22)}`;

const titles: Record<string, string> = { abcdef123456: "Auth rewrite", "x-y_z12345": "Billing" };
const titleOf = (id: string) => titles[id];

describe("threadMentionsInText", () => {
  it("lists unique ids in order and ignores short ones", () => {
    expect(
      threadMentionsInText("see @thread:abcdef123456 and @thread:x-y_z12345, again @thread:abcdef123456 @thread:ab"),
    ).toEqual(["abcdef123456", "x-y_z12345"]);
  });
});

describe("tokens naming a host", () => {
  it("reads `@thread:<host>:<id>` as the session with its host, the bare form without one", () => {
    expect(threadRefsInText(`a @thread:${BOX}:abcdef123456 b @thread:abcdef123456 c @thread:${BOX}:abcdef123456`)).toEqual([
      { sessionId: "abcdef123456", hostId: BOX },
      { sessionId: "abcdef123456" },
    ]);
    expect(threadMentionsInText(`@thread:${BOX}:abcdef123456 @thread:abcdef123456`)).toEqual(["abcdef123456"]);
  });

  it("chips, links and titles use the bare id the store knows", () => {
    expect(threadMentionParts(`see @thread:${BOX}:abcdef123456.`, titleOf)).toEqual([
      { text: "see " },
      { id: "abcdef123456", title: "Auth rewrite" },
      { text: "." },
    ]);
    expect(threadMentionsToLinks(`@thread:${BOX}:abcdef123456`, titleOf)).toBe("[@Auth rewrite](#thread:abcdef123456)");
    expect(threadMentionsToTitles(`@thread:${BOX}:x-y_z12345`, titleOf)).toBe("@Billing");
  });

  it("the picker names the host only for a thread on another host than the draft's", () => {
    expect(threadToken("abcdef123456", BOX, MAC)).toBe(`@thread:${BOX}:abcdef123456`);
    expect(threadToken("abcdef123456", BOX, BOX)).toBe("@thread:abcdef123456");
    // A slot whose hello has not come yet (`local`) is never written into a token.
    expect(threadToken("abcdef123456", "local", BOX)).toBe("@thread:abcdef123456");
    expect(threadToken("abcdef123456", undefined, MAC)).toBe("@thread:abcdef123456");
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
