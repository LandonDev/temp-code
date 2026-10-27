// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_TREE, inAppMenus } from "@shared/menuTree";
import { MenuBar, acceleratorLabel } from "./MenuBar";
import { IS_MAC } from "../lib/platform";

afterEach(cleanup);

function tapAlt(): void {
  act(() => {
    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyUp(window, { key: "Alt" });
  });
}

const menuButton = (label: string) => screen.getByRole("button", { name: label });

describe("MenuBar", () => {
  it("draws nothing until a lone Alt opens it", () => {
    const { container } = render(<MenuBar onCommand={() => {}} />);
    expect(container.firstChild).toBeNull();
    tapAlt();
    expect(menuButton("File")).toBeTruthy();
  });

  it("opens File, Edit, View, Go and Threads", () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["File", "Edit", "View", "Go", "Threads"]);
  });

  it("lists a menu's rows from the tree with their keys", () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    fireEvent.click(menuButton("Go"));
    const go = inAppMenus(MENU_TREE).find((m) => m.label === "Go")!;
    const expected = go.items.flatMap((i) => (i.kind === "item" ? [i.label] : []));
    const rows = screen.getAllByRole("menuitem");
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => expect(row.textContent).toMatch(new RegExp(`^${expected[i].replace(/[.…]/g, "\\$&")}`)));
    expect(rows[0].textContent).toContain(acceleratorLabel("CmdOrCtrl+K"));
  });

  it("sends a pick to onCommand and closes", () => {
    const onCommand = vi.fn();
    render(<MenuBar onCommand={onCommand} />);
    tapAlt();
    fireEvent.click(menuButton("Threads"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Mark All Read/ }));
    expect(onCommand).toHaveBeenCalledWith("mark_all_read");
    expect(screen.queryByRole("button", { name: "File" })).toBeNull();
  });

  it("greys a disabled row", () => {
    render(<MenuBar onCommand={() => {}} disabled={["open_notes"]} />);
    tapAlt();
    fireEvent.click(menuButton("Go"));
    const notes = screen.getByRole("menuitem", { name: /Notes/ }) as HTMLButtonElement;
    expect(notes.disabled || notes.getAttribute("aria-disabled") === "true").toBe(true);
  });
});

describe("acceleratorLabel", () => {
  it("writes the keys the way the platform does", () => {
    expect(acceleratorLabel("CmdOrCtrl+Shift+F")).toBe(IS_MAC ? "⌘⇧F" : "Ctrl+Shift+F");
    expect(acceleratorLabel("CmdOrCtrl+Alt+Left")).toBe(IS_MAC ? "⌘⌥←" : "Ctrl+Alt+←");
  });
});
