// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectRailWidth } from "../lib/appearance";
import { ProjectRail } from "./ProjectRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ProjectRail sash", () => {
  it("is focusable, steps by 2% or Shift 10%, saves its width and resets on double-click", () => {
    const { container } = render(
      <div className="app-shell">
        <ProjectRail cwd="~" recents={[]} busyPaths={new Set()} onSelectProject={() => {}} onOpenProject={() => {}} />
      </div>,
    );
    vi.spyOn(container.querySelector(".app-shell")!, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize workspace rail" });
    const pane = handle.parentElement!;
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.className).toContain("focus-visible:bg-accent");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    expect(pane.style.width).toBe("220px");
    expect(loadProjectRailWidth()).toBe(220);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(pane.style.width).toBe("320px");
    expect(loadProjectRailWidth()).toBe(320);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(pane.style.width).toBe("300px");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
    expect(pane.style.width).toBe("200px");
    expect(loadProjectRailWidth()).toBe(200);
  });
});

describe("Add workspace", () => {
  it("opens the folder picker under its own title, never Open project's", () => {
    const onOpenProject = vi.fn();
    render(<ProjectRail cwd="~" recents={[]} busyPaths={new Set()} onSelectProject={() => {}} onOpenProject={onOpenProject} />);
    fireEvent.click(screen.getByRole("button", { name: "Add workspace…" }));
    expect(onOpenProject).toHaveBeenCalledWith(undefined, "Add workspace");
  });
});
