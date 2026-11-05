import type { Element, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { REVEAL } from "./ease";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStreamReveal, LEDGER_KEY_CHARS, renderedText, RISE_CLASS, STEP_CLASS } from "./streamReveal";

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
    // ledger's, so every cell is the new step, and every row rises with it.
    expect(spans(tree).length).toBeGreaterThan(0);
    const rows: Element[] = [];
    const walk = (n: Root | RootContent) => {
      if (n.type === "element" && n.tagName === "tr") rows.push(n);
      if (n.type === "element" || n.type === "root") n.children.forEach(walk);
    };
    walk(tree);
    expect(rows.length).toBe(2);
    expect(rows.every((tr) => (tr.properties?.className as string[] | undefined)?.includes(RISE_CLASS))).toBe(true);
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

describe("lineTimes", () => {
  it("times each line when it first shows; lines held before the row armed are old", () => {
    let t = 100;
    const reveal = createStreamReveal(() => t, () => false);
    expect(reveal.lineTimes("a\nb", 2)).toEqual([-Infinity, -Infinity]);
    reveal.arm();
    t = 200;
    expect(reveal.lineTimes("a\nb\nc", 3)).toEqual([-Infinity, -Infinity, 200]);
    t = 300;
    expect(reveal.lineTimes("a\nb\nc", 3)).toEqual([-Infinity, -Infinity, 200]);
    expect(reveal.lastStepAt()).toBe(200);
  });

  it("follows a short fence into its longer key, and a fence with other code starts afresh", () => {
    let t = 10;
    const reveal = createStreamReveal(() => t, () => false);
    reveal.arm();
    reveal.lineTimes("x", 1);
    t = 20;
    const long = "x".repeat(LEDGER_KEY_CHARS) + "\nmore";
    expect(reveal.lineTimes(long, 2)).toEqual([10, 20]);
    t = 30;
    expect(reveal.lineTimes("y = 1", 1)).toEqual([30]);
  });

  it("says which lines still fade: none once REVEAL.fadeMs passed, none under reduced motion", () => {
    let t = 0;
    const reveal = createStreamReveal(() => t, () => false);
    reveal.arm();
    expect(reveal.freshLines("a", 1)).toEqual([true]);
    t = REVEAL.fadeMs;
    expect(reveal.freshLines("a\nb", 2)).toEqual([false, true]);
    const still = createStreamReveal(() => 0, () => true);
    still.arm();
    expect(still.freshLines("a", 1)).toEqual([false]);
  });
});

describe("blocks born mid-stream", () => {
  const find = (tree: Root, tag: string): Element[] => {
    const out: Element[] = [];
    const walk = (n: Root | RootContent) => {
      if (n.type === "element") {
        if (n.tagName === tag) out.push(n);
        n.children.forEach(walk);
      } else if (n.type === "root") n.children.forEach(walk);
    };
    walk(tree);
    return out;
  };
  const rises = (el: Element) => Array.isArray(el.properties?.className) && el.properties.className.includes(RISE_CLASS);

  it("raise a new list item, and its first step's spans leave the fade to it", () => {
    const { run, advance } = harness();
    run("- one\n");
    advance(REVEAL.fadeMs);
    const tree = run("- one\n- two and more\n");
    expect(find(tree, "li").map(rises)).toEqual([false, true]);
    const item = find(tree, "li")[1];
    expect(spans(item).some(young)).toBe(false);
  });

  it("raise a table row, a heading and a quote's line", () => {
    const { run, advance } = harness();
    run("| a | b |\n| - | - |\n| 1 | 2 |\n");
    advance(REVEAL.fadeMs);
    const table = run("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n");
    expect(find(table, "tr").map(rises)).toEqual([false, false, true]);

    const heading = harness();
    heading.run("Intro\n");
    heading.advance(REVEAL.fadeMs);
    expect(find(heading.run("Intro\n\n## Next part\n"), "h2").map(rises)).toEqual([true]);

    const quote = harness();
    quote.run("Intro\n");
    quote.advance(REVEAL.fadeMs);
    const quoted = quote.run("Intro\n\n> said this\n");
    expect(find(quoted, "blockquote").map(rises)).toEqual([false]);
    expect(find(quoted, "p").map(rises)).toEqual([false, true]);
  });

  it("never raise a plain paragraph: it keeps the word fade", () => {
    const { run, advance } = harness();
    run("First paragraph\n");
    advance(REVEAL.fadeMs);
    const tree = run("First paragraph\n\nSecond one here\n");
    expect(find(tree, "p").map(rises)).toEqual([false, false]);
    expect(spans(find(tree, "p")[1]).every(young)).toBe(true);
  });

  it("keep an older item still when it gains a nested list, and raise only the new item", () => {
    const { run, advance } = harness();
    run("- one\n- two\n");
    advance(REVEAL.fadeMs);
    const tree = run("- one\n- two\n  - nested\n");
    const items = find(tree, "li");
    expect(items.map((li) => renderedText(li).trim().split("\n")[0])).toEqual(["one", "two", "nested"]);
    expect(items.map(rises)).toEqual([false, false, true]);
  });

  it("raise one element per branch: a list born whole rises by its items, not twice", () => {
    const { run, advance } = harness();
    run("Intro\n");
    advance(REVEAL.fadeMs);
    const tree = run("Intro\n\n- a\n  - b\n");
    expect(find(tree, "li").map(rises)).toEqual([true, false]);
  });

  it("raise nothing under reduced motion", () => {
    const { run, advance } = harness(true);
    run("- one\n");
    advance(REVEAL.fadeMs);
    expect(find(run("- one\n- two\n"), "li").some(rises)).toBe(false);
  });
});

describe("the stream's motion rules", () => {
  const css = readFileSync(resolve(__dirname, "../assets/components.css"), "utf8");
  const reduced = css.slice(css.indexOf(".stream-rise {"));

  it("raise a block on the fade and a 4px rise, and only fade it under reduced motion", () => {
    expect(css).toMatch(/@keyframes stream-rise-in \{\s*from \{\s*translate: 0 4px;/);
    expect(css).toMatch(/\.stream-rise \{\s*animation:\s*stream-step-in var\(--dur-reveal\) var\(--ease-reveal\) both,\s*stream-rise-in var\(--dur-base\) var\(--ease-out\) both;/);
    expect(reduced).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.stream-rise \{\s*animation: stream-step-in var\(--dur-reveal\) var\(--ease-reveal\) both;/);
  });

  it("fade a table's card with its header row, the row then only rising", () => {
    expect(css).toContain('.agent-markdown [data-streamdown="table-wrapper"]:has(thead tr.stream-rise) {\n  animation: stream-step-in var(--dur-reveal) var(--ease-reveal) both;');
    expect(css).toContain("thead tr.stream-rise {\n  animation: stream-rise-in var(--dur-base) var(--ease-out) both;");
  });

  it("delay a landing step by its place in the batch, with no transition under reduced motion", () => {
    expect(css).toMatch(/\.step-land \{[^}]*transition-delay: calc\(var\(--stagger-step\) \* var\(--stagger, 0\)\);/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.step-land \{\s*transition: none;/);
  });
});
