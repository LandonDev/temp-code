// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Collapsible } from "../../components/ui/collapsible";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../../components/ui/button";
import type { Block } from "../../lib/session";
import { NoticeLine } from "./NoticeLine";
import { NoticeRow, PassRow } from "./NoticeRow";
import { STEP_NOTICE, StepRowContext } from "./stepLine";

afterEach(cleanup);

describe("NoticeLine", () => {
  it("sets the lead in medium and its details as one muted comma run, so a cut line ends in one ellipsis", () => {
    const { container } = render(<NoticeLine lead="Context compacted" details={["48k → 12k", "6s"]} />);
    const spans = [...container.querySelectorAll<HTMLElement>('[data-slot="notice-line"] > div > div > span')];
    expect(spans.map((s) => s.textContent)).toEqual(["Context compacted", "48k → 12k, 6s"]);
    const [lead, run] = spans;
    expect(lead.className).toContain("font-medium");
    expect(lead.className).toContain("text-muted-foreground");
    expect(run.dataset.slot).toBe("notice-details");
    expect(run.className).toContain("text-muted-foreground");
    expect(run.className).toContain("truncate");
    expect(run.className).not.toContain("font-medium");
    expect(container.textContent).not.toMatch(/[·|•]/);
  });

  it("takes no comma after a detail that ends its own phrase", () => {
    const { container } = render(<NoticeLine lead="Answered" details={["Backfill the old rows?", "Yes"]} />);
    expect(container.querySelector('[data-slot="notice-details"]')!.textContent).toBe("Backfill the old rows? Yes");
  });

  it("a lone lead, or a sentence, stays regular", () => {
    const { container } = render(
      <>
        <NoticeLine lead="Checked background tasks" />
        <NoticeLine lead="Account me@x.dev is gone from this host" wrap />
      </>,
    );
    for (const line of container.querySelectorAll('[data-slot="notice-line"]')) {
      expect(line.querySelector("div > div > span")!.className).not.toContain("font-medium");
    }
  });

  it("is the action rows' size: 13px on a 20px line in a 28px row", () => {
    const { container } = render(<NoticeLine lead="Pass" />);
    const line = container.querySelector('[data-slot="notice-line"]')!;
    expect(line.className).toContain("text-[13px]");
    expect(line.className).toContain("leading-5");
    expect(line.firstElementChild!.className).toContain("min-h-7");
  });

  it("a line that opens is its own trigger, with a bare chevron", () => {
    const Fold = () => {
      const [open, setOpen] = useState(false);
      return (
        <Collapsible open={open} onOpenChange={setOpen}>
          <NoticeLine lead="Typecheck failed" fold={{ open, label: open ? "Hide the log" : "Show the log" }}>
            the log
          </NoticeLine>
        </Collapsible>
      );
    };
    const { container } = render(<Fold />);
    const trigger = screen.getByRole("button", { name: "Show the log" });
    expect(trigger.className).toContain("absolute inset-0");
    // A button: index.css draws its one ring; nothing draws a second.
    expect(trigger.className).not.toMatch(/focus-visible:ring/);
    expect(trigger.getAttribute("data-slot")).not.toBe("button");
    expect(container.querySelectorAll("button").length).toBe(1);
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Hide the log" }).getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("the log");
  });

  it("sizes only its own glyph, never a StatusMark's inside it", () => {
    const { container } = render(<NoticeLine lead="Gate" glyph={<svg data-testid="glyph" />} />);
    const slot = container.querySelector('[data-testid="glyph"]')?.parentElement;
    expect(slot?.className).toContain("[&>svg]:size-3.5");
    expect(slot?.className).not.toContain("[&_svg]");
  });

  it("keeps actions in the hover group", () => {
    render(<NoticeLine lead="Reviewed" actions={<Button size="xs">Review thread</Button>} />);
    const actions = document.querySelector('[data-slot="notice-actions"]')!;
    expect(actions.className).toContain("group-hover/notice:opacity-100");
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("group-hover/notice:delay-(--delay-hover)");
    expect(actions.className).toContain("has-focus-visible:delay-(--dur-instant)");
    expect(actions.className).toContain("has-aria-expanded:opacity-100");
    expect(actions.className).not.toContain("focus-within:");
    expect(actions.contains(screen.getByRole("button", { name: "Review thread" }))).toBe(true);
  });
});

