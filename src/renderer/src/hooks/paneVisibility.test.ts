import { describe, expect, it } from "vitest";
import { frameLoopAllowed } from "./paneVisibility";

describe("frameLoopAllowed", () => {
  it("runs only for a shown pane in a visible document", () => {
    expect(frameLoopAllowed(true, false)).toBe(true);
  });

  it("stops for a parked pane even while the document is visible", () => {
    expect(frameLoopAllowed(false, false)).toBe(false);
  });

  it("stops when the document is hidden, whatever the pane says", () => {
    expect(frameLoopAllowed(true, true)).toBe(false);
    expect(frameLoopAllowed(false, true)).toBe(false);
  });
});
