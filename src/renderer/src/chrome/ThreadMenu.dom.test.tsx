// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { threadMenuRows, type ThreadMenuFacts } from "../lib/threadMenu";
import type { ChipThread, StripChip } from "./ThreadHeaderStrip";
import { MenuRows } from "./menuBody";
import { ThreadMenu } from "./ThreadMenu";

vi.mock("./HostGlyph", () => ({ HostGlyph: () => <span data-host-glyph /> }));

const facts = (over: Partial<ThreadMenuFacts> = {}): ThreadMenuFacts => ({
  status: "idle",
  threadType: "chat",
  projectId: "p1",
  parentId: null,
  master: false,
  resources: 0,
  removable: 0,
  goal: null,
  moves: [],
  ...over,
});

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
      rows: threadMenuRows(
        facts({ moves: [{ kind: "item", id: "move:local", label: "Move to This Mac…", disabled: true, reason: "The thread is running" }] }),
      ),
    });
    const list = await openMenu();
    expect(list.querySelector("[data-menu-note='line']")?.textContent).toBe("box");
    expect(within(list).getByText("Move to This Mac…")).toBeTruthy();
    expect(within(list).getByRole("menuitem", { name: "Move to This Mac…" }).getAttribute("aria-description")).toBe("The thread is running");
  });

  it("shows the cost only above zero", async () => {
    menu({ cost: 0 });
    expect((await openMenu()).querySelector("[data-menu-note='line']")).toBeNull();
    cleanup();
    menu({ cost: 1.237 });
    expect((await openMenu()).querySelector("[data-menu-note='line']")?.textContent).toBe("$1.24");
  });

  it("Recent threads… lists every settled thread, newest first, and a row opens its thread", async () => {
    const recent = Array.from({ length: 20 }, (_, i) => chip(`r${i}`, `Thread ${i}`, 1000 - i));
    const props = menu({ recent });
    fireEvent.click(within(await openMenu()).getByText("Recent threads…"));
    const list = await screen.findByRole("dialog", { name: "Recent threads" });
    const rows = [...list.querySelectorAll("[data-listed]")].map((el) => el.getAttribute("data-listed"));
    expect(rows).toEqual(recent.map((c) => c.id));
    expect(list.querySelector("[data-listed='r0'] svg[data-type-glyph]")?.getAttribute("class")).toContain("text-type-chat");
    fireEvent.click(within(list).getByText("Thread 2"));
    expect(props.onOpenRecent).toHaveBeenCalledWith("r2");
  });

  it("Recent threads… filters past six, and a filter with no match is one muted row", async () => {
    menu({ recent: Array.from({ length: 6 }, (_, i) => chip(`r${i}`, `Thread ${i}`, 100 - i)) });
    fireEvent.click(within(await openMenu()).getByText("Recent threads…"));
    expect(within(await screen.findByRole("dialog", { name: "Recent threads" })).queryByRole("textbox")).toBeNull();
    cleanup();
    menu({ recent: [...Array.from({ length: 6 }, (_, i) => chip(`r${i}`, `Thread ${i}`, 100 - i)), chip("x", "Fix login", 1)] });
    fireEvent.click(within(await openMenu()).getByText("Recent threads…"));
    const list = await screen.findByRole("dialog", { name: "Recent threads" });
    const field = within(list).getByRole("textbox", { name: "Search recent threads" });
    fireEvent.change(field, { target: { value: "login" } });
    expect([...list.querySelectorAll("[data-listed]")].map((el) => el.textContent)).toEqual([expect.stringContaining("Fix login")]);
    fireEvent.change(field, { target: { value: "nothing like it" } });
    expect(list.querySelectorAll("[data-listed]")).toHaveLength(0);
    expect(within(list).getByText("No matches")).toBeTruthy();
  });

  it("Escape closes Recent threads… and gives focus back to ⋯", async () => {
    menu({ recent: [chip("r0", "Thread 0", 10)] });
    fireEvent.click(within(await openMenu()).getByText("Recent threads…"));
    const list = await screen.findByRole("dialog", { name: "Recent threads" });
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Recent threads" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thread menu" })));
  });

  it("Archived threads opens the list, and Restore brings one back", async () => {
    const props = menu({ archived: [{ id: "x", title: "Old work", type: "research", updatedAt: 1 }] });
    fireEvent.click(within(await openMenu()).getByText("Archived threads…"));
    const row = (await screen.findByText("Old work")).closest("[data-listed]")!;
    expect(row.querySelector("svg[data-type-glyph]")?.getAttribute("class")).toContain("text-type-research");
    fireEvent.click(await screen.findByText("Old work"));
    expect(props.onRestore).toHaveBeenCalledWith("x");
  });

  it("Terminal opens the project terminal; Dev server is the thread's own row, not the project's", async () => {
    const props = menu();
    const list = await openMenu();
    expect(within(list).queryByText("Dev server")).toBeNull();
    fireEvent.click(within(list).getByText("Terminal"));
    expect(props.terminal.onNew).toHaveBeenCalled();
  });

  it("with no terminal handler (the page at /ui) there is no Terminal row", async () => {
    menu({ terminal: { onNew: undefined, onShow: undefined, active: true } });
    const list = await openMenu();
    expect(within(list).queryByText("Terminal")).toBeNull();
  });
});

describe("MenuRows", () => {
  it("the Type submenu picks a type by its row id", async () => {
    const props = menu({ rows: threadMenuRows(facts()) });
    const list = await openMenu();
    fireEvent.click(within(list).getByText("Type"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Plan" }));
    expect(props.onPick).toHaveBeenCalledWith("type:planning");
  });

  it("the ⋯ menu and the chip's right-click render the same rows", async () => {
    const items = threadMenuRows(facts({ resources: 2, removable: 2, master: true }));
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
    expect(dropdown).toEqual(expect.arrayContaining(["Rename", "Resources…2", "Archive…", "Delete…"]));
  });
});
