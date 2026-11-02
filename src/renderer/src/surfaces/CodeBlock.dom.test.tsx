// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({
  highlight: () => Promise.resolve(null),
  highlightCached: () => undefined,
}));
const copyText = vi.fn((_: string) => Promise.resolve());
vi.mock("../lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { CodeBlock } from "./CodeBlock";

afterEach(() => {
  cleanup();
  copyText.mockClear();
});

describe("CodeBlock", () => {
  it("has no line numbers unless asked", () => {
    const plain = render(<CodeBlock code={"a\nb\n"} language="ts" />);
    expect(plain.container.querySelector("[data-line-numbers]")).toBeNull();
    plain.unmount();
    const numbered = render(<CodeBlock code="a" language="ts" lineNumbers startLine={12} />);
    const body = numbered.container.querySelector("[data-line-numbers]") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.style.counterReset).toBe("line 11");
  });

  it("shows the language, or the label in its place", () => {
    const view = render(<CodeBlock code="x" language="TypeScript" />);
    expect(view.container.querySelector('[data-streamdown="code-block-header"]')?.textContent).toContain("typescript");
    view.rerender(<CodeBlock code="x" language="ts" label={<span>src/a.ts</span>} />);
    expect(view.container.querySelector('[data-streamdown="code-block-header"]')?.textContent).toContain("src/a.ts");
  });

  it("a plain fence has no header: the copy button floats at the top right on a 4px corner", () => {
    for (const language of ["text", "txt", "plaintext", "", "klingon"]) {
      const view = render(<CodeBlock code="x" language={language} />);
      const block = view.container.querySelector('[data-streamdown="code-block"]') as HTMLElement;
      expect(block.querySelector('[data-streamdown="code-block-header"]')).toBeNull();
      expect(block.className).toContain("relative");
      const button = block.querySelector("button") as HTMLElement;
      expect(button.parentElement).toBe(block);
      expect(button.className).toMatch(/\babsolute\b/);
      expect(button.className).toMatch(/\bright-1\b/);
      expect(button.className).toMatch(/\btop-1\b/);
      expect(button.className).toMatch(/\brounded-sm\b/);
      expect(button.className).not.toMatch(/\brounded-md\b/);
      view.unmount();
    }
  });

  it("a labelled fence has the 28px header with the copy button in it, on a 4px corner", () => {
    const header = (v: ReturnType<typeof render>) =>
      v.container.querySelector('[data-streamdown="code-block-header"]') as HTMLElement;
    const ts = render(<CodeBlock code="x" language="ts" />);
    expect(header(ts).className).toMatch(/\bh-7\b/);
    expect(header(ts).className).not.toMatch(/\bh-8\b/);
    expect(header(ts).querySelector("span")?.textContent).toBe("ts");
    const button = header(ts).querySelector("button") as HTMLElement;
    expect(button.className).toMatch(/\brounded-sm\b/);
    expect(button.className).not.toMatch(/\babsolute\b/);
    ts.rerender(<CodeBlock code="x" language="text" label={<span>notes.txt</span>} />);
    expect(header(ts).textContent).toContain("notes.txt");
  });

  it("copies the code without its trailing newline", async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    const view = render(<CodeBlock code={"const a = 1;\n"} language="ts" />);
    fireEvent.pointerEnter(view.container.firstElementChild!);
    const button = screen.getByRole("button", { name: "Copy code" });
    expect(button.getAttribute("data-slot")).toBe("tooltip-trigger");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(copyText).toHaveBeenCalledWith("const a = 1;");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
