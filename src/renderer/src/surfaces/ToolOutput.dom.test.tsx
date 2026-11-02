// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolOutputLines } from "./ToolDetails";

const copyText = vi.fn((_: string) => Promise.resolve());
vi.mock("../lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

afterEach(() => {
  cleanup();
  copyText.mockClear();
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("ToolOutputLines", () => {
  it("shows the whole output in a box capped at 320px that scrolls inside itself", () => {
    const { container } = render(<ToolOutputLines text={lines(120)} error={false} />);
    const box = container.querySelector<HTMLElement>('[data-slot="tool-output"]')!;
    expect(box.textContent).toBe(lines(120));
    expect(box.className).toContain("max-h-80");
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className).toContain("overflow-x-hidden");
    // The window measures natural heights: no containment on the box.
    expect(box.className).not.toMatch(/content-visibility|contain-/);
    // A scrolling text region takes the keyboard.
    expect(box.tabIndex).toBe(0);
    expect(container.textContent).not.toMatch(/more lines?/);
  });

  it("a short output is no tab stop", () => {
    const { container } = render(<ToolOutputLines text={lines(3)} error={false} />);
    expect(container.querySelector('[data-slot="tool-output"]')!.hasAttribute("tabindex")).toBe(false);
  });

  it("Copy takes the whole output, ANSI stripped", async () => {
    const text = `\u001b[32mok\u001b[0m\n${lines(200)}\n\n`;
    const { getByRole } = render(<ToolOutputLines text={text} error={false} />);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy output" }));
    });
    expect(copyText).toHaveBeenCalledWith(`ok\n${lines(200)}`);
    expect(getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("a failed call's output reads in red; an empty one draws nothing", () => {
    const { container, rerender } = render(<ToolOutputLines text="boom" error />);
    expect(container.querySelector('[data-slot="tool-output"]')!.className).toContain("text-destructive");
    rerender(<ToolOutputLines text={"\n\n"} error={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("10,000 lines render as one text node, cheaply", () => {
    const text = lines(10_000);
    const start = performance.now();
    const { container } = render(<ToolOutputLines text={text} error={false} />);
    const ms = performance.now() - start;
    const box = container.querySelector('[data-slot="tool-output"]')!;
    expect(box.childNodes).toHaveLength(1);
    expect(box.textContent).toHaveLength(text.length);
    expect(ms).toBeLessThan(250);
  });
});
