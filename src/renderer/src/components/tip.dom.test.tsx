import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TruncateTip } from "./tip";
import { tooltipChunk, warmTooltips } from "./ui/tooltip";

beforeAll(async () => {
  await act(async () => { await tooltipChunk.load(); warmTooltips(); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("TruncateTip", () => {
  it("mounts no tooltip trigger while the words fit, then responds to a resize in either direction", () => {
    let width = 80;
    const observers = new Set<() => void>();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) { observers.add(callback); }
      observe() {}
      disconnect() { observers.delete(this.callback); }
    });
    const { container } = render(<TruncateTip text="a title"><span className="truncate">a title</span></TruncateTip>);
    const trigger = () => container.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger()).toBeNull();
    act(() => { width = 140; [...observers].forEach((notify) => notify()); });
    expect(trigger()).not.toBeNull();
    act(() => { width = 80; [...observers].forEach((notify) => notify()); });
    expect(trigger()).toBeNull();
  });

  it("checks a status line's truncated child even when the flex wrapper fits", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("truncate") ? 200 : 100; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const { container } = render(<TruncateTip text="Needs you: Approve the deploy"><span className="flex"><span>Needs you</span><span className="truncate">Approve the deploy</span></span></TruncateTip>);
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).not.toBeNull();
  });
});