describe("NoticeLine as a step of a run", () => {
  const spans = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-slot="notice-line"] > div > div > span')];

  it("outside a run, a strong line sets its lead in foreground", () => {
    const { container } = render(<NoticeLine lead="Gate failed" tone="strong" details={["port-the-view", "at vitest"]} />);
    const [lead, branch] = spans(container);
    expect(lead.className).toContain("text-foreground");
    expect(lead.className).not.toContain("text-muted-foreground");
    expect(branch.className).toContain("text-muted-foreground");
  });

  it("folded into a run, reads verb then target: the lead muted, the first detail in foreground, the rest muted", () => {
    const { container } = render(
      <StepRowContext.Provider value>
        <NoticeLine lead="Gate failed" tone="strong" details={["port-the-view", "at vitest"]} />
      </StepRowContext.Provider>,
    );
    const [lead, branch, rest] = spans(container);
    expect(lead.className).toContain("text-muted-foreground");
    // A call's verb: regular, as an action row's.
    expect(lead.className).not.toContain("font-medium");
    expect(branch.className).toContain("text-foreground");
    expect(branch.className).not.toContain("text-muted-foreground");
    expect(rest.className).toContain("text-muted-foreground");
  });

  it("sits on the step grid, 26px hung", () => {
    const { container } = render(<NoticeLine lead="Pass" />);
    const line = container.querySelector('[data-slot="notice-line"]')!.firstElementChild!;
    for (const c of STEP_NOTICE.split(" ")) expect(line.className.split(" ")).toContain(c);
  });

  it("a closed fold draws nothing under its line", () => {
    const Fold = ({ start }: { start: boolean }) => {
      const [open, setOpen] = useState(start);
      return (
        <div data-table="">
          <Collapsible open={open} onOpenChange={setOpen}>
            <NoticeLine lead="Gate failed" fold={{ open, label: open ? "Hide the log" : "Show the log" }}>
              the log
            </NoticeLine>
          </Collapsible>
        </div>
      );
    };
    const { container } = render(<Fold start={false} />);
    // No wrapper while closed: in a table its hairline and padding would draw a blank ruled band.
    expect(container.querySelector('[data-slot="notice-body"]')).toBeNull();
    expect(container.querySelector('[data-slot="notice-line"]')!.children).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show the log" }));
    const body = container.querySelector<HTMLElement>('[data-slot="notice-body"]')!;
    expect(body.textContent).toBe("the log");
    expect(body.className).toContain("in-data-[table]:border-t");
  });

  it("what opens under a step's line reads as a notice again", () => {
    const { container } = render(
      <StepRowContext.Provider value>
        <NoticeLine lead="Review held" details={["main"]}>
          <NoticeLine lead="Finding" details={["a.ts:4"]} />
        </NoticeLine>
      </StepRowContext.Provider>,
    );
    const inner = container.querySelectorAll('[data-slot="notice-line"]')[1]!;
    const detail = inner.querySelectorAll<HTMLElement>(":scope > div > div > span")[1]!;
    expect(detail.className).toContain("text-muted-foreground");
  });
});

