// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JumpList, type JumpGroup } from "./JumpList";

afterEach(cleanup);

const groups: JumpGroup[] = [
  {
    label: "Yesterday",
    items: [
      { key: "a", label: "First ask", trailing: "9:00 AM" },
      { key: "b", label: "Second ask", trailing: "9:30 AM" },
    ],
  },
  { label: "Today", items: [{ key: "c", label: "Third ask", trailing: "2:32 PM" }] },
];

const rows = () => screen.getAllByRole("button");
const row = (name: RegExp) => screen.getByRole("button", { name });

describe("JumpList", () => {
  it("is a nav of rows with their trailing times and day headings", () => {
    render(<JumpList label="Your messages" groups={groups} active="b" onJump={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Your messages" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Yesterday" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Today" })).toBeTruthy();
    expect(row(/Third ask/).textContent).toBe("Third ask2:32 PM");
  });

  it("marks the row being read by colour alone, with aria-current", () => {
    render(<JumpList label="L" groups={groups} active="b" onJump={() => {}} />);
    const current = row(/Second ask/);
    expect(current.getAttribute("aria-current")).toBe("location");
    expect(current.className).toContain("text-foreground");
    expect(row(/First ask/).getAttribute("aria-current")).toBeNull();
    expect(row(/First ask/).className).toContain("text-muted-foreground");
    expect(current.className).not.toMatch(/font-medium|font-semibold|bg-muted|border-l/);
  });

  it("has one tab stop: the row being read", () => {
    render(<JumpList label="L" groups={groups} active="b" onJump={() => {}} />);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("falls back to the first row when nothing is being read", () => {
    render(<JumpList label="L" groups={groups} active={null} onJump={() => {}} />);
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves focus with the arrows and Home/End, and the tab stop follows", () => {
    render(<JumpList label="L" groups={groups} active="a" onJump={() => {}} />);
    row(/First ask/).focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(/Second ask/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(/Third ask/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(/Third ask/));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(row(/First ask/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(row(/First ask/));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(row(/Third ask/));
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("jumps on Enter and Space as a key, on a click as the pointer", () => {
    const onJump = vi.fn();
    render(<JumpList label="L" groups={groups} active="a" onJump={onJump} />);
    fireEvent.keyDown(row(/Second ask/), { key: "Enter" });
    fireEvent.keyDown(row(/Third ask/), { key: " " });
    fireEvent.click(row(/First ask/));
    expect(onJump.mock.calls).toEqual([
      ["b", "key"],
      ["c", "key"],
      ["a", "pointer"],
    ]);
  });

  it("keeps the row being read in its own view, but not while hovered", () => {
    const { rerender } = render(<JumpList label="L" groups={groups} active="a" onJump={() => {}} />);
    const nav = screen.getByRole("navigation");
    Object.defineProperty(nav, "clientHeight", { value: 56, configurable: true });
    const third = row(/Third ask/);
    Object.defineProperty(third, "offsetTop", { value: 88, configurable: true });
    Object.defineProperty(third, "offsetHeight", { value: 28, configurable: true });
    fireEvent.pointerEnter(nav);
    rerender(<JumpList label="L" groups={groups} active="c" onJump={() => {}} />);
    expect(nav.scrollTop).toBe(0);
    fireEvent.pointerLeave(nav);
    rerender(<JumpList label="L" groups={groups} active="b" onJump={() => {}} />);
    rerender(<JumpList label="L" groups={groups} active="c" onJump={() => {}} />);
    expect(nav.scrollTop).toBe(88 + 28 - 56);
  });

  it("puts no motion on a row beyond the button's own press", () => {
    render(<JumpList label="L" groups={groups} active="a" onJump={() => {}} />);
    // The button's own motion: the hover fill over --dur-hover, the press over --dur-fast.
    const own = /^(transition-\[background-color,color,border-color,scale\]|motion-reduce:transition-none|duration-\(--dur-hover\)|(active:not-aria-\[haspopup\]:|data-pressed:)?duration-\(--dur-fast\)|ease-\(--ease-out\))$/;
    for (const r of rows()) {
      for (const cls of r.classList) {
        expect(cls).not.toMatch(/^animate-|z-fade/);
        if (/transition|duration-|ease-/.test(cls)) expect(cls).toMatch(own);
      }
    }
  });

  it("renders its head row above the groups", () => {
    render(
      <JumpList label="L" groups={groups} active="a" onJump={() => {}} head={<button type="button">Earlier messages</button>} />,
    );
    expect(rows()[0].textContent).toBe("Earlier messages");
  });
});
