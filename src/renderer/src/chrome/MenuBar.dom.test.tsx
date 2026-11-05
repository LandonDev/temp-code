// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_TREE, inAppMenus } from "@shared/menuTree";
import { MenuBar, acceleratorLabel, rowsOf } from "./MenuBar";
import { IS_MAC } from "../lib/platform";

afterEach(cleanup);

function tapAlt(): void {
  act(() => {
    fireEvent.keyDown(window, { key: "Alt" });
    fireEvent.keyUp(window, { key: "Alt" });
  });
}

const menuButton = (label: string) => within(screen.getByRole("menubar", { name: "Menu bar" })).getByRole("menuitem", { name: label });
/** The open menu's own rows, not the bar's titles. */
const openRows = async () => within(await screen.findByRole("menu")).findAllByRole("menuitem");

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
    const bar = screen.getByRole("menubar", { name: "Menu bar" });
    expect(within(bar).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["File", "Edit", "View", "Go", "Threads"]);
  });

  it("lists a menu's rows from the tree with their keys", async () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    fireEvent.click(menuButton("Go"));
    const go = inAppMenus(MENU_TREE).find((m) => m.label === "Go")!;
    const expected = go.items.flatMap((i) => (i.kind === "item" ? [i.label] : []));
    const rows = await openRows();
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => expect(row.textContent).toMatch(new RegExp(`^${expected[i].replace(/[.…]/g, "\\$&")}`)));
    expect(rows[0].textContent).toContain(acceleratorLabel("CmdOrCtrl+K"));
  });

  it("sends a pick to onCommand and closes", async () => {
    const onCommand = vi.fn();
    render(<MenuBar onCommand={onCommand} />);
    tapAlt();
    fireEvent.click(menuButton("Threads"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Mark All Read/ }));
    expect(onCommand).toHaveBeenCalledWith("mark_all_read");
    expect(screen.queryByRole("menubar")).toBeNull();
  });

  it("greys a disabled row", async () => {
    render(<MenuBar onCommand={() => {}} disabled={["open_notes"]} />);
    tapAlt();
    fireEvent.click(menuButton("Go"));
    const notes = within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Notes/ }) as HTMLButtonElement;
    expect(notes.disabled || notes.getAttribute("aria-disabled") === "true").toBe(true);
  });
});

describe("MenuBar from the keyboard", () => {
  it("focuses its first title when a lone Alt opens it, with one tab stop", () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    expect(document.activeElement).toBe(menuButton("File"));
    const tabbable = within(screen.getByRole("menubar")).getAllByRole("menuitem").filter((el) => el.tabIndex === 0);
    expect(tabbable.map((el) => el.textContent)).toEqual(["File"]);
  });

  it("moves between the titles with Left and Right, wrapping, and Home and End", () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    fireEvent.keyDown(menuButton("File"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(menuButton("Edit"));
    expect(menuButton("Edit").tabIndex).toBe(0);
    expect(menuButton("File").tabIndex).toBe(-1);
    fireEvent.keyDown(menuButton("Edit"), { key: "ArrowLeft" });
    fireEvent.keyDown(menuButton("File"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(menuButton("Threads"));
    fireEvent.keyDown(menuButton("Threads"), { key: "Home" });
    expect(document.activeElement).toBe(menuButton("File"));
    fireEvent.keyDown(menuButton("File"), { key: "End" });
    expect(document.activeElement).toBe(menuButton("Threads"));
  });

  it("closes on Escape with no menu open, or on Alt again, and gives the focus back", () => {
    render(
      <>
        <input aria-label="Field" />
        <MenuBar onCommand={() => {}} />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Field" });
    field.focus();
    tapAlt();
    expect(document.activeElement).toBe(menuButton("File"));
    fireEvent.keyDown(menuButton("File"), { key: "Escape" });
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(document.activeElement).toBe(field);
    tapAlt();
    expect(document.activeElement).toBe(menuButton("File"));
    tapAlt();
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("opens a title's menu from the keyboard", async () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    fireEvent.keyDown(menuButton("File"), { key: "ArrowRight" });
    fireEvent.click(document.activeElement!);
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(menuButton("Edit").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("MenuBar while a menu is open", () => {
  it("opens the neighbour menu with Left and Right, wrapping, from inside the open menu", async () => {
    render(<MenuBar onCommand={() => {}} />);
    tapAlt();
    fireEvent.click(menuButton("File"));
    const file = await screen.findByRole("menu");
    fireEvent.keyDown(within(file).getAllByRole("menuitem")[0], { key: "ArrowRight" });
    expect(menuButton("Edit").getAttribute("aria-expanded")).toBe("true");
    expect(menuButton("File").getAttribute("aria-expanded")).not.toBe("true");
    expect(menuButton("Edit").tabIndex).toBe(0);
    const edit = await screen.findByRole("menu", { name: "Edit menu" });
    fireEvent.keyDown(within(edit).getAllByRole("menuitem")[0], { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("menu", { name: "File menu" }), { key: "ArrowLeft" });
    expect(menuButton("Threads").getAttribute("aria-expanded")).toBe("true");
  });

  it("gives the focus back to where it was before a pick's command runs", async () => {
    let focusedAtCommand: Element | null = null;
    render(
      <>
        <input aria-label="Field" />
        <MenuBar onCommand={() => (focusedAtCommand = document.activeElement)} />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Field" });
    field.focus();
    tapAlt();
    fireEvent.click(menuButton("Threads"));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Mark All Read/ }));
    expect(focusedAtCommand).toBe(field);
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(document.activeElement).toBe(field);
  });
});

describe("rowsOf", () => {
  it("ticks Away from Computer as a checkbox row, and nothing else", () => {
    const threads = inAppMenus(MENU_TREE).find((m) => m.label === "Threads")!;
    const away = (checked: boolean) => rowsOf(threads, new Set(), { toggle_away: checked }).find((r) => r.kind === "item" && r.id === "toggle_away");
    expect(away(true)).toMatchObject({ label: "Away from Computer", checked: true });
    expect(away(false)).toMatchObject({ checked: false });
    const others = rowsOf(threads, new Set(), { toggle_away: true }).filter((r) => r.kind === "item" && r.id !== "toggle_away");
    for (const row of others) expect(row).not.toHaveProperty("checked");
  });
});

describe("acceleratorLabel", () => {
  it("writes the keys the way the platform does", () => {
    expect(acceleratorLabel("CmdOrCtrl+Shift+F")).toBe(IS_MAC ? "⌘⇧F" : "Ctrl+Shift+F");
    expect(acceleratorLabel("CmdOrCtrl+Alt+Left")).toBe(IS_MAC ? "⌘⌥←" : "Ctrl+Alt+←");
  });
});
