// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_RENDER_MAX_HEIGHT, htmlRenderFrameHeight, HTML_RENDER_COLUMN_WIDTH } from "@shared/htmlRender";
import type { Block } from "../../lib/session";

vi.mock("../../lib/copyMessage", () => ({ copyUserMessage: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));

import { CopyMessageButton } from "../CopyMessageButton";
import { CommandChip, ConnectorMark } from "../ToolChips";
import { ToolDetails } from "../ToolDetails";
import { CommandCard } from "./CommandCard";
import { HtmlPagePlaceholder } from "./TranscriptBlock";

afterEach(cleanup);

const call = (name: string, input: unknown, detail?: string): Block => ({
  id: `b-${name}`,
  role: "tool",
  text: name,
  tool: { callId: `c-${name}`, title: name, status: "completed", name, input, detail },
});

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(" ");

describe("a row body's code ladder: 12px mono on 20px lines", () => {
  it("a command and what it printed", () => {
    const { container } = render(<CommandCard block={call("Bash", { command: "npm test" }, "12 passed")} failed={false} />);
    const [command, output] = container.querySelectorAll("pre");
    expect(classes(command)).toEqual(expect.arrayContaining(["font-mono", "text-xs", "leading-5"]));
    expect(classes(command)).not.toContain("text-[13px]");
    expect(classes(output)).toEqual(expect.arrayContaining(["font-mono", "text-xs", "leading-5"]));
  });

  it("a tool's invocation and its output", () => {
    const { container } = render(<ToolDetails block={call("Grep", { pattern: "TODO", path: "src" }, "src/a.ts:1: TODO")} />);
    const [invocation, output] = container.querySelectorAll("pre");
    expect(classes(invocation)).toEqual(expect.arrayContaining(["font-mono", "text-xs", "leading-5"]));
    expect(classes(output)).toEqual(expect.arrayContaining(["font-mono", "text-xs", "leading-5"]));
  });
});

describe("HtmlPagePlaceholder", () => {
  const reference = {
    sessionId: "sess",
    pageId: "page1234567890ab",
    title: "Chart",
    height: HTML_RENDER_MAX_HEIGHT,
    heights: [
      [320, 500],
      [864, 410],
    ] as const,
  };

  it("holds the frame's reserved height, full width, one rounded-lg block with no padding", () => {
    const { container } = render(<HtmlPagePlaceholder reference={reference} />);
    const box = container.querySelector<HTMLElement>("[data-page-placeholder]")!;
    expect(box.getAttribute("role")).toBe("status");
    expect(box.style.height).toBe(`${htmlRenderFrameHeight(reference, HTML_RENDER_COLUMN_WIDTH)}px`);
    expect(classes(box)).toEqual(expect.arrayContaining(["my-1", "w-full"]));
    expect(box.className).not.toMatch(/\bp-\d/);
    const block = box.querySelector('[data-slot="skeleton"]')!;
    expect(classes(block)).toEqual(expect.arrayContaining(["size-full", "rounded-lg"]));
    expect(classes(block)).not.toContain("rounded-xl");
  });
});

describe("chips inside rows", () => {
  it("a command in a bubble is the inline code pill", () => {
    const { container } = render(<CommandChip command={{ name: "review", source: "builtin" } as never} />);
    const chip = container.firstElementChild!;
    expect(classes(chip)).toEqual(expect.arrayContaining(["rounded-sm", "bg-muted", "px-1", "text-[calc(1em-1px)]"]));
    expect(chip.className).not.toMatch(/rounded-md|bg-foreground\/10|text-\[13px\]/);
  });

  it("a connector's mark is a 14px icon", () => {
    // A brand the app knows draws at width 14; an unknown one is the plug glyph sized by style.
    const known = render(<ConnectorMark app="linear" />);
    expect(known.container.querySelector("svg, img")?.getAttribute("width")).toBe("14");
    known.unmount();
    const unknown = render(<ConnectorMark app="some-unknown-server" />);
    expect(unknown.container.querySelector<SVGElement>("svg")?.style.width).toBe("14px");
  });
});

describe("CopyMessageButton", () => {
  it("reveals with the out curve, keeps its fade under reduced motion, at the 1.5 stroke", () => {
    const { container } = render(<CopyMessageButton text="hi" attachments={[]} />);
    const reveal = container.querySelector("button")!.parentElement;
    expect(classes(reveal)).toEqual(expect.arrayContaining(["transition-opacity", "duration-(--dur-fast)", "ease-(--ease-out)", "motion-reduce:transition-opacity"]));
    const strokes = [...container.querySelectorAll("svg")].map((svg) => svg.getAttribute("stroke-width"));
    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(new Set(["1.5"]));
  });
});
