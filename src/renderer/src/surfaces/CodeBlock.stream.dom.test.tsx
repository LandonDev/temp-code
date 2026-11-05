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
vi.mock("../lib/clipboard", () => ({ COPIED_MS: 1200, copyText: () => Promise.resolve() }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

import { createStreamReveal, StreamRevealContext, type StreamReveal } from "../lib/streamReveal";
import { REVEAL } from "../lib/ease";
import { CodeBlock, colourLines, HIGHLIGHT_EVERY_MS, splitColoured } from "./CodeBlock";
import fixture from "./CodeBlock.shiki.fixture.json";

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

describe("splitColoured", () => {
  it("takes a real shiki answer apart: the pre's attributes and one inner per line", () => {
    const split = splitColoured(fixture.html)!;
    expect(split.className).toBe("shiki transcript-neutral");
    expect(split.style).toEqual({ backgroundColor: "transparent", color: "var(--code-strong)" });
    expect(split.tabIndex).toBe(0);
    expect(split.lines).toHaveLength(fixture.code.split("\n").length);
    // Each line's inner markup reads back as its source line.
    const read = (html: string) => {
      const el = document.createElement("span");
      el.innerHTML = html;
      return el.textContent;
    };
    expect(split.lines.map(read)).toEqual(fixture.code.split("\n"));
    expect(split.lines[1]).toBe("");
  });

  it("refuses markup that is not shiki's", () => {
    expect(splitColoured("<div>x</div>")).toBeNull();
    expect(splitColoured('<pre><code><span class="other">x</span></code></pre>')).toBeNull();
  });
});

describe("colourLines", () => {
  it("keeps the lines that read the same and adds the rest plain, escaped", () => {
    const view = colourLines({ code: "a\nb", html: shiki("a\nb") }, "a\nbc\n<d>")!;
    expect(view.className).toBe("shiki");
    expect(view.lines).toEqual(['<span class="tok">a</span>', "bc", "&lt;d&gt;"]);
  });

  it("keeps the pre when no line survives, every line plain", () => {
    expect(colourLines({ code: "a", html: shiki("a") }, "b")).toEqual({ className: "shiki", style: undefined, tabIndex: undefined, lines: ["b"] });
  });
});

describe("lines as elements", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    asked.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const lineEls = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code > .line')];

  it("keeps every line's element across a recolour and across growth", async () => {
    const view = render(<CodeBlock code={"const a = 1;\nconst b = 2;"} language="ts" incomplete />);
    const [a, b] = lineEls(view.container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(lineEls(view.container)[0]).toBe(a);
    expect(a.querySelector(".tok")).not.toBeNull();
    view.rerender(<CodeBlock code={"const a = 1;\nconst b = 2;\nconst c = 3;"} language="ts" incomplete />);
    const now = lineEls(view.container);
    expect(now.slice(0, 2)).toEqual([a, b]);
    expect(now).toHaveLength(3);
    expect(view.container.querySelector("pre")!.className).toBe("shiki");
  });

  function streaming(reveal: StreamReveal, code: string) {
    return (
      <StreamRevealContext.Provider value={reveal}>
        <CodeBlock code={code} language="ts" incomplete />
      </StreamRevealContext.Provider>
    );
  }

  it("fades in a line that lands while the row streams; the lines it mounted with do not", () => {
    let t = 1_000;
    const reveal = createStreamReveal(() => t, () => false);
    const view = render(streaming(reveal, "one\ntwo"));
    reveal.arm();
    expect(lineEls(view.container).map((el) => el.classList.contains("stream-step"))).toEqual([false, false]);
    view.rerender(streaming(reveal, "one\ntwo\nthree"));
    expect(lineEls(view.container).map((el) => el.classList.contains("stream-step"))).toEqual([false, false, true]);
    expect(reveal.lastStepAt()).toBe(1_000);
    t += REVEAL.fadeMs;
    view.rerender(streaming(reveal, "one\ntwo\nthree\nfour"));
    expect(lineEls(view.container).map((el) => el.classList.contains("stream-step"))).toEqual([false, false, false, true]);
  });

  it("rises in a fence born while the row streams, never one it mounted with", () => {
    const t = 5_000;
    const born = createStreamReveal(() => t, () => false);
    born.arm();
    const fresh = render(streaming(born, "x = 1"));
    expect(fresh.container.querySelector('[data-streamdown="code-block"]')!.className).toContain("stream-rise");
    cleanup();
    const held = createStreamReveal(() => t, () => false);
    const old = render(streaming(held, "x = 1"));
    expect(old.container.querySelector('[data-streamdown="code-block"]')!.className).not.toContain("stream-rise");
  });

  it("fades nothing without a streaming row, nor under reduced motion", () => {
    const view = render(<CodeBlock code={"a\nb"} language="ts" />);
    expect(view.container.querySelector(".stream-step, .stream-rise")).toBeNull();
    cleanup();
    const still = createStreamReveal(() => 1, () => true);
    still.arm();
    const reduced = render(streaming(still, "a\nb"));
    expect(reduced.container.querySelector(".stream-step, .stream-rise")).toBeNull();
  });

  it("glides its body by the line while it streams, and not once settled", () => {
    const proto = HTMLElement.prototype;
    const height = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
    const parent = Object.getOwnPropertyDescriptor(proto, "offsetParent")!;
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get: function (this: HTMLElement) {
        return this.matches('[data-streamdown="code-block-body"]') ? this.querySelectorAll(".line").length * 20 : 0;
      },
    });
    Object.defineProperty(proto, "offsetParent", { configurable: true, get: () => document.body });
    try {
      const reveal = createStreamReveal(() => 1, () => false);
      reveal.arm();
      const view = render(streaming(reveal, "a"));
      const body = view.container.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')!;
      view.rerender(streaming(reveal, "a\nb"));
      expect(body.dataset.heightGlide).toBe("");
      expect(body.style.transition).toBe("height var(--dur-base) var(--ease-out)");
      expect(body.style.height).toBe("40px");
      view.rerender(
        <StreamRevealContext.Provider value={reveal}>
          <CodeBlock code={"a\nb"} language="ts" />
        </StreamRevealContext.Provider>,
      );
      expect(body.dataset.heightGlide).toBeUndefined();
    } finally {
      Object.defineProperty(proto, "offsetHeight", height);
      Object.defineProperty(proto, "offsetParent", parent);
    }
  });
});
