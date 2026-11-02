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
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("group-hover/message:opacity-100");
    expect(button.className).toContain("group-hover/message:delay-(--delay-hover)");
    expect(button.className).toContain("focus-visible:opacity-100");
    expect(button.className).toContain("focus-visible:delay-(--dur-instant)");
    // Mounted under the pointer (the lazy tooltip swaps the element on the
    // first hover), it still starts hidden and waits.
    expect(button.className).toContain("starting:opacity-0");
  });
});
