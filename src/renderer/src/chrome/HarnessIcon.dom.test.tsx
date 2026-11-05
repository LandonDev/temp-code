import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_ICONS, HarnessIcon, MONOCHROME_HARNESSES } from "./HarnessIcon";
import { HARNESSES, HARNESS_TITLE } from "../lib/session";

afterEach(cleanup);

describe("HarnessIcon", () => {
  it("has a mark for every harness, the Muse one monochrome", () => {
    for (const id of HARNESSES) expect(typeof HARNESS_ICONS[id]).toBe("string");
    expect(MONOCHROME_HARNESSES.has("muse")).toBe(true);
    expect(HARNESS_TITLE.muse).toBe("Muse Code");
  });

  it("draws the Muse mark inline in currentColor, so it follows the text in both themes", () => {
    const { container } = render(<HarnessIcon harness="muse" className="size-3.5" />);
    expect(container.querySelector("img")).toBeNull();
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("class")).toContain("size-3.5");
  });
});
