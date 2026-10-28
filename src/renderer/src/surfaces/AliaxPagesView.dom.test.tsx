// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@aliax/pages", () => ({ AccountsPage: () => <h1>Accounts</h1>, StatsPage: () => <h1>Stats</h1> }));
const { AliaxPagesView } = await import("./AliaxPagesView");
const { PAGE_SCROLLER } = await import("../components/page");

afterEach(() => {
  cleanup();
  delete (window as { api?: unknown }).api;
});

describe("AliaxPagesView", () => {
  it("leaves the title to the page, so it reads once", () => {
    (window as { api?: unknown }).api = {};
    render(<AliaxPagesView page="accounts" onClose={() => {}} />);
    expect(screen.getAllByText("Accounts")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Accounts" })).toBeTruthy();
  });

  it("shows the shared empty state at /ui", () => {
    render(<AliaxPagesView page="stats" onClose={() => {}} />);
    expect(screen.getByText("Available in the desktop app").closest("[data-slot=empty]")).toBeTruthy();
    expect(screen.queryByText("Stats")).toBeNull();
  });

  it("opens each page at its top, with the scroller's gutter held", () => {
    (window as { api?: unknown }).api = {};
    const { rerender } = render(<AliaxPagesView page="accounts" onClose={() => {}} />);
    const scroller = () => screen.getByRole("heading").parentElement as HTMLElement;
    expect(scroller().className).toContain("[scrollbar-gutter:stable]");
    // The lazy chunk's skeleton sits in the same scroller, so the page lands where it stood.
    for (const cls of PAGE_SCROLLER.split(" ")) expect(scroller().classList).toContain(cls);
    scroller().scrollTop = 400;
    const before = scroller();
    rerender(<AliaxPagesView page="stats" onClose={() => {}} />);
    expect(scroller()).not.toBe(before);
    expect(scroller().scrollTop).toBe(0);
  });
});
