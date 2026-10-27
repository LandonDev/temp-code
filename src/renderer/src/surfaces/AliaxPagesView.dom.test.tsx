// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@aliax/pages", () => ({ AccountsPage: () => <h1>Accounts</h1>, StatsPage: () => <h1>Stats</h1> }));
const { AliaxPagesView } = await import("./AliaxPagesView");

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
});
