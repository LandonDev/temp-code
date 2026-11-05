// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadListPopover, type ListedThread } from "./ThreadListPopover";

afterEach(cleanup);

const now = Date.now();
const threads: ListedThread[] = [
  { id: "a", title: "Fix the rail", type: "implementation", updatedAt: now - 5 * 60_000 },
  { id: "b", title: "Plan the dock", type: "planning", updatedAt: now - 3 * 3_600_000 },
];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-listed="${id}"]`)!;

describe("ThreadListPopover", () => {
  it("puts each row's age at its end in tabular-nums, on the row's one line", () => {
    render(<ThreadListPopover heading="Recent" threads={threads} onPick={() => {}} />);
    const age = row("a").querySelector<HTMLElement>("[data-listed-age]")!;
    expect(age.textContent).toMatch(/5m/);
    expect(age.className).toContain("tabular-nums");
    // At the row's end, outside the title's column: no second line under the title.
    expect(age.closest('[data-slot="item-content"]')).toBeNull();
    expect(age.closest('[data-slot="item-actions"]')!.className).toContain("text-[12px]");
    expect(row("a").querySelector('[data-slot="item-description"]')).toBeNull();
    // A recent row has no Restore, and its age never fades.
    expect(row("a").querySelector("[data-listed-restore]")).toBeNull();
    expect(age.className).not.toContain("group-hover/item:opacity-0");
  });

  it("in the archived list Restore takes the age's place on hover, in the same cell", () => {
    const onPick = vi.fn();
    render(<ThreadListPopover heading="Archived" threads={threads} restore onPick={onPick} />);
    const age = row("b").querySelector<HTMLElement>("[data-listed-age]")!;
    const restore = row("b").querySelector<HTMLElement>("[data-listed-restore]")!;
    expect(restore.textContent).toBe("Restore");
    expect(age.parentElement).toBe(restore.parentElement);
    for (const el of [age, restore]) expect(el.className).toContain("[grid-area:1/1]");
    // Restore waits at rest; on hover or keyboard focus it shows as the age leaves, after the hover delay.
    expect(restore.className.split(/\s+/)).toEqual(expect.arrayContaining(["opacity-0", "group-hover/item:opacity-100", "group-focus-visible/item:opacity-100", "group-hover/item:delay-(--delay-hover)"]));
    expect(age.className.split(/\s+/)).toEqual(expect.arrayContaining(["group-hover/item:opacity-0", "group-focus-visible/item:opacity-0", "group-hover/item:delay-(--delay-hover)"]));
    fireEvent.click(row("b"));
    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("rows are 28px lines", () => {
    render(<ThreadListPopover heading="Recent" threads={threads} onPick={() => {}} />);
    expect(row("a").className.split(/\s+/)).toContain("py-1");
  });

  it("filters past six threads, and says so in one muted row", () => {
    const many = Array.from({ length: 7 }, (_, i): ListedThread => ({ id: `t${i}`, title: `Thread ${i}`, type: "chat", updatedAt: now - i * 60_000 }));
    render(<ThreadListPopover heading="Recent" threads={many} onPick={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search recent threads" }), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
