import { describe, expect, it } from "vitest";
import { tabStripOverflow } from "./TitleBar";

describe("tabStripOverflow", () => {
  it("hides both chevrons when the strip fits", () => {
    expect(tabStripOverflow(0, 400, 400)).toEqual({ left: false, right: false });
  });

  it("shows only the right chevron at the start", () => {
    expect(tabStripOverflow(0, 400, 800)).toEqual({ left: false, right: true });
  });

  it("shows both chevrons in the middle", () => {
    expect(tabStripOverflow(200, 400, 800)).toEqual({ left: true, right: true });
  });

  it("shows only the left chevron at the end", () => {
    expect(tabStripOverflow(400, 400, 800)).toEqual({ left: true, right: false });
  });
});