describe("NoticeRow", () => {
  const system = (over: Partial<Block>): Block => ({ id: "n", role: "system", text: "", ...over });

  it("a pass reads Pass and its actions, no dots", () => {
    const { container } = render(<PassRow actions={["Notes", "Review"]} />);
    expect(container.textContent).toBe("PassNotes, Review");
  });

  it("draws the batch's merge and end typed", () => {
    const merged = render(<NoticeRow block={system({ text: "Merged by the batch: a → master at 0123456789", notice: { kind: "batch" } })} />);
    expect(merged.container.textContent).toBe("Merged by the batch" + "a → master at 0123456789");
    merged.unmount();
    const done = render(<NoticeRow block={system({ text: "Batch done: 3 landed", notice: { kind: "batch" } })} />);
    expect(done.container.querySelector('[data-state="done"]')).not.toBeNull();
    expect(done.container.textContent).toBe("Batch done3 landed");
  });

  it("an account gone is one line with the host's words", () => {
    const text = "Account me@x.dev is gone from this host; routing automatically from here";
    const { container } = render(<NoticeRow block={system({ text, notice: { kind: "account-gone" } })} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
  });
  it("an away notice is one line of the host's words; a question and an approval lead with their still glyph, a decision with none", () => {
    const line = (kind: "decision" | "question" | "approval", text: string) => {
      const { container } = render(<NoticeRow block={system({ text, notice: { kind: "away", away: { kind, text } } })} />);
      const notice = container.querySelector<HTMLElement>('[data-slot="notice-line"]')!;
      expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
      expect(notice.textContent).toBe(text);
      expect(notice.dataset.away).toBe(kind);
      return notice.querySelector("svg");
    };
    expect(line("decision", "Decided without asking: kept the old schema")).toBeNull();
    const question = line("question", "Answered for you: Tabs or spaces?");
    const approval = line("approval", "Skipped while away: Run bun test");
    expect(question).not.toBeNull();
    expect(approval).not.toBeNull();
    expect(question!.outerHTML).not.toBe(approval!.outerHTML);
    // Still and muted: the glyph slot's tone, no status colour, no spinner.
    expect(question!.closest("span")!.className).toContain("text-muted-foreground");
    expect(question!.getAttribute("class") ?? "").not.toMatch(/text-(warning|destructive)/);
  });
  it("a review's line arrives with the diff chunk, holding a line's height until then", async () => {
    const review = {
      runId: "run1", reviewerId: "rev1", provider: "codex", model: "gpt-6.1-sol", outcome: "pass",
      branch: "feature", target: "master", blocking: [], minor: [], merged: true, pushed: true,
    } as NonNullable<Block["review"]>;
    const { container } = render(<NoticeRow block={system({ review })} />);
    await waitFor(() => expect(container.textContent).toContain("Reviewed by"));
    expect(container.querySelector('[data-slot="review-wait"]')).toBeNull();
  });
  it("a plan's build that did not start is one line: the failed mark, the words and the host's reason", () => {
    const text = "The build did not start: refused: the project is moving";
    const { container } = render(<NoticeRow block={system({ text, notice: { kind: "plan-build" } })} />);
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
    expect(container.textContent).toContain("The build did not start");
    expect(container.textContent).toContain("refused: the project is moving");
  });
});

describe("SystemRow", () => {
  it("a plain system block is one muted line", async () => {
    const { SystemRow } = await import("./SystemRow");
    const { container } = render(<SystemRow block={{ id: "s", role: "system", text: "Resumed after the host restarted at 3:41 PM" }} />);
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toBe("Resumed after the host restarted at 3:41 PM");
  });

describe("NoticeLine in a narrow pane", () => {
  it("the details shrink as one run; a trailing status never does", () => {
    const { container } = render(
      <NoticeLine lead="Started the build" details={["A very long build title that fills the pane", "second"]} trailing={<span>Working</span>} />,
    );
    const spans = [...container.querySelectorAll('[data-slot="notice-line"] > div > div > span')];
    expect(spans).toHaveLength(3);
    expect(spans[1].textContent).toBe("A very long build title that fills the pane, second");
    expect(spans[1].className).toContain("truncate");
    expect(spans[2].textContent).toBe("Working");
    expect(spans[2].className).toContain("shrink-0");
  });

  it("a wrapping line's details wrap instead of truncating", () => {
    const { container } = render(<NoticeLine lead="Failed" wrap details={["x ".repeat(200)]} />);
    const message = [...container.querySelectorAll('[data-slot="notice-line"] > div > div > span')][1];
    expect(message.className).not.toContain("truncate");
  });
});
});
