// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slotTarget, type HeaderModel } from "../lib/threadHeaderModel";
import { getExternalPaneDrop } from "../lib/paneDrop";
import type { Session } from "../lib/session";
import { sessionStore } from "../lib/tcserver/store";
import { focusStore, initialFocusState } from "../stores/focus";
import { header, headerStore, initialHeaderState, stripHold, useHeldStripModel } from "../stores/header";

const { dropThread, hosts } = vi.hoisted(() => ({
  dropThread: vi.fn(),
  hosts: { environments: [] as { id: string; name: string }[], offline: new Set<string>() },
}));
vi.mock("../stores/workspaceActions", () => ({ workspaceActions: { dropThread } }));
vi.mock("../lib/connection/status", () => ({ useEnvironments: () => hosts.environments }));
vi.mock("./hostOffline", () => ({
  useHostsOffline: (ids: readonly (string | undefined)[]) => ids.some((id) => !!id && hosts.offline.has(id)),
}));
vi.mock("./HostGlyph", () => ({
  HostGlyph: ({ environmentId }: { environmentId?: string }) => <span data-host-glyph={environmentId} />,
}));

import { tooltipChunk, warmTooltips } from "../components/ui/tooltip";
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
const liveRow = () => screen.getByRole("tablist", { name: "Threads" });
const shelfRow = () => screen.queryByRole("tablist", { name: "Settled threads" });

afterEach(() => {
  cleanup();
  hosts.environments = [];
  hosts.offline.clear();
});

