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
import { parseMarkdownBlocks } from "../lib/markdownPipeline";
import { parseWorkerStats, prepareMarkdown, resetMarkdownParse } from "../lib/markdownParse";
import { AgentMarkdown } from "./AgentMarkdown";

/** The parse worker, stood in by a timer: parses on the shared pipeline. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(_url: URL, _opts?: unknown) {}
  postMessage(msg: { id: number; text: string }) {
    setTimeout(() => {
      this.onmessage?.({ data: { id: msg.id, blocks: parseMarkdownBlocks(msg.text) } });
    }, 0);
  }
  terminate() {}
}
const g = globalThis as unknown as { Worker?: unknown };

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
    resetMarkdownParse();
    g.Worker = undefined;
  });
  afterEach(() => {
    cleanup();
    resetMarkdownParse();
    g.Worker = undefined;
  });

  it("the worker's trees mount with no parse on this thread, byte for byte the main-thread markup", async () => {
    // The reference: what the main thread's own pipeline renders (after the
    // code blocks' file icons, which load on their own, are in).
    const reference = render(<Transcript />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const referenceHtml = reference.container.innerHTML;
    reference.unmount();
    hastCache.clear();
    parseStats.parses = 0;
    // With a worker: settled rows hold their place until it answers, then
    // mount the cached tree; the parser on this thread never runs.
    g.Worker = FakeWorker;
    const view = render(<Transcript />);
    expect(view.container.querySelectorAll("h2").length).toBe(0);
    expect(view.container.querySelectorAll("pre[aria-hidden]").length).toBe(BLOCKS);
    await act(async () => {
      await Promise.all(Array.from({ length: BLOCKS }, (_, n) => prepareMarkdown(blockText(n))));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(view.container.querySelectorAll("h2").length).toBe(BLOCKS);
    expect(parseStats.parses).toBe(0);
    expect(view.container.innerHTML).toBe(referenceHtml);
    view.unmount();
  }, 30_000);

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

  it("a block that streamed here settles in place, never through the worker", () => {
    g.Worker = FakeWorker;
    const text = blockText(2);
    const view = render(<AgentMarkdown text={text} streaming />);
    expect(view.container.querySelectorAll("h2").length).toBe(1);
    act(() => {
      view.rerender(<AgentMarkdown text={text} />);
    });
    // Still mounted, no placeholder, nothing asked of the worker.
    expect(view.container.querySelectorAll("h2").length).toBe(1);
    expect(view.container.querySelectorAll("pre[aria-hidden]").length).toBe(0);
    expect(parseWorkerStats.requested).toBe(0);
    view.unmount();
  });

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
