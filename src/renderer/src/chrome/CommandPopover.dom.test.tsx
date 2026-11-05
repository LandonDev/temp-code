// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../lib/fs";
import type { SessionMeta } from "../lib/tcserver/types";
import { MENU_ROW } from "../components/ui/menu-row";
import { CommandPopover, type PopoverMatches } from "./CommandPopover";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const file = (path: string): ProjectFile => ({ path, relative: path, name: path.split("/").pop()! });
const props = { active: 0, projectId: null, projects: [], onActive: vi.fn(), onAccept: vi.fn() };

describe("CommandPopover", () => {
  it("enters on @starting-style and leaves on data-ending-style, inert, until its fade ends", () => {
    const at: PopoverMatches = { mode: "file", rows: [{ kind: "file", file: file("src/a.ts") }] };
    const { container, rerender } = render(<CommandPopover matches={at} {...props} />);
    const frame = container.querySelector<HTMLElement>("[data-command-popover]")!;
    const classes = frame.className.split(/\s+/);
    for (const c of ["starting:opacity-0", "starting:translate-y-1", "data-ending-style:opacity-0", "data-ending-style:translate-y-px", "data-ending-style:duration-(--dur-fast)", "data-ending-style:ease-(--ease-exit)", "motion-reduce:transition-opacity"])
      expect(classes).toContain(c);
    expect(classes.some((c) => /animate-|fade-in|slide-in/.test(c))).toBe(false);
    expect(frame.hasAttribute("data-ending-style")).toBe(false);
    // Closing keeps the last rows on screen while they fade, inert.
    rerender(<CommandPopover matches={null} {...props} />);
    const leaving = container.querySelector<HTMLElement>("[data-command-popover]")!;
    expect(leaving).toBe(frame);
    expect(leaving.hasAttribute("data-ending-style")).toBe(true);
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(leaving.textContent).toContain("a.ts");
    fireEvent.transitionEnd(leaving, { propertyName: "opacity" });
    expect(container.querySelector("[data-command-popover]")).toBeNull();
  });

  it("no match is one muted row, a menu row's box, and it stays open rather than vanishing", () => {
    const at: PopoverMatches = { mode: "file", rows: [{ kind: "file", file: file("src/a.ts") }] };
    const { container, rerender } = render(<CommandPopover matches={at} {...props} />);
    const frame = container.querySelector<HTMLElement>("[data-command-popover]")!;
    rerender(<CommandPopover matches={{ mode: "command", rows: [] }} {...props} />);
    expect(container.querySelector("[data-command-popover]")).toBe(frame);
    expect(frame.hasAttribute("data-ending-style")).toBe(false);
    const rows = container.querySelectorAll("[role=option]");
    expect(rows).toHaveLength(1);
    const empty = rows[0] as HTMLElement;
    expect(empty.textContent).toBe("No matches");
    expect(empty.getAttribute("aria-disabled")).toBe("true");
    for (const c of [...MENU_ROW.split(" "), "text-muted-foreground"]) expect(empty.className.split(" ")).toContain(c);
  });

  it("the `/` menu reads Loading… until the host's commands land, and says a failed list rather than No matches", () => {
    const { container, rerender } = render(<CommandPopover matches={{ mode: "command", rows: [], loading: true }} {...props} />);
    const empty = () => container.querySelector<HTMLElement>("[data-command-empty]")!;
    expect(empty().textContent).toBe("Loading…");
    expect(empty().className).toContain("text-muted-foreground");
    rerender(<CommandPopover matches={{ mode: "command", rows: [], loading: false }} {...props} />);
    expect(empty().textContent).toBe("No matches");
    rerender(<CommandPopover matches={{ mode: "command", rows: [], loading: false, failed: true }} {...props} />);
    expect(empty().textContent).toBe("Couldn't load commands");
    expect(empty().className).toContain("text-destructive");
  });

  it("reads Loading… while the project's files are on their way and nothing else matches", () => {
    const { container, rerender } = render(<CommandPopover matches={{ mode: "file", rows: [], loading: true }} {...props} />);
    expect(container.querySelector("[data-command-empty]")!.textContent).toBe("Loading…");
    rerender(<CommandPopover matches={{ mode: "file", rows: [], loading: false }} {...props} />);
    expect(container.querySelector("[data-command-empty]")!.textContent).toBe("No matches");
    // A thread that matches while the files load is a row, not the loading line.
    const thread = { kind: "thread", session: { id: "t", title: "t", status: "idle", projectId: null, updatedAt: 1 } as SessionMeta } as const;
    rerender(<CommandPopover matches={{ mode: "file", rows: [thread], loading: true }} {...props} />);
    expect(container.querySelector("[data-command-empty]")).toBeNull();
  });

  it("turns around when it reopens mid-exit, and is gone after twice its exit when no fade ends", () => {
    vi.useFakeTimers();
    try {
      const at: PopoverMatches = { mode: "file", rows: [{ kind: "file", file: file("src/a.ts") }] };
      const { container, rerender } = render(<CommandPopover matches={at} {...props} />);
      const frame = container.querySelector<HTMLElement>("[data-command-popover]")!;
      rerender(<CommandPopover matches={null} {...props} />);
      rerender(<CommandPopover matches={at} {...props} />);
      expect(container.querySelector("[data-command-popover]")).toBe(frame);
      expect(frame.hasAttribute("data-ending-style")).toBe(false);
      expect(frame.hasAttribute("inert")).toBe(false);
      rerender(<CommandPopover matches={null} {...props} />);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelector("[data-command-popover]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a row's element as the filter narrows, and its frame's height follows the list", () => {
    const cmd = (name: string): PopoverMatches["rows"][number] => ({ name, scope: "user", source: "skill", description: "" }) as never;
    const wide: PopoverMatches = { mode: "command", rows: [cmd("alpha"), cmd("beta"), cmd("gamma")] };
    const { container, rerender } = render(<CommandPopover matches={wide} {...props} />);
    const gamma = [...container.querySelectorAll("[role=option]")].find((r) => r.textContent?.includes("gamma"));
    rerender(<CommandPopover matches={{ mode: "command", rows: [cmd("gamma")] }} {...props} />);
    const after = container.querySelector("[role=option]");
    expect(after).toBe(gamma);
    const frame = container.querySelector<HTMLElement>("[data-command-popover]")!;
    // jsdom lays nothing out: an unmeasured list leaves the frame its natural height.
    expect(frame.style.height).toBe("");
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(64);
    rerender(<CommandPopover matches={{ mode: "command", rows: [cmd("alpha"), cmd("gamma")] }} {...props} />);
    expect(frame.style.height).toBe("64px");
    vi.restoreAllMocks();
    expect(frame.className).toContain("transition-[opacity,translate,height]");
  });

  it("marks a thread row with its live status, and gives a settled one the thread glyph", () => {
    const thread = (id: string, status: SessionMeta["status"]) =>
      ({ kind: "thread", session: { id, title: id, status, projectId: null, updatedAt: 1 } as SessionMeta }) as const;
    const at: PopoverMatches = { mode: "file", rows: [thread("a", "paused"), thread("b", "running"), thread("c", "idle")] };
    const { container } = render(<CommandPopover matches={at} {...props} />);
    const marks = [...container.querySelectorAll('[data-slot="status-mark"]')].map((m) => m.getAttribute("data-state"));
    expect(marks).toEqual(["paused", "working"]);
  });

  it("draws its rows as a menu's, 8px radius inside the 12px popover, on the hairline ring", () => {
    const at: PopoverMatches = { mode: "file", rows: [{ kind: "file", file: file("src/a.ts") }] };
    const { container } = render(<CommandPopover matches={at} {...props} />);
    const root = container.querySelector<HTMLElement>("[data-command-popover]")!;
    expect(root.className).toContain("ring-1");
    expect(root.className.split(/\s+/)).not.toContain("border");
    const row = container.querySelector<HTMLElement>("[role=option]")!;
    for (const c of MENU_ROW.split(" ")) expect(row.className).toContain(c);
    expect(row.className).toContain("rounded-lg");
  });
});
