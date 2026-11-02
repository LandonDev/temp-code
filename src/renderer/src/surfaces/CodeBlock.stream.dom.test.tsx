// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The worker stood in: colours each line as one `.tok` span, and answers
 *  after 50 ms. */
const asked: string[] = [];
const shiki = (code: string) =>
  `<pre class="shiki"><code>${code
    .split("\n")
    .map((line) => `<span class="line"><span class="tok">${line}</span></span>`)
    .join("")}</code></pre>`;
vi.mock("../lib/highlight", () => ({
  highlight: (code: string) => {
    asked.push(code);
    return new Promise((resolve) => setTimeout(() => resolve(shiki(code)), 50));
  },
  highlightCached: () => undefined,
}));
vi.mock("../lib/clipboard", () => ({ copyText: () => Promise.resolve() }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

import { CodeBlock, colourPrefix, HIGHLIGHT_EVERY_MS } from "./CodeBlock";

const lines = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-streamdown="code-block-body"] .line')).map((line) => ({
    text: line.textContent,
    coloured: !!line.querySelector(".tok"),
  }));

describe("a streaming code block", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    asked.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("colours while it streams: the first run at once, then at most every HIGHLIGHT_EVERY_MS, never put off", async () => {
    let code = "const a = 1;";
    const view = render(<CodeBlock code={code} language="ts" incomplete />);
    expect(asked).toEqual([code]);
    // A delta every 20 ms for 600 ms: a debounce would never fire.
    for (let i = 0; i < 30; i++) {
      code += i % 3 === 0 ? "\nlet b = 2;" : " x";
      view.rerender(<CodeBlock code={code} language="ts" incomplete />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    expect(asked.length).toBeGreaterThanOrEqual(3);
    expect(asked.length).toBeLessThanOrEqual(Math.ceil(600 / HIGHLIGHT_EVERY_MS) + 1);
    expect(lines(view.container).some((line) => line.coloured)).toBe(true);
  });

  it("shows a new line plain before its colour arrives, and colour never leaves", async () => {
    const first = "const a = 1;\nconst b = 2;";
    const view = render(<CodeBlock code={first} language="ts" incomplete />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(lines(view.container)).toEqual([
      { text: "const a = 1;", coloured: true },
      { text: "const b = 2;", coloured: true },
    ]);
    const next = `${first}\nconst c = 3;`;
    view.rerender(<CodeBlock code={next} language="ts" incomplete />);
    // The new line shows at once, plain; the old lines keep their colour.
    expect(lines(view.container)).toEqual([
      { text: "const a = 1;", coloured: true },
      { text: "const b = 2;", coloured: true },
      { text: "const c = 3;", coloured: false },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIGHLIGHT_EVERY_MS + 60);
    });
    expect(lines(view.container).every((line) => line.coloured)).toBe(true);
  });
});

describe("colourPrefix", () => {
  it("keeps the lines that read the same and adds the rest plain, escaped", () => {
    const html = colourPrefix({ code: "a\nb", html: shiki("a\nb") }, "a\nbc\n<d>")!;
    expect(html).toContain('<span class="line"><span class="tok">a</span></span>');
    expect(html).toContain('<span class="line">bc</span><span class="line">&lt;d&gt;</span>');
    expect(html.startsWith('<pre class="shiki"><code>')).toBe(true);
    expect(html.endsWith("</code></pre>")).toBe(true);
  });

  it("gives up when nothing survives", () => {
    expect(colourPrefix({ code: "a", html: shiki("a") }, "b")).toBeNull();
  });
});
