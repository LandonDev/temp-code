// @vitest-environment jsdom
/**
 * No jerk in any scenario, for what streams inside a reply (docs/TRANSCRIPT.md):
 * a 40-line code fence and a list followed by a table, on the real streamdown
 * pipeline (the dom project stubs streamdown out, so this runs in the node
 * project with jsdom per file, as AgentMarkdown.reveal.test.tsx does). After
 * every delta the streaming motion's element rules hold (`watchMotion`): a
 * code line keeps its element and fades once, a block rises once, and a code
 * block's body never changes height by a jump.
 */
import "../test/domSetup";

if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The worker stood in: each line one `.tok` span, answered at once. */
vi.mock("../lib/highlight", () => ({
  highlight: (code: string) =>
    Promise.resolve(
      `<pre class="shiki" style="color:var(--code-strong)" tabindex="0"><code>${code
        .split("\n")
        .map((line) => `<span class="line"><span class="tok">${line}</span></span>`)
        .join("")}</code></pre>`,
    ),
  highlightCached: () => undefined,
}));

import { REVEAL } from "../lib/ease";
import { AgentMarkdown } from "./AgentMarkdown";
import { watchMotion } from "./transcriptScenario.testkit";

const FAKE = ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] as const;
const LINE = 20;

// jsdom lays nothing out: a code block's body is 20px a line, so the height rule bites.
const proto = HTMLElement.prototype;
const height = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
const parent = Object.getOwnPropertyDescriptor(proto, "offsetParent")!;
const rect = proto.getBoundingClientRect;
const isBody = (el: HTMLElement) => el.matches('[data-streamdown="code-block-body"]');
const natural = (el: HTMLElement) => (isBody(el) ? el.querySelectorAll("code > .line").length * LINE : (height.get!.call(el) as number));
beforeAll(() => {
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: function (this: HTMLElement) { return natural(this); } });
  Object.defineProperty(proto, "offsetParent", { configurable: true, get: () => document.body });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const inline = parseFloat(this.style.height);
    return (isBody(this) ? { height: Number.isFinite(inline) ? inline : natural(this) } : rect.call(this)) as DOMRect;
  };
});
afterAll(() => {
  Object.defineProperty(proto, "offsetHeight", height);
  Object.defineProperty(proto, "offsetParent", parent);
  proto.getBoundingClientRect = rect;
});

describe("no jerk in a streaming reply", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** Streams `deltas` one every `every` ms, checking the rules after each. */
  function play(deltas: string[], every = 60) {
    const view = render(<AgentMarkdown text="" streaming revealFromStart />);
    const check = watchMotion(view.container);
    const seen = { lineFades: 0, glides: 0, rises: new Set<string>() };
    const look = (label: string) => {
      check(label);
      seen.lineFades += view.container.querySelectorAll(".line.stream-step").length;
      if (view.container.querySelector("[data-height-glide]")) seen.glides++;
      for (const el of view.container.querySelectorAll(".stream-rise")) seen.rises.add(el.tagName.toLowerCase());
    };
    let text = "";
    deltas.forEach((delta, i) => {
      text += delta;
      act(() => view.rerender(<AgentMarkdown text={text} streaming revealFromStart />));
      look(`delta ${i} (at once)`);
      act(() => vi.advanceTimersByTime(every));
      look(`delta ${i}`);
    });
    act(() => view.rerender(<AgentMarkdown text={text} revealFromStart />));
    for (let ms = 0; ms < 4_000; ms += 100) {
      act(() => vi.advanceTimersByTime(100));
      look(`drain ${ms}`);
    }
    return { view, seen };
  }

  it("a 40-line code fence: one element per line, each fading in once, the body gliding by the line", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i}, options);`);
    const deltas = ["Here is the module:\n\n```ts\n"];
    // Each line in two deltas, so a line is half-written between them.
    for (const line of lines) deltas.push(line.slice(0, 18), `${line.slice(18)}\n`);
    deltas.push("```\n\nThat is all.");
    const { view, seen } = play(deltas);
    const shown = view.container.querySelectorAll('[data-streamdown="code-block-body"] code > .line');
    expect(shown).toHaveLength(40);
    expect(shown[39].textContent).toBe(lines[39]);
    expect(seen.lineFades).toBeGreaterThan(0);
    expect(seen.glides).toBeGreaterThan(0);
    expect(seen.rises.has("div")).toBe(true);
    // Settled: nothing still fades, rises or glides.
    expect(view.container.querySelector(".stream-step, .stream-rise, [data-height-glide]")).toBeNull();
  });

  it("a list of 8 items, then a table of 6 rows: each item and row rises once, older ones never again", () => {
    const deltas = ["The steps, in order:\n\n"];
    for (let i = 1; i <= 8; i++) deltas.push(`- Step ${i} moves `, `the thing number ${i}\n`);
    deltas.push("\nAnd the figures:\n\n| Name | Value |\n", "|---|---|\n");
    for (let i = 1; i <= 6; i++) deltas.push(`| row ${i} | ${i * 10} |\n`);
    const { view, seen } = play(deltas, 80);
    expect(view.container.querySelectorAll("li")).toHaveLength(8);
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(6);
    expect(seen.rises.has("li")).toBe(true);
    expect(seen.rises.has("tr")).toBe(true);
    expect(view.container.querySelector("p.stream-rise")).toBeNull();
    act(() => vi.advanceTimersByTime(REVEAL.fadeMs));
    expect(view.container.querySelector(".stream-rise")).toBeNull();
  });
});
