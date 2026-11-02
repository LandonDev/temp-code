import type { Element, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { REVEAL } from "./ease";
import { createStreamReveal, renderedText, STEP_CLASS } from "./streamReveal";

function harness(reduced = false) {
  let t = 1000;
  const reveal = createStreamReveal(
    () => t,
    () => reduced,
  );
  reveal.arm();
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(reveal.plugin);
  const run = (markdown: string): Root => processor.runSync(processor.parse(markdown)) as Root;
  return {
    reveal,
    run,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function spans(node: Root | Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Root | RootContent) => {
    if (n.type === "element") {
      if (n.tagName === "span" && n.properties?.dataRevealStep !== undefined) out.push(n);
      n.children.forEach(walk);
    } else if (n.type === "root") n.children.forEach(walk);
  };
  walk(node);
  return out;
}

const text = (el: Element) => renderedText(el);
const young = (el: Element) => Array.isArray(el.properties?.className) && el.properties.className.includes(STEP_CLASS);

describe("streamReveal", () => {
  it("wraps a step's text in one span that fades", () => {
    const { run } = harness();
    const tree = run("Hello there ");
    expect(spans(tree).map(text)).toEqual(["Hello there"]);
    expect(spans(tree).every(young)).toBe(true);
  });

  it("keeps each step its own span, and only young ones fade", () => {
    const { run, advance } = harness();
    run("Hello there ");
    advance(REVEAL.stepMs);
    let tree = run("Hello there and more ");
    // Rendered text: markdown drops a paragraph's trailing space.
    expect(spans(tree).map(text)).toEqual(["Hello there", " and more"]);
    expect(spans(tree).map(young)).toEqual([true, true]);
    advance(REVEAL.fadeMs);
    tree = run("Hello there and more words ");
    expect(spans(tree).map(text)).toEqual(["Hello there", " and more", " words"]);
    // The first two are older than the fade: plain, but still their own spans,
    // so the young one keeps its element as the block grows.
    expect(spans(tree).map(young)).toEqual([false, false, true]);
    expect(spans(tree).map((s) => s.properties?.dataRevealStep)).toEqual([0, 1, 2]);
  });

  it("splits a step across inline elements", () => {
    const { run, advance } = harness();
    run("Plain ");
    advance(REVEAL.stepMs);
    const tree = run("Plain and **bold text** after ");
    expect(spans(tree).map(text)).toEqual(["Plain", " and ", "bold text", " after"]);
    expect(spans(tree).map((s) => s.properties?.dataRevealStep)).toEqual([0, 1, 1, 1]);
  });

  it("fades a reparsed block whole", () => {
    const { run, advance } = harness();
    run("| a | b |");
    advance(REVEAL.fadeMs * 2);
    const tree = run("| a | b |\n| - | - |\n| 1 | 2 |");
    // The paragraph became a table: its text no longer starts with the
    // ledger's, so every cell is the new step and fades.
    expect(spans(tree).length).toBeGreaterThan(0);
    expect(spans(tree).every(young)).toBe(true);
  });

  it("leaves code blocks alone", () => {
    const { run } = harness();
    const tree = run("Intro\n\n```ts\nconst x = 1;\n```\n");
    expect(spans(tree).map(text)).toEqual(["Intro"]);
  });

  it("wraps nothing under reduced motion", () => {
    const { run } = harness(true);
    expect(spans(run("Hello there "))).toEqual([]);
  });

  it("shows, without fading, what the row held before it was armed", () => {
    let t = 0;
    const reveal = createStreamReveal(
      () => t,
      () => false,
    );
    const processor = unified().use(remarkParse).use(remarkRehype).use(reveal.plugin);
    const run = (md: string) => processor.runSync(processor.parse(md)) as Root;
    expect(spans(run("Already here ")).some(young)).toBe(false);
    reveal.arm();
    t += 10;
    const tree = run("Already here and new ");
    expect(spans(tree).map(young)).toEqual([false, true]);
    expect(reveal.lastStepAt()).toBe(10);
  });

  it("follows a short block as its key grows", () => {
    const { run, advance } = harness();
    run("Hi ");
    advance(REVEAL.fadeMs);
    const tree = run("Hi there, this block grows past its thirty-two character key ");
    expect(spans(tree).map(young)).toEqual([false, true]);
  });
});
