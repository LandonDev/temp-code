// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsNewDialog } from "./WhatsNewDialog";

afterEach(cleanup);

describe("WhatsNewDialog", () => {
  it("sizes to its notes up to min(72vh, 640px), with no fixed height or second scroller", () => {
    render(
      <WhatsNewDialog
        version="9.9.9"
        markdown={"## [9.9.9] - 2026-09-03\n\n### Changed\n\n- One line\n"}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const classes = dialog.className.split(/\s+/);
    expect(classes).toContain("max-h-[min(72vh,640px)]");
    expect(classes.some((c) => /^h-\[/.test(c))).toBe(false);
    expect(dialog.querySelector("[data-slot=scroll-area]")).toBeNull();
    expect(dialog.textContent).toContain("One line");
  });
});
