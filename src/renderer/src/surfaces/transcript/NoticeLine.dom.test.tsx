// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../../components/ui/button";
import type { Block } from "../../lib/session";
import { NoticeLine } from "./NoticeLine";
import { NoticeRow, PassRow } from "./NoticeRow";

afterEach(cleanup);

describe("NoticeLine", () => {
  it("sets each detail in its own span, with no separator glyphs", () => {
    const { container } = render(<NoticeLine lead="Context compacted" details={["48k → 12k", "6s"]} />);
    const spans = [...container.querySelectorAll('[data-slot="notice-line"] > div > div > span')].map((s) => s.textContent);
    expect(spans).toEqual(["Context compacted", "48k → 12k", "6s"]);
    expect(container.textContent).not.toMatch(/[·|•]/);
  });

  it("keeps actions in the hover group", () => {
    render(<NoticeLine lead="Reviewed" actions={<Button size="xs">Review thread</Button>} />);
    const actions = document.querySelector('[data-slot="notice-actions"]')!;
    expect(actions.className).toContain("group-hover/notice:opacity-100");
    expect(actions.className).toContain("opacity-0");
    expect(actions.contains(screen.getByRole("button", { name: "Review thread" }))).toBe(true);
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
});

describe("SystemRow", () => {
  it("a plain system block is one muted line", async () => {
    const { SystemRow } = await import("./SystemRow");
    const { container } = render(<SystemRow block={{ id: "s", role: "system", text: "Resumed after the host restarted at 3:41 PM" }} />);
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toBe("Resumed after the host restarted at 3:41 PM");
  });
});
