import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./markdown.css", import.meta.url), "utf8");

/** Every rule as its selectors and its declarations, comments dropped. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = code
  .split("}")
  .map((chunk) => chunk.split("{"))
  .filter((parts) => parts.length === 2)
  .map(([selectors, body]) => ({
    selectors: selectors.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/\s+/g, " ")),
    body: body.trim(),
  }));

/** The declarations of every rule naming this selector, in file order. */
const decl = (selector: string) =>
  rules
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join("\n");

/** Rules whose selector list has a selector containing this text. */
const anyRule = (part: string) => rules.filter((r) => r.selectors.some((s) => s.includes(part)));

const BLOCKS = ['[data-streamdown="code-block"]', '[data-streamdown="table-wrapper"]', '[data-streamdown="blockquote"]', '[data-streamdown="mermaid-block"]'];

describe("transcript/markdown.css", () => {
  it("zeroes every block's margins first, under streamdown's space-y-4 and its blocks' own margins", () => {
    expect(decl(".agent-markdown > *")).toContain("margin-block: 0");
    expect(decl('.agent-markdown :where(li, [data-streamdown="blockquote"]) > *')).toContain("margin-block: 0");
    // No gap is a margin-bottom: the last block ends flush, nothing collapses.
    expect(code).not.toMatch(/margin-bottom|margin-block-end/);
    // The reset comes before every gap, which wins it at equal specificity.
    const at = (selector: string) => rules.findIndex((r) => r.selectors.includes(selector));
    expect(at(".agent-markdown > *")).toBeGreaterThanOrEqual(0);
    expect(at(".agent-markdown > *")).toBeLessThan(at(".agent-markdown > * + *"));
  });

  it("puts 12px between two blocks, and keeps 12px around a code block, table, quote or diagram inside an item or quote", () => {
    expect(decl(".agent-markdown > * + *")).toContain("margin-top: 12px");
    const nested = anyRule("li > :is(").find((r) => r.body.includes("12px"));
    expect(nested).toBeDefined();
    for (const block of BLOCKS) expect(nested!.selectors.join(" ")).toContain(block);
    expect(nested!.selectors.some((s) => s.endsWith("+ *"))).toBe(true);
  });

  it("hangs lists 22px with the marker outside, items 4px apart and 4px into a nested list", () => {
    for (const list of ['.agent-markdown [data-streamdown="unordered-list"]', '.agent-markdown [data-streamdown="ordered-list"]']) {
      expect(decl(list)).toContain("list-style-position: outside");
      expect(decl(list)).toContain("padding-inline-start: 22px");
    }
    expect(decl(".agent-markdown li")).toContain("padding-block: 0");
    expect(decl(".agent-markdown li + li")).toContain("margin-top: 4px");
    expect(
      decl('.agent-markdown li > :is([data-streamdown="unordered-list"], [data-streamdown="ordered-list"])'),
    ).toContain("margin-top: 4px");
  });

  it("makes a loose item's paragraphs blocks, 8px apart in an item or a quote", () => {
    expect(decl(".agent-markdown li > p")).toContain("display: block");
    expect(decl('.agent-markdown :is(li, [data-streamdown="blockquote"]) > * + *')).toContain("margin-top: 8px");
  });

  it("sets headings on the prose's scale: 20px above, 4px under, h1 16/24, h2 15/22, h3 to h6 14/22", () => {
    expect(decl('.agent-markdown > * + [data-streamdown^="heading-"]')).toContain("margin-top: 20px");
    expect(decl('.agent-markdown > [data-streamdown^="heading-"] + *')).toContain("margin-top: 4px");
    const all = decl('.agent-markdown [data-streamdown^="heading-"]');
    expect(all).toContain("font-size: 14px");
    expect(all).toContain("line-height: 22px");
    expect(all).toContain("font-weight: 600");
    const h1 = decl('.agent-markdown [data-streamdown="heading-1"]');
    expect(h1).toContain("font-size: 16px");
    expect(h1).toContain("line-height: 24px");
    expect(h1).toContain("letter-spacing: -0.01em");
    expect(decl('.agent-markdown [data-streamdown="heading-2"]')).toContain("font-size: 15px");
    // h3 to h6 take the shared rule alone: nothing sizes them apart.
    for (const n of [3, 4, 5, 6]) expect(decl(`.agent-markdown [data-streamdown="heading-${n}"]`)).toBe("");
  });

  it("drops the duplicate first-child heading rule (streamdown's root zeroes the first child)", () => {
    expect(code).not.toContain(":first-child");
  });

  it("draws a quote as a 2px hairline, 12px in, muted and upright", () => {
    const quote = decl('.agent-markdown [data-streamdown="blockquote"]');
    expect(quote).toContain("border-left: 2px solid var(--border)");
    expect(quote).toContain("padding-left: 12px");
    expect(quote).toContain("font-style: normal");
    expect(quote).toContain("color: var(--muted-foreground)");
    expect(decl('.agent-markdown [data-streamdown="blockquote"] :is(p, li, strong, [data-streamdown="strong"])')).toContain(
      "color: var(--muted-foreground)",
    );
  });

  it("sets table cells 13/20 for 36px rows, the header unfilled, 500 and muted", () => {
    const cell = decl('.agent-markdown [data-streamdown="table-cell"]');
    expect(cell).toContain("padding: 8px 12px");
    expect(cell).toContain("font-size: 13px");
    expect(cell).toContain("line-height: 20px");
    expect(decl('.agent-markdown [data-streamdown="table-header"]')).toContain("background: transparent");
    const head = decl('.agent-markdown [data-streamdown="table-header-cell"]');
    expect(head).toContain("line-height: 20px");
    expect(head).toContain("font-weight: 500");
    expect(head).toContain("color: var(--muted-foreground)");
  });

  it("frames code and tables as one card with no margin of their own", () => {
    const card = decl('.agent-markdown [data-streamdown="code-block"]');
    expect(card).toContain("border: 1px solid var(--border)");
    expect(card).toContain("border-radius: var(--radius-lg)");
    expect(card).toContain("background: var(--card)");
    expect(card).not.toContain("margin");
    expect(decl('.agent-markdown [data-streamdown="code-block-body"]')).toContain("padding: 12px");
    expect(decl('.agent-markdown [data-streamdown="code-block-header"] + [data-streamdown="code-block-body"]')).toContain(
      "padding-top: 0",
    );
  });

  it("rules an hr with one hairline in 20px of air each side", () => {
    expect(decl('.agent-markdown [data-streamdown="horizontal-rule"]')).toContain("border-top: 1px solid var(--border)");
    expect(decl('.agent-markdown > * + [data-streamdown="horizontal-rule"]')).toContain("margin-top: 20px");
    expect(decl('.agent-markdown > [data-streamdown="horizontal-rule"] + *')).toContain("margin-top: 20px");
  });

  it("takes the bullet off a task list's items, their checkbox the marker", () => {
    expect(decl(".agent-markdown li.task-list-item")).toContain("list-style: none");
    expect(decl('.agent-markdown li.task-list-item input[type="checkbox"]')).toContain("margin: 0 0.5rem 0 0");
  });

  it("writes no literal colour", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(|color-mix/i);
  });
});
