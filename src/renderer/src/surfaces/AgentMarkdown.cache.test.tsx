// @vitest-environment jsdom
/**
 * The markdown render cache, measured on the real streamdown pipeline (the
 * dom project stubs streamdown out, so this runs in the node project with
 * jsdom switched on per file): a settled 200-block transcript mounted twice
 * parses exactly once.
 */
import "../test/domSetup";

// streamdown scrolls an animating code block; jsdom has no scrollTo.
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({
  highlight: () => Promise.resolve(null),
  highlightCached: () => undefined,
}));

import { hastCache, parseStats } from "../lib/markdownCache";
import { AgentMarkdown } from "./AgentMarkdown";

const BLOCKS = 200;

function blockText(n: number): string {
  return [
    `## Step ${n}`,
    "",
    `Paragraph ${n} with **bold**, _emphasis_, \`inline code\` and a [link](https://example.com/${n}).`,
    "",
    "- first point",
    `- second point ${n}`,
    "",
    "| col | value |",
    "| --- | --- |",
    `| a | ${n} |`,
    "",
    "```ts",
    `const x${n} = ${n};`,
    "```",
  ].join("\n");
}

function Transcript(): React.ReactElement {
  return (
    <div>
      {Array.from({ length: BLOCKS }, (_, n) => (
        <AgentMarkdown key={n} text={blockText(n)} />
      ))}
    </div>
  );
}

describe("markdown render cache", () => {
  beforeEach(() => {
    hastCache.clear();
    parseStats.parses = 0;
  });
  afterEach(cleanup);

  it("a second mount of a settled transcript never reaches the parser", () => {
    const first = render(<Transcript />);
    const firstHtml = first.container.innerHTML;
    const parses = parseStats.parses;
    expect(parses).toBeGreaterThanOrEqual(BLOCKS);
    expect(first.container.querySelectorAll("h2").length).toBe(BLOCKS);
    first.unmount();

    const second = render(<Transcript />);
    expect(parseStats.parses).toBe(parses);
    expect(second.container.innerHTML).toBe(firstHtml);
    second.unmount();
  }, 20_000);

  it("a streaming block bypasses the cache; settling stores it once", () => {
    const text = blockText(1);
    const view = render(<AgentMarkdown text={text} streaming />);
    expect(hastCache.size).toBe(0);
    act(() => {
      view.rerender(<AgentMarkdown text={text} />);
    });
    expect(hastCache.size).toBeGreaterThan(0);
    const parses = parseStats.parses;
    act(() => {
      view.rerender(<AgentMarkdown text={text} className="x" />);
    });
    expect(parseStats.parses).toBe(parses);
    view.unmount();
  });

  it("changed text is a miss, so an edited block re-parses", () => {
    const view = render(<AgentMarkdown text="hello **world**" />);
    const parses = parseStats.parses;
    act(() => {
      view.rerender(<AgentMarkdown text="hello **there**" />);
    });
    expect(parseStats.parses).toBeGreaterThan(parses);
    expect(view.container.textContent).toContain("there");
    view.unmount();
  });
});
