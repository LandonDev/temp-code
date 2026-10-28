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

  it("names nothing for plain text or a language it does not colour, and keeps the header's height", () => {
    const header = (v: ReturnType<typeof render>) =>
      v.container.querySelector('[data-streamdown="code-block-header"]') as HTMLElement;
    for (const language of ["text", "txt", "plaintext", "", "klingon"]) {
      const view = render(<CodeBlock code="x" language={language} />);
      expect(header(view).querySelector("span")?.textContent).toBe("");
      expect(header(view).className).toContain("h-8");
      view.unmount();
    }
    const ts = render(<CodeBlock code="x" language="ts" />);
    expect(header(ts).querySelector("span")?.textContent).toBe("ts");
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
