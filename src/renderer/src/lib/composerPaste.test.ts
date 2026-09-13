import { describe, expect, it } from "vitest";
import { PASTE_ATTACH_THRESHOLD, pastePlan } from "./composerPaste";

describe("pastePlan", () => {
  it("keeps short text inline with newlines normalized", () => {
    expect(pastePlan("a\r\nb\rc")).toEqual({ inline: "a\nb\nc" });
  });

  it("keeps text at the threshold inline", () => {
    const text = "x".repeat(PASTE_ATTACH_THRESHOLD);
    expect(pastePlan(text)).toEqual({ inline: text });
  });

  it("turns text over the threshold into a plain-text file", async () => {
    const text = "line\n".repeat(3000);
    const plan = pastePlan(text);
    if (!("attach" in plan)) throw new Error("expected an attachment");
    expect(plan.attach.type).toBe("text/plain");
    expect(plan.attach.name).toBe("pasted-3001-lines.txt");
    expect(await plan.attach.text()).toBe(text);
  });

  it("honours a custom threshold", () => {
    expect("attach" in pastePlan("abcdef", 5)).toBe(true);
  });
});
