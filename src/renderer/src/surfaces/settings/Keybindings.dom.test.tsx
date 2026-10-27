// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsPage } from "./Keybindings";

afterEach(cleanup);

const row = (name: string) =>
  [...document.querySelectorAll("[data-slot=page-row]")].find((el) => el.querySelector("[data-slot=item-title]")?.textContent === name);

describe("Keybindings", () => {
  it("draws each chord as key caps in a section per group", () => {
    render(<KeybindingsPage />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "App",
      "Tabs",
      "Environments",
      "Panes",
      "Terminal",
      "Editor",
    ]);
    const search = row("Search");
    expect(search?.querySelectorAll("kbd[data-slot=kbd]")).toHaveLength(2);
  });

  it("puts or between alternatives", () => {
    render(<KeybindingsPage />);
    const goToFile = row("Go to File");
    expect(goToFile?.querySelectorAll("[data-slot=kbd-group]")).toHaveLength(2);
    expect(goToFile?.textContent).toContain("or");
  });

  it("says where a scoped binding holds", () => {
    render(<KeybindingsPage />);
    expect(row("Split Right")?.textContent).toContain("Outside the editor");
  });

  it("filters, and says so when nothing matches", () => {
    render(<KeybindingsPage />);
    const filter = screen.getByRole("textbox", { name: "Filter keybindings" });
    fireEvent.change(filter, { target: { value: "dock" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Terminal"]);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText("No shortcut matches")).toBeTruthy();
    expect(document.querySelector("[data-slot=page-row]")).toBeNull();
  });
});
