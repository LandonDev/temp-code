// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/copyMessage", () => ({ copyUserMessage: () => Promise.resolve() }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

import { CopyMessageButton } from "./CopyMessageButton";

afterEach(cleanup);

describe("CopyMessageButton", () => {
  it("shows on hover after the hover delay, on keyboard focus at once", () => {
    render(<CopyMessageButton text="hello" attachments={[]} />);
    const button = screen.getByRole("button", { name: "Copy message" });
    // The reveal rides a wrapper, so the button keeps its own hover fill's transition.
    const reveal = button.closest("span.opacity-0") as HTMLElement;
    expect(reveal.className).toContain("group-hover/message:opacity-100");
    expect(reveal.className).toContain("group-hover/message:delay-(--delay-hover)");
    expect(reveal.className).toContain("has-focus-visible:opacity-100");
    expect(reveal.className).toContain("has-focus-visible:delay-(--dur-instant)");
    // Mounted under the pointer, it still starts hidden and waits.
    expect(reveal.className).toContain("starting:opacity-0");
    expect(button.className).not.toMatch(/opacity-0|transition-opacity/);
    expect(button.className).toContain("transition-[background-color,color,border-color]");
  });
});
