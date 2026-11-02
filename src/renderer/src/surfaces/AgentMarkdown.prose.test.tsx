// @vitest-environment jsdom
/**
 * AgentMarkdown's prose on the real streamdown pipeline (the dom project
 * stubs streamdown out, so this runs in the node project with jsdom per
 * file, like AgentMarkdown.cache.test.tsx): the size classes and the one
 * inline-code pill.
 */
import "../test/domSetup";

if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({
  highlight: () => Promise.resolve(null),
  highlightCached: () => undefined,
}));

// The file menu reads the editor config through the preload bridge.
vi.mock("./FileRefMenu", () => ({ FileRefMenu: ({ children }: { children: unknown }) => children }));

import { AgentMarkdown } from "./AgentMarkdown";

afterEach(cleanup);

describe("AgentMarkdown prose", () => {
  it("reads at 14px on 22px lines by default and on 24px when compact", () => {
    const prose = render(<AgentMarkdown text="Hello" />);
    expect(prose.container.querySelector(".agent-markdown")?.className).toContain("text-sm");
    expect(prose.container.querySelector(".agent-markdown")?.className).toContain("leading-[22px]");
    prose.unmount();
    const compact = render(<AgentMarkdown text="Hello" size="compact" />);
    const cls = compact.container.querySelector(".agent-markdown")?.className ?? "";
    expect(cls).toContain("text-sm");
    expect(cls).toContain("leading-6");
  });

  it("a token longer than its column breaks instead of widening the transcript (a bare URL, a path)", () => {
    const view = render(<AgentMarkdown text="https://github.com/LandonDev/temp-code/blob/master/src/renderer/src/surfaces/threads/MasterView.tsx" />);
    const root = view.container.querySelector(".agent-markdown")!;
    expect(root.className).toContain("wrap-break-word");
    expect(root.className).toContain("min-w-0");
    expect(root.className).not.toMatch(/\bmin-w-(?!0\b)|\bw-max\b|whitespace-nowrap/);
  });

  it("inline code naming a file is a plain pill that opens the file", () => {
    const onOpenFile = vi.fn();
    const view = render(<AgentMarkdown text="See `src/lib/a.ts` here." cwd="/repo" onOpenFile={onOpenFile} />);
    const code = view.container.querySelector("code")!;
    expect(code.textContent).toBe("src/lib/a.ts");
    expect(code.getAttribute("role")).toBe("link");
    expect(code.querySelector("svg, img")).toBeNull();
    expect(code.className).toContain("bg-muted");
    fireEvent.click(code);
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/lib/a.ts", undefined, undefined);
  });

  it("plain inline code is not a link", () => {
    const view = render(<AgentMarkdown text="Run `bun test` now." cwd="/repo" onOpenFile={vi.fn()} />);
    const code = view.container.querySelector("code")!;
    expect(code.getAttribute("role")).toBeNull();
    expect(code.getAttribute("tabindex")).toBeNull();
  });

  it("a pill never splits into two halves: short code stays whole, long code wraps as whole pills", () => {
    const short = render(<AgentMarkdown text="Run `bun test cart` now." />);
    const pill = short.container.querySelector("code")!;
    expect(pill.className).toContain("box-decoration-clone");
    expect(pill.className).toContain("whitespace-nowrap");
    short.unmount();
    const long = render(<AgentMarkdown text={"See `" + "x".repeat(60) + "` there."} />);
    const wide = long.container.querySelector("code")!;
    expect(wide.className).toContain("box-decoration-clone");
    expect(wide.className).not.toContain("whitespace-nowrap");
  });

  it("draws inline code one pixel under its text, a 4px pill with 4px sides", () => {
    const view = render(<AgentMarkdown text="Run `bun test` now." />);
    const cls = view.container.querySelector("code")!.className;
    for (const c of ["text-[calc(1em-1px)]", "px-1", "py-px", "rounded-sm", "bg-muted"]) expect(cls.split(/\s+/)).toContain(c);
    expect(cls).not.toMatch(/\brounded-md\b|\bpx-1\.5\b|text-\[0\.875em\]/);
  });

  it("carries the hooks the stylesheet sets the rhythm by, and a plain fence has no header", () => {
    const text = [
      "# One", "", "Text.", "", "#### Four", "", "> quoted", "", "- a", "  - b", "", "1. c", "", "---", "",
      "```", "plain", "```", "", "```ts", "const a = 1;", "```", "",
    ].join("\n");
    const { container } = render(<AgentMarkdown text={text} />);
    for (const hook of ["heading-1", "heading-4", "blockquote", "unordered-list", "ordered-list", "list-item", "horizontal-rule"]) {
      expect(container.querySelector(`[data-streamdown="${hook}"]`), hook).not.toBeNull();
    }
    const blocks = [...container.querySelectorAll('[data-streamdown="code-block"]')];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelector('[data-streamdown="code-block-header"]')).toBeNull();
    expect(blocks[1].querySelector('[data-streamdown="code-block-header"]')?.textContent).toContain("ts");
  });

  it("a task list's items carry the class the stylesheet takes their bullet off by", () => {
    const { container } = render(<AgentMarkdown text={"- [ ] write it\n- [x] test it\n"} />);
    const items = [...container.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    for (const li of items) {
      expect(li.classList.contains("task-list-item")).toBe(true);
      expect(li.querySelector('input[type="checkbox"]')).not.toBeNull();
    }
    expect(container.querySelector("ul")?.classList.contains("contains-task-list")).toBe(true);
  });
});
