// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeaderModel } from "../lib/threadHeaderModel";
import { ChipHoverLabel, ThreadHeaderStrip, chipStatus, type ChipThread, type StripChip } from "./ThreadHeaderStrip";

const thread = (id: string, title: string): ChipThread => ({
  id,
  title,
  status: "idle",
  updatedAt: 1,
  projectId: "p1",
  parentId: null,
  archived: false,
  threadType: "chat",
});

const chip = (id: string, title: string): StripChip => ({
  id,
  thread: thread(id, title),
  tabId: `tab-${id}`,
  live: true,
  status: "idle",
  unread: false,
  updatedAt: 1,
});

const model: HeaderModel<ChipThread> = {
  live: [chip("a", "Alpha"), chip("b", "Beta"), chip("c", "Gamma")],
  dormant: [],
  activeId: "a",
};

function strip(over: Partial<ComponentProps<typeof ThreadHeaderStrip>> = {}) {
  return (
    <ThreadHeaderStrip
      model={model}
      onSelect={() => {}}
      stripRef={() => {}}
      planReady={{}}
      renamingId={null}
      onStartRename={() => {}}
      onRename={() => {}}
      onContextMenu={() => {}}
      activeRef={() => {}}
      {...over}
    />
  );
}

function mount(over: Partial<ComponentProps<typeof ThreadHeaderStrip>> = {}) {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const view = render(strip({ onSelect, onContextMenu, ...over }));
  return { onSelect, onContextMenu, ...view };
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

afterEach(cleanup);

describe("ThreadHeaderStrip pointer", () => {
  it("a right press does not select, and the contextmenu that follows opens that chip's menu", () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 2 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Beta"));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0]![0].id).toBe("b");
  });

  it("a Control-click is a right-click on the Mac: no select, the menu", () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Gamma"), { button: 0, ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Gamma"));
    expect(onContextMenu.mock.calls[0]![0].id).toBe("c");
  });

  it("a primary press selects", () => {
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0 });
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("the strip's rows take clicks: they are out of the window's drag region", () => {
    mount();
    for (const row of document.querySelectorAll("[data-strip]")) {
      expect(row.getAttribute("data-tauri-drag-region")).toBe("false");
    }
    expect(document.querySelectorAll("[data-strip]").length).toBeGreaterThan(0);
  });
});

describe("ThreadHeaderStrip row", () => {
  it("draws one row of chips", () => {
    mount();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Gamma"),
    ]);
  });

  it("a chip whose thread settles while the pointer is over the strip stays until the pointer leaves", () => {
    const { rerender } = mount();
    const row = document.querySelector('[role="tablist"]')!;
    fireEvent.pointerEnter(row);
    const settled = { ...model, live: model.live.filter((c) => c.id !== "b") };
    rerender(strip({ model: settled }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.pointerLeave(row);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: /Beta/ })).toBeNull();
  });
});

describe("ThreadHeaderStrip chip", () => {
  it("a master chip reads its type glyph, title, Master and status glyph, nothing else, and carries no title attribute", () => {
    const waiting: StripChip = { ...chip("a", "Alpha"), status: "waiting", thread: { ...thread("a", "Alpha"), status: "waiting" } };
    mount({ masterIds: new Set(["a"]), model: { ...model, live: [waiting, ...model.live.slice(1)] } });
    const el = tab("Alpha");
    expect(el.children).toHaveLength(4);
    expect(el.children[0]!.tagName.toLowerCase()).toBe("svg");
    expect(el.textContent).toBe("AlphaMaster");
    expect(el.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-label")).toBe("Needs you");
    // A settled chip says nothing at rest.
    expect(tab("Beta").querySelector('[data-slot="status-mark"]')).toBeNull();
    for (const el of document.querySelectorAll("[role=tab], [role=tab] *")) expect(el.hasAttribute("title")).toBe(false);
  });

  it("only the active chip is in the tab order; arrows move focus and Enter selects", () => {
    const { onSelect } = mount();
    expect(tab("Alpha").tabIndex).toBe(0);
    expect(tab("Beta").tabIndex).toBe(-1);
    tab("Alpha").focus();
    fireEvent.keyDown(tab("Alpha"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Beta"));
    fireEvent.keyDown(tab("Beta"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab("Alpha"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Gamma"));
    fireEvent.click(tab("Gamma"), { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("a double-click asks to rename, and the renaming chip is a field", () => {
    const onStartRename = vi.fn();
    const { rerender } = mount({ onStartRename });
    fireEvent.doubleClick(tab("Beta"));
    expect(onStartRename).toHaveBeenCalledWith("b");
    rerender(strip({ renamingId: "b" }));
    expect((screen.getByRole("textbox", { name: "Thread title" }) as HTMLInputElement).value).toBe("Beta");
  });

  it("a right-click opens the chip's menu with its rows", async () => {
    mount({ menu: (c) => <div role="menuitem">Rename {c.thread.title}</div> });
    fireEvent.contextMenu(tab("Gamma"));
    expect(await screen.findByText("Rename Gamma")).toBeTruthy();
  });

  it("reads the chip's status from its thread: the tree, the activity, the tally", () => {
    const working: StripChip = {
      ...chip("w", "Build"),
      status: "running",
      thread: { ...thread("w", "Build"), status: "running", activity: "Typecheck", tasks: { done: 3, total: 7 } },
    };
    expect(chipStatus(working, {})).toEqual({ state: "working", detail: "typecheck", tally: "3/7" });
    const paused: StripChip = { ...working, thread: { ...working.thread, treeHasPaused: true } };
    expect(chipStatus(paused, {}).state).toBe("paused");
    expect(chipStatus(chip("i", "Idle"), { i: true }).state).toBe("plan-ready");
  });

  it("the hover label is the title and the status mark: the word, what it is about and the tally", () => {
    const working: StripChip = {
      ...chip("a", "Alpha"),
      status: "running",
      thread: { ...thread("a", "Alpha"), status: "running", activity: "Running bun", tasks: { done: 3, total: 7 } },
    };
    const { container } = render(<ChipHoverLabel title="Alpha" status={chipStatus(working, {})} />);
    const line = container.querySelector('[data-slot="status-mark"]')!;
    expect(line.getAttribute("data-state")).toBe("working");
    expect(container.textContent).toBe("AlphaWorkingrunning bun3/7");
  });
});
