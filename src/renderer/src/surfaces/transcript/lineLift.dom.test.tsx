// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Collapsible, CollapsibleContent } from "../../components/ui/collapsible";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import type { Block } from "../../lib/session";
import { ActionGroup } from "./ActionGroup";
import { ActionLine } from "./ActionLine";
import { NoticeLine } from "./NoticeLine";
import { ActivityThinkingRow } from "./ThinkingRow";

/* TRANSCRIPT.md: hover lifts a line's verb and chevron to foreground at
   once; only the chevron's turn animates, and that turn is the one
   disclosure (`DISCLOSURE_CHEVRON`, `rotate-90`). */

afterEach(cleanup);

/** The class of the one svg under `root` that carries the disclosure recipe. */
const chevronOf = (root: HTMLElement) => {
  const svg = [...root.querySelectorAll("svg")].find((s) => (s.getAttribute("class") ?? "").includes(DISCLOSURE_CHEVRON));
  if (!svg) throw new Error("no disclosure chevron");
  return svg.getAttribute("class")!;
};
const noOwnTiming = (cls: string) => expect(cls).not.toMatch(/duration-\(--dur-(?:fast|hover)\)|transition-\[|transition-colors|rotate-180/);

describe("a transcript line lifts at once", () => {
  it("ActionLine: the verb carries no colour transition; the chevron is the one disclosure", () => {
    const Line = () => {
      const [open, setOpen] = useState(false);
      return <ActionLine glyph={<span />} verb="Ran" object="bun test" label="Ran bun test" open={open} onToggle={() => setOpen(!open)} />;
    };
    const { container } = render(<Line />);
    const verb = screen.getByText("Ran");
    expect(verb.closest("[class*='group-hover/action:text-foreground']")).not.toBeNull();
    let el: HTMLElement | null = verb;
    for (; el && el !== container; el = el.parentElement) expect(el.className).not.toMatch(/transition-\[color\]|transition-colors/);
    const chevron = chevronOf(container);
    noOwnTiming(chevron);
    expect(chevron).not.toContain("rotate-90");
    fireEvent.click(screen.getByRole("button", { name: "Ran bun test" }));
    expect(chevronOf(container)).toContain("rotate-90");
  });

  it("NoticeLine: the lead lifts with no transition; the chevron is the one disclosure", () => {
    const Fold = () => {
      const [open, setOpen] = useState(false);
      return (
        <Collapsible open={open} onOpenChange={setOpen}>
          <NoticeLine lead="Typecheck failed" fold={{ open, label: "Show the log" }}>
            <CollapsibleContent>the log</CollapsibleContent>
          </NoticeLine>
        </Collapsible>
      );
    };
    const { container } = render(<Fold />);
    const lead = screen.getByText("Typecheck failed");
    expect(lead.className).toContain("group-hover/notice:text-foreground");
    expect(lead.className).not.toMatch(/transition/);
    noOwnTiming(chevronOf(container));
  });

  it("ThinkingRow: the Thought chevron is the one disclosure", () => {
    const block: Block = { id: "r1", role: "reasoning", text: "Weighing it.", ts: 1, doneTs: 2 };
    const { container } = render(<ActivityThinkingRow block={block} expandable />);
    noOwnTiming(chevronOf(container));
    fireEvent.click(screen.getByRole("button", { name: "Thought" }));
    expect(chevronOf(container)).toContain("rotate-90");
  });

  it("ActionGroup: the group line's words step at once (no Button colour fade); its chevron is the one disclosure", () => {
    const tool = (id: string): Block => ({
      id,
      role: "tool",
      text: "Read",
      tool: { callId: id, name: "Read", title: "Read", status: "completed", input: { file_path: `/r/${id}.ts` }, kind: "read" },
    });
    const { container } = render(<ActionGroup blocks={[tool("a"), tool("b")]} cwd="/r" live={false} />);
    const line = container.querySelector<HTMLElement>("[data-group-line]")!;
    expect(line.className).toContain("transition-none");
    expect(line.className).not.toMatch(/transition-\[/);
    noOwnTiming(chevronOf(line));
  });
});
