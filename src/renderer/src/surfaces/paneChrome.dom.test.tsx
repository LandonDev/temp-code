// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneHeader } from "./paneChrome";

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
