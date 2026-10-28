// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slotTarget, type HeaderModel } from "../lib/threadHeaderModel";
import { getExternalPaneDrop } from "../lib/paneDrop";
import type { Session } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import { focusStore, initialFocusState } from "../stores/focus";
import { header, headerStore, initialHeaderState, stripHold, useHeldStripModel } from "../stores/header";

const { dropThread } = vi.hoisted(() => ({ dropThread: vi.fn() }));
vi.mock("../stores/workspaceActions", () => ({ workspaceActions: { dropThread } }));

import { ChipHoverLabel, ThreadHeaderStrip, chipStatus, chipTitle, type ChipThread, type StripChip } from "./ThreadHeaderStrip";

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
      activeRef={() => {}}
      {...over}
    />
  );
}

function mount(over: Partial<ComponentProps<typeof ThreadHeaderStrip>> = {}) {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const menu = {
    rowsFor: (id: string | null) => (id ? [{ kind: "item" as const, id: "rename", label: `Rename ${model.live.find((c) => c.id === id)?.thread.title}` }] : null),
    onPick: vi.fn(),
    onOpenChange: (open: boolean, id: string | null) => open && onContextMenu(id),
  };
  const view = render(strip({ onSelect, menu, ...over }));
  return { onSelect, onContextMenu, menu, ...view };
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

afterEach(cleanup);

describe("ThreadHeaderStrip pointer", () => {
  it("a right press does not select, and the contextmenu that follows opens that chip's menu", async () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 2 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Beta"));
    await waitFor(() => expect(onContextMenu).toHaveBeenCalledWith("b"));
    expect(await screen.findByText("Rename Beta")).toBeTruthy();
  });

  it("a Control-click is a right-click on the Mac: no select, the menu", async () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Gamma"), { button: 0, ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Gamma"));
    await waitFor(() => expect(onContextMenu).toHaveBeenCalledWith("c"));
  });

  it("a primary press and release selects, on the release", () => {
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 10, clientY: 10 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: 11, clientY: 10 });
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

  it("a right-click opens the chip's menu with its rows, and a pick names the chip", async () => {
    const { menu } = mount();
    fireEvent.contextMenu(tab("Gamma"));
    fireEvent.click(await screen.findByText("Rename Gamma"));
    expect(menu.onPick).toHaveBeenCalledWith("rename", "c");
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

describe("ThreadHeaderStrip chip drag", () => {
  // A pane 400px wide at the origin; the pointer at x 390 is on its right edge.
  function paneUnderPointer() {
    const pane = document.createElement("div");
    pane.dataset.paneId = "p1";
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) });
    document.body.append(pane);
    // jsdom has no hit testing.
    document.elementFromPoint = (x: number) => (x > 100 ? pane : document.body);
    return () => {
      pane.remove();
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    };
  }
  afterEach(() => {
    dropThread.mockReset();
  });

  it("a move past the threshold drags: no select, the drop names the pane and its edge, the chip dims", () => {
    const restore = paneUnderPointer();
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 390, clientY: 150 });
    expect(getExternalPaneDrop()).toEqual({ fromId: "b", overId: "p1", edge: "right" });
    expect(tab("Beta").dataset.dragging).toBe("true");
    fireEvent.pointerUp(window, { clientX: 390, clientY: 150 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(dropThread).toHaveBeenCalledWith("b", "p1", "right");
    expect(getExternalPaneDrop()).toBeNull();
    restore();
  });

  it("a thread open in no pane joins the open sessions, and its composer takes the keyboard from the dock", () => {
    const restore = paneUnderPointer();
    const beta = { id: "b" } as Session;
    const get = vi.spyOn(sessionStore, "get").mockReturnValue(beta);
    const isOpen = vi.spyOn(sessionStore, "isOpen").mockReturnValue(false);
    const opened: Session[][] = [];
    const mutate = vi.spyOn(sessionStore, "mutate").mockImplementation((update) => {
      opened.push(typeof update === "function" ? update([]) : update);
    });
    focusStore.setState({ ...initialFocusState(false), projectTerminalFocused: true });
    mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 390, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 390, clientY: 150 });
    expect(opened).toEqual([[beta]]);
    expect(focusStore.getState()).toEqual({ composerFocused: true, projectTerminalFocused: false });
    for (const spy of [get, isOpen, mutate]) spy.mockRestore();
    restore();
  });

  it("moving the thread whose composer already holds the keyboard puts the caret back in that composer", () => {
    const restore = paneUnderPointer();
    const pane = document.createElement("div");
    pane.dataset.sessionDrop = "b";
    pane.innerHTML = '<div data-composer-input tabindex="0"></div>';
    document.body.append(pane);
    focusStore.setState({ composerFocused: true, projectTerminalFocused: false });
    mount();
    tab("Beta").focus();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 390, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 390, clientY: 150 });
    expect(document.activeElement).toBe(pane.firstElementChild);
    pane.remove();
    restore();
  });

  it("a release outside every pane drops nothing", () => {
    const restore = paneUnderPointer();
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 150 });
    expect(getExternalPaneDrop()).toEqual({ fromId: "b", overId: null, edge: "left" });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 150 });
    expect(dropThread).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    restore();
  });

  it("Escape cancels: the drop clears and the release does nothing", () => {
    const restore = paneUnderPointer();
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 390, clientY: 150 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(getExternalPaneDrop()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 390, clientY: 150 });
    expect(dropThread).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    restore();
  });
});

