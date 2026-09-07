import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { QuestionPageSlide, slideQuestionPage } from "./questionPage";

describe("slideQuestionPage", () => {
  it("keys the slide by step so each step remounts", () => {
    const a = slideQuestionPage("one", 0);
    const b = slideQuestionPage("two", 1);
    expect(isValidElement(a) && a.type).toBe(QuestionPageSlide);
    expect(isValidElement(a) && a.key).toBe("0");
    expect(isValidElement(b) && b.key).toBe("1");
    expect(isValidElement(b) && (b.props as { children: unknown }).children).toBe("two");
  });
});
