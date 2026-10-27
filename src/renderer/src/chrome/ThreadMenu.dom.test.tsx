// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { chipMenuItems } from "./ThreadHeader";
import type { ChipThread, StripChip } from "./ThreadHeaderStrip";
import { MenuRows, ThreadMenu } from "./ThreadMenu";

vi.mock("./HostGlyph", () => ({ HostGlyph: () => <span data-host-glyph /> }));

const chip = (id: string, title: string, updatedAt: number): StripChip => {
  const thread: ChipThread = {
    id,
    title,
    status: "idle",
    updatedAt,
    projectId: "p1",
    parentId: null,
    archived: false,
    threadType: "chat",
  };
  return { id, thread, tabId: null, live: false, status: "idle", unread: false, updatedAt };
};

function menu(over: Partial<ComponentProps<typeof ThreadMenu>> = {}) {
  const props: ComponentProps<typeof ThreadMenu> = {
    host: null,
    cost: null,
    rows: [{ kind: "item", id: "rename", label: "Rename" }],
    onPick: vi.fn(),
    running: 0,
    onPauseAll: vi.fn(() => Promise.resolve()),
    dev: { shown: false, open: false, onToggle: vi.fn() },
    terminal: { onNew: vi.fn(), active: false },
    recent: [],
    onOpenRecent: vi.fn(),
    archived: [],
    onRestore: vi.fn(),
    panel: { open: false, onToggle: vi.fn() },
    ...over,
  };
  render(<ThreadMenu {...props} />);
  return props;
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
  return screen.findByRole("menu", { name: "Thread menu" });
}

afterEach(cleanup);

describe("ThreadMenu", () => {
  it("the right end holds exactly the thread menu and the panel toggle", () => {
    const props = menu({ panel: { open: true, onToggle: vi.fn() } });
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Thread menu", "Panel"]);
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(buttons[1]!);
    expect(props.panel.onToggle).toHaveBeenCalled();
  });

  it("offers Pause all only while something runs, with the count", async () => {
    menu();
    expect(within(await openMenu()).queryByText("Pause all")).toBeNull();
    cleanup();
    const props = menu({ running: 3 });
    const list = await openMenu();
    const row = within(list).getByText("Pause all").closest('[role="menuitem"]')!;
    expect(row.textContent).toBe("Pause all3");
    fireEvent.click(row);
    expect(props.onPauseAll).toHaveBeenCalled();
  });

  it("with two hosts the first line names the host, and the move rows sit with the thread's", async () => {
    menu({
      host: { environmentId: "env_box", name: "box" },
      rows: chipMenuItems(chip("a", "A", 1), undefined, 0, false, [
        { kind: "item", id: "move:local", label: "Move to This Mac…", disabled: true, description: "The thread is running" },
      ]),
    });
    const list = await openMenu();
    expect(list.querySelector("[data-thread-line]")?.textContent).toBe("box");
    expect(within(list).getByText("Move to This Mac…")).toBeTruthy();
    expect(within(list).getByText("The thread is running")).toBeTruthy();
  });

  it("shows the cost only above zero", async () => {
    menu({ cost: 0 });
    expect((await openMenu()).querySelector("[data-thread-line]")).toBeNull();
    cleanup();
    menu({ cost: 1.237 });
    expect((await openMenu()).querySelector("[data-thread-line]")?.textContent).toBe("$1.24");
  });

  it("Recent threads lists settled threads in the order given, at most twelve, and opens one", async () => {
    const recent = Array.from({ length: 14 }, (_, i) => chip(`r${i}`, `Thread ${i}`, 1000 - i));
    const props = menu({ recent });
    const list = await openMenu();
    fireEvent.click(within(list).getByText("Recent threads"));
    const rows = (await screen.findAllByText(/^Thread \d+$/)).map((el) => el.textContent);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toBe("Thread 0");
    fireEvent.click(screen.getByText("Thread 2"));
    expect(props.onOpenRecent).toHaveBeenCalledWith("r2");
  });

  it("Archived threads opens the list, and Restore brings one back", async () => {
    const props = menu({ archived: [{ id: "x", title: "Old work", type: "chat", updatedAt: 1 }] });
    fireEvent.click(within(await openMenu()).getByText("Archived threads…"));
    fireEvent.click(await screen.findByText("Old work"));
    expect(props.onRestore).toHaveBeenCalledWith("x");
  });

  it("Terminal opens the project terminal, Dev server toggles the pane", async () => {
    const props = menu({ dev: { shown: true, open: true, onToggle: vi.fn() } });
    const list = await openMenu();
    expect(within(list).getByRole("menuitemcheckbox", { name: "Dev server" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(list).getByText("Terminal"));
    expect(props.terminal.onNew).toHaveBeenCalled();
  });
});

describe("MenuRows", () => {
  it("the Type submenu picks a type by its row id", async () => {
    const props = menu({ rows: chipMenuItems(chip("a", "A", 1)) });
    const list = await openMenu();
    fireEvent.click(within(list).getByText("Type"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Plan" }));
    expect(props.onPick).toHaveBeenCalledWith("type:planning");
  });

  it("the ⋯ menu and the chip's right-click render the same rows", async () => {
    const items = chipMenuItems(chip("a", "A", 1), undefined, 2, true);
    const labels = (root: HTMLElement) =>
      [...root.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="dropdown">
          <MenuRows kind="dropdown" items={items} onPick={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const dropdown = labels(await screen.findByRole("menu", { name: "dropdown" }));
    cleanup();
    render(
      <ContextMenu defaultOpen>
        <ContextMenuTrigger>open</ContextMenuTrigger>
        <ContextMenuContent aria-label="context">
          <MenuRows kind="context" items={items} onPick={() => {}} />
        </ContextMenuContent>
      </ContextMenu>,
    );
    const context = labels(await screen.findByRole("menu", { name: "context" }));
    expect(context).toEqual(dropdown);
    expect(dropdown).toEqual(expect.arrayContaining(["Rename", "Resources (2)…", "Archive…", "Delete…"]));
  });
});
