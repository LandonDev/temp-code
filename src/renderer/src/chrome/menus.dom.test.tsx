// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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
      <DropdownMenuContent aria-label="menu">
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

  it("draws one row size: 28px, 12px padding, 8px from its 14px glyph, in both menus", async () => {
    const rowClasses = ["min-h-7", "px-3", "gap-2", "[&_svg:not([class*='size-'])]:size-3.5"];
    const { list } = await openDropdown(ROWS);
    const pause = within(list).getByRole("menuitem", { name: /Pause/ });
    for (const c of rowClasses) expect(pause.className.split(/\s+/)).toContain(c);
    expect(list.getAttribute("data-size")).toBeNull();
    const check = within(list).getByRole("menuitemcheckbox", { name: "Mac bridge" });
    expect(check.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-7", "ps-3", "pe-8"]));
    cleanup();
    render(
      <ContextMenu defaultOpen>
        <ContextMenuTrigger>open</ContextMenuTrigger>
        <ContextMenuContent aria-label="context">
          <MenuRows kind="context" items={ROWS} onPick={() => {}} />
        </ContextMenuContent>
      </ContextMenu>,
    );
    const context = await screen.findByRole("menu", { name: "context" });
    const archive = within(context).getByRole("menuitem", { name: /Archive/ });
    for (const c of rowClasses) expect(archive.className.split(/\s+/)).toContain(c);
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

describe("RowsContextMenu's edges", () => {
  beforeEach(() => resetMenus());

  it("lazyMount mounts no body until the first right-click, then opens there", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    render(
      <RowsContextMenu label="Link" lazyMount rowsFor={() => [{ kind: "item", id: "copy", label: "Copy Path" }]} onPick={() => {}}>
        <span>a/b.ts</span>
      </RowsContextMenu>,
    );
    expect(document.querySelector('[data-slot="context-menu-trigger"]')).toBeNull();
    fireEvent.contextMenu(screen.getByText("a/b.ts"));
    expect(await screen.findByRole("menu", { name: "Link" })).toBeTruthy();
  });

  it("a right-click in a field keeps the system's menu", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    render(
      <RowsContextMenu label="Rows" rowsFor={() => [{ kind: "item", id: "x", label: "X" }]} onPick={() => {}}>
        <div>
          <input aria-label="Name" />
        </div>
      </RowsContextMenu>,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByLabelText("Name").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("menu", { name: "Rows" })).toBeNull();
  });
});

describe("the title bar's icon buttons", () => {
  beforeAll(async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
  });

  it("name themselves on hover with their binding's key, never with a title", async () => {
    const { IconButton } = await import("./TitleBar");
    render(
      <IconButton label="Sidebar" shortcut="⌘B">
        <span>icon</span>
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Sidebar" });
    expect(button.getAttribute("title")).toBeNull();
    fireEvent.pointerEnter(button);
    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe("Sidebar⌘B"), { timeout: 2000 });
  });
});

describe("focus after a menu closes", () => {
  beforeEach(() => resetMenus());

  it("Escape gives focus back to the clicked row's own control, a roving tab's button too", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    render(
      <RowsContextMenu label="Rows" rowsFor={(id) => (id ? [{ kind: "item", id: "x", label: "X" }] : null)} onPick={() => {}}>
        <div>
          <div data-menu-id="b">
            <button type="button" tabIndex={-1}>
              Beta
            </button>
          </div>
        </div>
      </RowsContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("Beta"));
    const menu = await screen.findByRole("menu", { name: "Rows" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Beta")));
  });

  it("a pick that opens a dialog leaves focus in the dialog's field once the menu has closed", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    function Surface() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <RowsContextMenu label="Rows" rowsFor={(id) => (id ? [{ kind: "item", id: "customize", label: "Customize…" }] : null)} onPick={() => setOpen(true)}>
            <div>
              <button type="button" data-menu-id="b">
                Beta
              </button>
            </div>
          </RowsContextMenu>
          {open ? (
            <div data-slot="dialog-content">
              <input aria-label="Name" autoFocus />
            </div>
          ) : null}
        </>
      );
    }
    render(<Surface />);
    fireEvent.contextMenu(screen.getByText("Beta"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rows" })).getByText("Customize…"));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Rows" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
  });
});
