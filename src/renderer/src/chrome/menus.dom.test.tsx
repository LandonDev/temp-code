// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Tip, TruncateTip } from "../components/tip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { Archive, Pause, Trash2 } from "./icons";
import { MenuRows } from "./menuBody";
import { resetMenus, RowsContextMenu, RowsMenu, tidy, warmMenus, type MenuRow } from "./menuRows";
import { menuChunk } from "../surfaces/chunks";

afterEach(cleanup);

const ROWS: MenuRow[] = [
  { kind: "label", label: "Thread" },
  { kind: "item", id: "pause", label: "Pause", icon: Pause, shortcut: "⌘P" },
  { kind: "item", id: "bridge", label: "Mac bridge", checked: true },
  { kind: "sub", id: "type", label: "Type", items: [{ kind: "item", id: "type:chat", label: "Chat", checked: true }] },
  { kind: "item", id: "move", label: "Move to box…", disabled: true, description: "The box is offline" },
  { kind: "sep" },
  { kind: "item", id: "archive", label: "Archive", icon: Archive },
  { kind: "item", id: "delete", label: "Delete…", icon: Trash2, danger: true },
];

async function openDropdown(items: readonly MenuRow[], onPick = vi.fn()) {
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent aria-label="menu" size="sm">
        <MenuRows kind="dropdown" items={items} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return { list: await screen.findByRole("menu", { name: "menu" }), onPick };
}

describe("MenuRows", () => {
  it("draws the glyph, the label and the binding's key cap", async () => {
    const { list } = await openDropdown(ROWS);
    const pause = within(list).getByRole("menuitem", { name: /Pause/ });
    expect(pause.querySelector("svg")).toBeTruthy();
    expect(pause.querySelector("kbd")?.textContent).toBe("⌘P");
    expect(within(list).getByText("Thread")).toBeTruthy();
  });

  it("marks a destructive row, a checkbox row, a disabled row with its reason", async () => {
    const { list } = await openDropdown(ROWS);
    expect(within(list).getByRole("menuitem", { name: /Delete/ }).getAttribute("data-variant")).toBe("destructive");
    expect(within(list).getByRole("menuitemcheckbox", { name: "Mac bridge" }).getAttribute("aria-checked")).toBe("true");
    const move = within(list).getByRole("menuitem", { name: /Move to box/ });
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(within(move).getByText("The box is offline")).toBeTruthy();
  });

  it("a pick calls onPick with the row's id, in a submenu too", async () => {
    const { list, onPick } = await openDropdown(ROWS);
    fireEvent.click(within(list).getByRole("menuitem", { name: /Archive/ }));
    expect(onPick).toHaveBeenCalledWith("archive");
    cleanup();
    const second = await openDropdown(ROWS);
    fireEvent.click(within(second.list).getByText("Type"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Chat" }));
    expect(second.onPick).toHaveBeenCalledWith("type:chat");
  });

  it("the context menu renders the same rows", async () => {
    const labels = (root: HTMLElement) => [...root.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);
    const { list } = await openDropdown(ROWS);
    const dropdown = labels(list);
    cleanup();
    render(
      <ContextMenu defaultOpen>
        <ContextMenuTrigger>open</ContextMenuTrigger>
        <ContextMenuContent aria-label="context">
          <MenuRows kind="context" items={ROWS} onPick={() => {}} />
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(labels(await screen.findByRole("menu", { name: "context" }))).toEqual(dropdown);
  });
});

describe("tidy", () => {
  it("drops separators first, last, doubled and under a label", () => {
    const item = (id: string): MenuRow => ({ kind: "item", id, label: id });
    expect(
      tidy([{ kind: "sep" }, item("a"), { kind: "sep" }, { kind: "sep" }, item("b"), { kind: "label", label: "L" }, { kind: "sep" }, item("c"), { kind: "sep" }]),
    ).toEqual([item("a"), { kind: "sep" }, item("b"), { kind: "label", label: "L" }, item("c")]);
  });
});

describe("Tip", () => {
  beforeAll(async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
  });

  const hover = (el: HTMLElement) => {
    fireEvent.pointerEnter(el);
    fireEvent.mouseEnter(el);
    fireEvent.focus(el);
  };

  it("opens with its label and key cap; the button keeps its own name", async () => {
    render(
      <Tip label="Close pane" shortcut="⌘W">
        <button type="button" aria-label="Close pane">x</button>
      </Tip>,
    );
    const button = screen.getByRole("button", { name: "Close pane" });
    expect(button.getAttribute("title")).toBeNull();
    hover(button);
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe("Close pane⌘W"), { timeout: 2000 });
  });

  it("TruncateTip stays shut while the text fits", async () => {
    render(
      <TruncateTip text="short">
        <span>short</span>
      </TruncateTip>,
    );
    hover(screen.getByText("short"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it("TruncateTip opens while the text is cut", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    render(
      <TruncateTip text="a long title that is cut">
        <span>a long title that is cut</span>
      </TruncateTip>,
    );
    hover(screen.getByText("a long title that is cut"));
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe("a long title that is cut"), { timeout: 2000 });
    width.mockRestore();
    client.mockRestore();
  });
});

describe("the lazy menus", () => {
  beforeEach(() => resetMenus());

  it("a cold RowsMenu is its trigger; a click loads the body and opens the rows", async () => {
    const onOpenChange = vi.fn();
    render(<RowsMenu trigger={<button type="button">More</button>} label="Thread menu" rows={ROWS} onPick={() => {}} onOpenChange={onOpenChange} />);
    const button = screen.getByRole("button", { name: "More" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    const list = await screen.findByRole("menu", { name: "Thread menu" });
    expect(within(list).getByRole("menuitem", { name: /Archive/ })).toBeTruthy();
  });

  it("a RowsContextMenu over a list opens the clicked row's rows", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    const onPick = vi.fn();
    const rowsFor = (id: string | null): MenuRow[] | null => (id ? [{ kind: "item", id: "open", label: `Open ${id}` }] : null);
    render(
      <RowsContextMenu label="Rows" rowsFor={rowsFor} onPick={onPick}>
        <ul>
          <li data-menu-id="a">A</li>
          <li data-menu-id="b">B</li>
          <li>none</li>
        </ul>
      </RowsContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("none"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("menu", { name: "Rows" })).toBeNull();
    fireEvent.contextMenu(screen.getByText("B"));
    const list = await screen.findByRole("menu", { name: "Rows" });
    fireEvent.click(within(list).getByRole("menuitem", { name: "Open b" }));
    expect(onPick).toHaveBeenCalledWith("open", "b");
  });
});
