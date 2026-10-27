// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDockSize } from "../lib/projectTerminal";
import { DockFrame } from "./DockFrame";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Dock() {
  const [size, setSize] = useState(300);
  return <DockFrame size={size} focused label="Resize terminal" onFocus={() => {}} onSizePaint={() => {}} onSizeCommit={setSize}>Terminal</DockFrame>;
}

describe("DockFrame sash", () => {
  it("is focusable, moves up by 2% or Shift 10%, and resets on double-click", () => {
    vi.stubGlobal("innerHeight", 800);
    const { container } = render(<Dock />);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ height: 1000 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.className).toContain("focus-visible:bg-accent");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(defaultDockSize("bottom")));
  });
});