// What the title bar does: hold, draw and publish one model.
function Bar({ built }: { built: HeaderModel<ChipThread> }) {
  const shown = useHeldStripModel(built);
  useEffect(() => header.publish({ ...headerStore.getState(), model: shown }), [shown]);
  return strip({ model: shown });
}

describe("ThreadHeaderStrip: the held row is the published row", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const full: HeaderModel<ChipThread> = {
    live: ids.map((id) => chip(id, `T${id}`)),
    dormant: [],
    activeId: "a",
  };
  // "c" settled and left the live row.
  const departed: HeaderModel<ChipThread> = {
    live: full.live.filter((c) => c.id !== "c"),
    dormant: [{ ...chip("c", "Tc"), live: false }],
    activeId: "a",
  };
  const drawn = () => screen.getAllByRole("tab").map((el) => el.closest("[data-menu-id]")?.getAttribute("data-menu-id"));

  afterEach(() => {
    stripHold.set(false);
    headerStore.setState(initialHeaderState());
  });

  it("a chip whose thread settles while the pointer is over the strip stays until the pointer leaves", () => {
    const view = render(<Bar built={model} />);
    const row = screen.getByRole("tablist");
    fireEvent.pointerEnter(row);
    const settled = { ...model, live: model.live.filter((c) => c.id !== "b"), dormant: [chip("b", "Beta")] };
    view.rerender(<Bar built={settled} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    fireEvent.pointerLeave(row);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: /Beta/ })).toBeNull();
  });

  it("a project switch with the pointer over the strip shows only the new project's chips", () => {
    const view = render(<Bar built={model} />);
    fireEvent.pointerEnter(screen.getByRole("tablist"));
    const other = { live: [chip("x", "Other")], dormant: [], activeId: "x" };
    view.rerender(<Bar built={other} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([expect.stringContaining("Other")]);
  });

  it("with the pointer over the strip and a chip departed, ⌘5 picks the fifth chip drawn", async () => {
    const view = render(<Bar built={full} />);
    fireEvent.pointerEnter(screen.getByRole("tablist"));
    view.rerender(<Bar built={departed} />);
    expect(drawn()).toEqual(ids);
    await waitFor(() => expect(headerStore.getState().model.live.map((c) => c.id)).toEqual(ids));
    expect(slotTarget(headerStore.getState().model, 4)).toBe("e");
    expect(drawn()[4]).toBe("e");

    fireEvent.pointerLeave(screen.getByRole("tablist"));
    await waitFor(() => expect(drawn()).toEqual(["a", "b", "d", "e", "f"]));
    expect(slotTarget(headerStore.getState().model, 4)).toBe("f");
  });
});

describe("chipTitle", () => {
  it("reads an untitled chip and a bare harness title as New thread", () => {
    const titled = (title: string, provider?: string): StripChip => ({ ...chip("n", title), thread: { ...thread("n", title), provider } });
    expect(chipTitle(titled("claude", "claude"))).toBe("New thread");
    expect(chipTitle(titled("   "))).toBe("New thread");
    expect(chipTitle(titled("Fix the badge", "claude"))).toBe("Fix the badge");
  });
});
