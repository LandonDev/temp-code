// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutSash } from "../lib/layout";
import { PaneDropHint, PaneHeader, Sash } from "./paneChrome";

afterEach(cleanup);

function header(focused = true) {
  const onClose = vi.fn();
  const onDragStart = vi.fn();
  const { container } = render(<PaneHeader title="Fix the sash" focused={focused} onClose={onClose} onDragStart={onDragStart} />);
  const root = container.querySelector<HTMLElement>("[data-pane-header]")!;
  return { root, onClose, onDragStart };
}

describe("PaneHeader", () => {
  it("shows the title and marks focus on the header", () => {
    const { root } = header(true);
    expect(screen.getByText("Fix the sash")).toBeTruthy();
    expect(root.dataset.focused).toBe("true");
    expect(root.className).toMatch(/\bbg-background\b/);
    cleanup();
    const other = header(false).root;
    expect(other.dataset.focused).toBe("false");
    expect(other.className).toMatch(/\bbg-sidebar\b/);
  });

  it("drags from anywhere on the header but not from Close", () => {
    const { root, onClose, onDragStart } = header();
    fireEvent.pointerDown(root, { button: 0 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    const close = screen.getByRole("button", { name: "Close pane" });
    fireEvent.pointerDown(close, { button: 0 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a secondary press", () => {
    const { root, onDragStart } = header();
    fireEvent.pointerDown(root, { button: 2 });
    expect(onDragStart).not.toHaveBeenCalled();
  });
});

function sash(dir: "right" | "down", onCommit = vi.fn(), onEqualize = vi.fn()) {
  const s = { splitId: "s", index: 0, dir, sizes: [0.5, 0.5], group: { x: 0, y: 0, w: 1, h: 1 } } as LayoutSash;
  render(<Sash sash={s} containerRef={{ current: null }} onPreview={() => {}} onCommit={onCommit} onCancel={() => {}} onEqualize={onEqualize} />);
  return { el: screen.getByRole("separator", { name: "Resize panes" }), onCommit, onEqualize };
}

describe("Sash", () => {
  it("is focusable and named", () => {
    const { el } = sash("right");
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("moves along its axis by a step, Shift by a big one", () => {
    const { el, onCommit } = sash("right");
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenLastCalledWith(0.52);
    fireEvent.keyDown(el, { key: "ArrowRight", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(0.6);
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenLastCalledWith(0.48);
    onCommit.mockClear();
    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a horizontal sash moves with the vertical arrows", () => {
    const { el, onCommit } = sash("down");
    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(onCommit).toHaveBeenLastCalledWith(0.52);
    fireEvent.keyDown(el, { key: "ArrowDown", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(0.6);
    onCommit.mockClear();
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a double-click makes the panes equal", () => {
    const { el, onEqualize } = sash("right");
    fireEvent.doubleClick(el);
    expect(onEqualize).toHaveBeenCalledTimes(1);
  });
});

describe("PaneDropHint", () => {
  it.each([
    ["left", ["left-0", "w-1/2"]],
    ["right", ["right-0", "w-1/2"]],
    ["top", ["top-0", "h-1/2"]],
    ["bottom", ["bottom-0", "h-1/2"]],
  ] as const)("covers the %s half, neutral", (edge, classes) => {
    const { container } = render(<PaneDropHint edge={edge} />);
    const hint = container.querySelector<HTMLElement>("[data-pane-drop-hint]")!;
    expect(hint.dataset.edge).toBe(edge);
    for (const c of classes) expect(hint.classList.contains(c)).toBe(true);
    expect(container.innerHTML).not.toMatch(/bg-accent/);
  });
});
