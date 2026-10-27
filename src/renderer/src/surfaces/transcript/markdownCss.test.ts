import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./markdown.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("transcript/markdown.css", () => {
  it("sets an h1 on the type scale: 16px with -0.01em, semibold through the heading rule", () => {
    const h1 = rule('.agent-markdown [data-streamdown="heading-1"]');
    expect(h1).toContain("font-size: 16px");
    expect(h1).toContain("letter-spacing: -0.01em");
    expect(css).toMatch(/heading-3"\] \{[^}]*font-weight: 600/);
  });

  it("takes the bullet off a task list's items, their checkbox the marker", () => {
    expect(rule(".agent-markdown li.task-list-item")).toContain("list-style: none");
    expect(rule('.agent-markdown li.task-list-item input[type="checkbox"]')).toContain("margin: 0 0.5rem 0 0");
  });

  it("writes no literal colour", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(|color-mix/i);
  });
});