describe("ThreadHeaderStrip pointer", () => {
  it("mounts no tooltip trigger on the home's title when it fits", async () => {
    await act(async () => { await tooltipChunk.load(); warmTooltips(); });
    const { container } = mount({ model: { ...model, live: [], dormant: [], heading: chip("home", "A short title") } });
    expect(container.querySelector("[data-home-heading]")?.textContent).toBe("A short title");
    expect(container.querySelector("[data-home-heading]")?.getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

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

  it("a chip holds the pointer while it is pressed, so a drag over an iframe keeps its release; a cancel clears the drop hint", () => {
    const restore = paneUnderPointer();
    mount();
    const beta = tab("Beta");
    const capture = vi.fn();
    const release = vi.fn();
    beta.setPointerCapture = capture;
    beta.releasePointerCapture = release;
    beta.hasPointerCapture = () => true;
    fireEvent.pointerDown(beta, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    expect(capture).toHaveBeenCalledWith(9);
    fireEvent.pointerMove(window, { clientX: 60, clientY: 80 });
    expect(getExternalPaneDrop()).not.toBeNull();
    fireEvent.pointerCancel(window);
    expect(getExternalPaneDrop()).toBeNull();
    expect(release).toHaveBeenCalledWith(9);
    restore();
  });


  it("the strip's rows take clicks: they are out of the window's drag region", () => {
    mount();
    for (const row of document.querySelectorAll("[data-strip]")) {
      expect(row.getAttribute("data-tauri-drag-region")).toBe("false");
    }
    expect(document.querySelectorAll("[data-strip]").length).toBeGreaterThan(0);
  });
});

describe("ThreadHeaderStrip rows", () => {
  const settled = (id: string, title: string): StripChip => ({ ...chip(id, title), live: false });
  const twoRows: HeaderModel<ChipThread> = {
    live: [chip("a", "Alpha"), chip("b", "Beta")],
    dormant: [settled("s", "Settled one"), settled("t", "Settled two")],
    activeId: "t",
  };

  it("draws the live row alone while nothing has settled", () => {
    mount();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(shelfRow()).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Gamma"),
    ]);
  });

  it("folds the shelf in and out on .collapsible-auto, never growing the header in one frame", async () => {
    const view = mount({ model: twoRows });
    const fold = document.querySelector("[data-shelf-fold]")!;
    expect(fold.classList.contains("collapsible-auto")).toBe(true);
    expect(fold.contains(shelfRow())).toBe(true);
    view.rerender(strip({ model: { ...twoRows, dormant: [], activeId: "a" } }));
    await waitFor(() => expect(document.querySelector("[data-shelf-fold]")).toBeNull());
  });

  it("leaves the focus ring to the global outline: no ring classes on a chip", () => {
    mount({ model: twoRows });
    for (const chip of screen.getAllByRole("tab")) expect(chip.className).not.toMatch(/(^|\s)(focus-visible:)?ring-/);
  });

  it("draws the settled chips on a shelf under the live row, the active one selected there", () => {
    mount({ model: twoRows });
    const shelf = shelfRow()!;
    expect([...shelf.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Settled one", "Settled two"]);
    expect([...liveRow().querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Alpha", "Beta"]);
    expect(tab("Settled two").getAttribute("aria-selected")).toBe("true");
    expect(tab("Alpha").getAttribute("aria-selected")).toBe("false");
    // Each row has its own Tab stop: the active chip on the shelf, the first on the live row.
    expect(tab("Settled two").tabIndex).toBe(0);
    expect(tab("Alpha").tabIndex).toBe(0);
    expect(tab("Settled one").tabIndex).toBe(-1);
    // A shelf chip is the quiet variant and never shows a status mark.
    expect(tab("Settled one").dataset.shelf).toBe("true");
    expect(tab("Settled one").querySelector('[data-slot="status-mark"]')).toBeNull();
  });

  it("arrows move within a row, and a shelf chip opens its menu and drags like a live one", async () => {
    const restore = paneUnderPointer();
    const { onContextMenu, onSelect } = mount({ model: twoRows });
    tab("Settled one").focus();
    fireEvent.keyDown(tab("Settled one"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Settled two"));
    fireEvent.keyDown(tab("Settled two"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Settled one"));
    fireEvent.pointerDown(tab("Settled one"), { button: 0, clientX: 380, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 390, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 390, clientY: 150 });
    expect(dropThread).toHaveBeenCalledWith("s", "p1", "right");
    expect(onSelect).not.toHaveBeenCalled();
    dropThread.mockReset();
    restore();
    fireEvent.contextMenu(tab("Settled one"));
    await waitFor(() => expect(onContextMenu).toHaveBeenCalledWith("s"));
  });

  it("a click on the active chip selects it too, so its pane takes focus", () => {
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Alpha"), { button: 0 });
    fireEvent.pointerUp(window);
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("New thread sits after the live row, outside it", () => {
    mount({ trailing: <button type="button">New thread</button> });
    const plus = screen.getByRole("button", { name: "New thread" });
    expect(plus.closest('[role="tablist"]')).toBeNull();
  });

  it("the scroll arrows sit over the live row's own box, never over the end group", () => {
    const onScrollBy = vi.fn();
    mount({
      overflow: { left: true, right: true },
      onScrollBy,
      end: <button type="button">Panel</button>,
    });
    const right = screen.getByRole("button", { name: "Scroll threads right" });
    const box = right.parentElement!.closest(".relative")!;
    expect(box.contains(liveRow())).toBe(true);
    expect(box.contains(screen.getByRole("button", { name: "Panel" }))).toBe(false);
    fireEvent.click(right);
    fireEvent.click(screen.getByRole("button", { name: "Scroll threads left" }));
    expect(onScrollBy.mock.calls).toEqual([[1], [-1]]);
    // 28px arrows beside the 28px chips, and the row pads each end by the arrow's room.
    expect(right.className).toContain("size-7");
    expect((box as HTMLElement).style.getPropertyValue("--strip-pad-r")).toBe("36px");
  });

  it("shows the host glyph after the title with two hosts, none with one, and tints an offline host's chip", () => {
    const onHost = (c: StripChip, environmentId: string): StripChip => ({ ...c, thread: { ...c.thread, environmentId } });
    const hosted = {
      ...twoRows,
      live: [onHost(chip("a", "Alpha"), "local"), onHost(chip("b", "Beta"), "env_box")],
      dormant: [onHost(settled("s", "Settled one"), "env_box")],
    };
    const view = mount({ model: hosted });
    expect(document.querySelector("[data-host-glyph]")).toBeNull();
    view.unmount();
    hosts.environments = [
      { id: "local", name: "This Mac" },
      { id: "env_box", name: "The box" },
    ];
    hosts.offline.add("env_box");
    mount({ model: hosted });
    const glyphOf = (name: string) => tab(name).querySelector("[data-host-glyph]")?.getAttribute("data-host-glyph");
    expect(glyphOf("Alpha")).toBe("local");
    expect(glyphOf("Settled one")).toBe("env_box");
    // The glyph follows the title.
    const alpha = tab("Alpha");
    expect([...alpha.children].indexOf(alpha.querySelector("[data-host-glyph]")!)).toBeGreaterThan(
      [...alpha.children].findIndex((el) => el.textContent === "Alpha"),
    );
    const offline = (name: string) => tab(name).closest("[data-menu-id]")!.hasAttribute("data-host-offline");
    expect(offline("Beta")).toBe(true);
    expect(offline("Settled one")).toBe(true);
    expect(offline("Alpha")).toBe(false);
  });
});

describe("ThreadHeaderStrip chip", () => {
  it("a master chip that needs you reads its status glyph in the type glyph's place, the title and Master, and carries no title attribute", () => {
    const waiting: StripChip = { ...chip("a", "Alpha"), status: "waiting", thread: { ...thread("a", "Alpha"), status: "waiting" } };
    mount({ masterIds: new Set(["a"]), model: { ...model, live: [waiting, ...model.live.slice(1)] } });
    const el = tab("Alpha");
    expect(el.children).toHaveLength(3);
    const slot = el.children[0]!;
    expect(slot.hasAttribute("data-chip-glyph")).toBe(true);
    // The live mark stands in for the type glyph, as a tab's favicon turns into a spinner.
    expect(slot.querySelector("svg[data-type-glyph]")).toBeNull();
    expect(slot.querySelectorAll('[data-slot="status-mark"]')).toHaveLength(1);
    expect(el.querySelector('[data-slot="status-mark"]')?.getAttribute("aria-label")).toBe("Needs you");
    expect(el.textContent).toBe("AlphaMaster");
    // A settled chip says nothing at rest: its type glyph is back.
    expect(tab("Beta").querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(tab("Beta").querySelector("[data-chip-glyph] svg[data-type-glyph]")).toBeTruthy();
    for (const el of document.querySelectorAll("[role=tab], [role=tab] *")) expect(el.hasAttribute("title")).toBe(false);
  });

  it("a chip keeps its structure and slots working or at rest, and an unread title holds the bold width", () => {
    const working: StripChip = { ...chip("a", "Alpha"), status: "running", thread: { ...thread("a", "Alpha"), status: "running" } };
    const unread: StripChip = { ...chip("b", "Beta"), unread: true };
    mount({ model: { ...model, live: [working, unread, model.live[2]!] } });
    const shape = (name: string) => [...tab(name).children].map((c) => c.getAttribute("data-chip-glyph") !== null ? "glyph" : c.hasAttribute("data-chip-title") ? "title" : c.tagName);
    expect(shape("Alpha")).toEqual(["glyph", "title"]);
    expect(shape("Gamma")).toEqual(["glyph", "title"]);
    expect(tab("Alpha").querySelector("[data-chip-glyph]")!.className).toContain("size-3.5");
    // The title's ::after is an unseen medium-weight copy with no height.
    const title = tab("Beta").querySelector<HTMLElement>("[data-chip-title]")!;
    expect(title.getAttribute("data-text")).toBe("Beta");
    expect(title.className).toEqual(expect.stringContaining("after:content-[attr(data-text)]"));
    expect(title.className).toEqual(expect.stringContaining("after:font-medium"));
    expect(title.className).toEqual(expect.stringContaining("after:h-0"));
    expect(title.className).toEqual(expect.stringContaining("after:invisible"));
  });

  it("tints every chip's type glyph, active or not; a chip with no type draws chat's", () => {
    const research: StripChip = { ...chip("b", "Beta"), thread: { ...thread("b", "Beta"), threadType: "research" } };
    const untyped: StripChip = { ...chip("c", "Gamma"), thread: { ...thread("c", "Gamma"), threadType: null } };
    mount({ model: { ...model, live: [model.live[0]!, research, untyped] } });
    const glyph = (name: string) => tab(name).querySelector("svg[data-type-glyph]")!;
    expect(tab("Alpha").getAttribute("aria-selected")).toBe("true");
    expect(glyph("Alpha").getAttribute("class")).toContain("text-type-chat");
    expect(tab("Beta").getAttribute("aria-selected")).toBe("false");
    expect(glyph("Beta").getAttribute("class")).toContain("text-type-research");
    expect(glyph("Gamma").getAttribute("data-type-glyph")).toBe("chat");
    expect(glyph("Gamma").getAttribute("class")).toContain("text-type-chat");
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
    expect(chipStatus(working, {})).toEqual({ state: "working", detail: "Typecheck", tally: "3/7" });
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
    expect(container.textContent).toBe("AlphaWorkingRunning bun3/7");
    cleanup();
    // While the mark stands in for the glyph, the hover line names the type.
    const { container: typed } = render(<ChipHoverLabel title="Alpha" status={chipStatus(working, {})} type="Implementation" />);
    expect(typed.textContent).toBe("AlphaWorkingRunning bun3/7Implementation");
  });
});

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

describe("ThreadHeaderStrip chip drag", () => {
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
  const drawn = () =>
    [...liveRow().querySelectorAll('[role="tab"]')].map((el) => el.closest("[data-menu-id]")?.getAttribute("data-menu-id"));

  afterEach(() => {
    stripHold.set(false);
    headerStore.setState(initialHeaderState());
  });

  const settledBeta = () => ({ ...model, live: model.live.filter((c) => c.id !== "b"), dormant: [{ ...chip("b", "Beta"), live: false }] });
  const liveIds = () => [...liveRow().querySelectorAll('[role="tab"]')].map((t) => t.textContent);

  it("a chip whose thread settles while the pointer is over the strip stays until the pointer leaves, then joins the shelf", () => {
    const view = render(<Bar built={model} />);
    const region = liveRow().closest("[data-strip-region]")!;
    fireEvent.pointerEnter(region);
    view.rerender(<Bar built={settledBeta()} />);
    expect(liveIds()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(shelfRow()).toBeNull();
    fireEvent.pointerLeave(region);
    expect(liveIds()).toEqual(["Alpha", "Gamma"]);
    expect([...shelfRow()!.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Beta"]);
  });

  it("the window losing focus ends the hold, and so does the page hiding", () => {
    for (const end of ["blur", "hidden"] as const) {
      const view = render(<Bar built={model} />);
      fireEvent.pointerEnter(liveRow());
      view.rerender(<Bar built={settledBeta()} />);
      expect(liveIds()).toEqual(["Alpha", "Beta", "Gamma"]);
      if (end === "blur") fireEvent(window, new Event("blur"));
      else {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        fireEvent(document, new Event("visibilitychange"));
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
      expect(liveIds()).toEqual(["Alpha", "Gamma"]);
      view.unmount();
    }
  });

  it("a project switch with the pointer over the strip shows only the new project's chips", () => {
    const view = render(<Bar built={model} />);
    fireEvent.pointerEnter(liveRow());
    const other = { live: [chip("x", "Other")], dormant: [], activeId: "x" };
    view.rerender(<Bar built={other} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([expect.stringContaining("Other")]);
  });

  it("with the pointer over the strip and a chip departed, ⌘5 picks the fifth chip drawn", async () => {
    const view = render(<Bar built={full} />);
    fireEvent.pointerEnter(liveRow());
    view.rerender(<Bar built={departed} />);
    expect(drawn()).toEqual(ids);
    await waitFor(() => expect(headerStore.getState().model.live.map((c) => c.id)).toEqual(ids));
    expect(slotTarget(headerStore.getState().model, 4)).toBe("e");
    expect(drawn()[4]).toBe("e");

    fireEvent.pointerLeave(liveRow());
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
