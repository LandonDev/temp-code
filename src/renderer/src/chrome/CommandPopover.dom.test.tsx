// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../lib/fs";
import { CommandPopover, type PopoverMatches } from "./CommandPopover";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const file = (path: string): ProjectFile => ({ path, relative: path, name: path.split("/").pop()! });
const props = { active: 0, projectId: null, projects: [], onActive: vi.fn(), onAccept: vi.fn() };

describe("CommandPopover", () => {
  it("opens with no motion and swaps modes in place: it answers a keystroke", () => {
    const at: PopoverMatches = { mode: "file", rows: [{ kind: "file", file: file("src/a.ts") }] };
    const { container, rerender } = render(<CommandPopover matches={at} {...props} />);
    const list = container.querySelector<HTMLElement>("[data-command-popover]")!;
    expect(list.getAttribute("style")).toBeNull();
    rerender(<CommandPopover matches={{ mode: "command", rows: [] }} {...props} />);
    expect(container.querySelector("[data-command-popover]")).toBeNull();
    rerender(<CommandPopover matches={at} {...props} />);
    rerender(<CommandPopover matches={{ ...at, rows: [...at.rows, { kind: "file", file: file("src/b.ts") }] }} {...props} />);
    expect(container.querySelectorAll("[data-command-popover]")).toHaveLength(1);
  });
});
