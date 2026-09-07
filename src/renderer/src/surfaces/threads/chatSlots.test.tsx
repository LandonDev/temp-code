import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { ChatColumn, chatOf, slotsOf, type ChatSlots } from "./chatSlots";

const slots: ChatSlots = { transcript: "T", strip: "S", composer: "C" };

describe("chatOf", () => {
  it("falls back to the whole column when the pane has not split it", () => {
    const out = chatOf({ renderChat: () => "column" });
    expect(out).toBe("column");
  });

  it("assembles the slots into the column once they exist", () => {
    let seen: unknown;
    const out = chatOf({ renderChat: () => "x", renderSlots: (o) => ((seen = o), slots) }, { topSlot: "top" });
    expect(seen).toEqual({ topSlot: "top" });
    expect(isValidElement(out) && out.type).toBe(ChatColumn);
  });
});

describe("slotsOf", () => {
  it("hands back the parts, or the column as the transcript with nothing else", () => {
    expect(slotsOf({ renderChat: () => "x", renderSlots: () => slots })).toBe(slots);
    expect(slotsOf({ renderChat: () => "column" })).toEqual({ transcript: "column", strip: null, composer: null });
  });
});
