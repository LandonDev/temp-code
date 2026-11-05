// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Go to Symbol's list: the arrows move the highlight, and a row the list
 * scrolls under a still pointer never takes it back (usePointerHighlight);
 * the highlight follows the pointer only once it moves.
 */

const symbols = Array.from({ length: 6 }, (_, i) => ({
  name: `symbol${i}`,
  kind: 11,
  uri: `file:///srv/app/src/file${i}.ts`,
  range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 2 },
}));

vi.mock("../surfaces/monaco/lsp/providers", () => ({
  workspaceSymbols: () => Promise.resolve(symbols),
}));

import { SymbolPicker } from "./SymbolPicker";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const selected = () => screen.getAllByRole("option").findIndex((row) => row.getAttribute("aria-selected") === "true");

async function mount() {
  vi.useFakeTimers();
  await act(async () => {
    render(<SymbolPicker projectId="p1" onOpen={vi.fn()} onClose={vi.fn()} />);
  });
  const field = screen.getByRole("textbox", { name: "Go to symbol" });
  fireEvent.change(field, { target: { value: "sym" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();
  await act(async () => {});
  return field;
}

describe("SymbolPicker", () => {
  it("keeps the keyboard's row when the list slides under a still pointer", async () => {
    const field = await mount();
    const list = screen.getByRole("listbox", { name: "Symbols" });
    const rows = () => screen.getAllByRole("option");
    // The pointer moves onto row 2: it takes the highlight.
    fireEvent.mouseMove(list, { clientX: 20, clientY: 70 });
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(2);
    // Two arrows down; the list scrolls and row 2 meets the still pointer again.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(selected()).toBe(4);
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(4);
    // A move at the same point is no move.
    fireEvent.mouseMove(list, { clientX: 20, clientY: 70 });
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(4);
    // A real move does: the browser sends the row's enter first, then the move over it.
    fireEvent.mouseEnter(rows()[1]);
    expect(selected()).toBe(4);
    fireEvent.mouseMove(rows()[1], { clientX: 22, clientY: 74 });
    expect(selected()).toBe(1);
    // Once armed, the next row the pointer enters takes the highlight.
    fireEvent.mouseEnter(rows()[3]);
    fireEvent.mouseMove(rows()[3], { clientX: 22, clientY: 90 });
    expect(selected()).toBe(3);
  });

  it("draws its rows in a menu row's box and its empty line as one muted row", async () => {
    await mount();
    const row = screen.getAllByRole("option")[0];
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-7", "gap-2", "px-3", "text-[13px]", "rounded-xl"]));
    cleanup();
    await act(async () => {
      render(<SymbolPicker projectId={null} onOpen={vi.fn()} onClose={vi.fn()} />);
    });
    const note = screen.getByText("Open a project to search symbols");
    expect(note.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-7", "px-3", "text-[13px]", "text-muted-foreground"]));
  });
});
