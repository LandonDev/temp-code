// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { menuChunk, virtualChunk } from "../surfaces/chunks";
import { resetMenus, warmMenus } from "./menuRows";

const h = vi.hoisted(() => ({ metas: [] as SessionMeta[], renamed: [] as [string, string][] }));
vi.mock("../lib/tcserver/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/store")>()),
  useSessionMetas: () => h.metas,
}));
vi.mock("../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/workspaces")>()),
  useWorkspaceCatalog: () => ({ projects: [], workspaces: [] }),
}));

import WorkspaceSessions, { forgetColumnMemory } from "./WorkspaceSessions";

const chat = (i: number): SessionMeta =>
  ({
    environmentId: "local",
    id: `c${i}`,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    title: `Chat ${i}`,
    cwd: "~",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 1000 - i,
  }) as SessionMeta;

/** The ResizeObservers the virtualizer made, driven by hand: jsdom has none. */
const observers: { cb: ResizeObserverCallback; els: Set<Element> }[] = [];
class FakeResizeObserver {
  entry: { cb: ResizeObserverCallback; els: Set<Element> };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, els: new Set() };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.els.add(el);
  }
  unobserve(el: Element) {
    this.entry.els.delete(el);
  }
  disconnect() {
    this.entry.els.clear();
  }
}

/** The sidebar's shape: the scroller in state through a callback ref, the
 *  whole column unmounted while Settings shows (Sidebar.tsx). */
function Column({ shown }: { shown: boolean }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setScroller(el), []);
  if (!shown) return null;
  return (
    <div ref={ref} data-testid="scroller" style={{ overflowY: "auto" }}>
      <WorkspaceSessions
        workspaceId={null}
        selectedProjectId={null}
        onSelectProject={() => {}}
        onOpenSession={() => {}}
        onNewChat={() => {}}
        onNewProject={() => {}}
        onRenameSession={(id, title) => h.renamed.push([id, title])}
        onDeleteSession={() => {}}
        scroller={scroller}
      />
    </div>
  );
}

const shownChats = () => screen.queryAllByText(/^Chat \d+$/).length;

let restore: (() => void)[] = [];
beforeEach(() => {
  forgetColumnMemory();
  resetMenus();
  vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => h.metas.find((m) => m.id === id) ?? null);
  h.metas = Array.from({ length: 40 }, (_, i) => chat(i));
  h.renamed = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 260 });
  restore = [
    () => height && Object.defineProperty(HTMLElement.prototype, "offsetHeight", height),
    () => width && Object.defineProperty(HTMLElement.prototype, "offsetWidth", width),
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restore.forEach((r) => r());
  observers.length = 0;
});
afterAll(() => forgetColumnMemory());

/** Right-click on a row's label, on the row, and on blank space under the list. */
async function rightClicks() {
  await act(async () => {
    await menuChunk.load();
    warmMenus();
  });
  const rowsFor = vi.spyOn(sessionStore, "metaOf");
  const label = screen.getByText("Chat 3");
  const row = label.closest<HTMLElement>("[data-menu-id]")!;
  expect(row.getAttribute("data-menu-id")).toBe("c3");
  fireEvent.contextMenu(label);
  expect(rowsFor).toHaveBeenCalledWith("c3");
  const menu = await screen.findByRole("menu", { name: "Thread actions" });
  expect(within(menu).getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
  fireEvent.keyDown(menu, { key: "Escape" });
  await act(async () => {});
  fireEvent.contextMenu(row);
  expect(await screen.findByRole("menu", { name: "Thread actions" })).toBeTruthy();
}

describe("a right-click on a rail row", () => {
  it("opens the thread's menu in the plain list", async () => {
    expect(virtualChunk.loaded()).toBeNull();
    const view = render(<Column shown />);
    expect(view.container.querySelector("[data-index].absolute")).toBeNull();
    await rightClicks();
  });

  it("opens the thread's menu in the virtual list, and blank space opens nothing", async () => {
    await act(async () => {
      await virtualChunk.load();
    });
    const view = render(<Column shown />);
    expect(view.container.querySelector("[data-index].absolute")).not.toBeNull();
    await rightClicks();
    cleanup();
    resetMenus();
    const again = render(<Column shown />);
    fireEvent.contextMenu(again.container.querySelector(".px-2.pt-2.pb-2 > div")!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("menu", { name: "Thread actions" })).toBeNull();
  });
});

describe("the workspace column across a remount", () => {
  beforeAll(async () => {
    await virtualChunk.load();
  });

  it("shows every row again when it mounts with the virtualizer already loaded", () => {
    const view = render(<Column shown />);
    expect(view.container.querySelector(".relative.w-full")).not.toBeNull();
    expect(shownChats()).toBe(32);
    view.rerender(<Column shown={false} />);
    expect(shownChats()).toBe(0);
    view.rerender(<Column shown />);
    expect(shownChats()).toBe(32);
    expect(screen.getByText("8 more")).toBeTruthy();
  });

  it("comes back at its offset, with its pages and its Chats fold", () => {
    const view = render(<Column shown />);
    fireEvent.click(screen.getByText("8 more"));
    expect(shownChats()).toBe(40);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 248;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Column shown={false} />);
    view.rerender(<Column shown />);
    const again = screen.getByTestId("scroller");
    expect(again).not.toBe(scroller);
    expect(again.scrollTop).toBe(248);
    expect(shownChats()).toBe(40);
    expect(screen.queryByText("8 more")).toBeNull();
  });
});

describe("an inline rename of a rail thread ended from the keyboard", () => {
  it("gives focus back to the row's More: Escape saves nothing, Enter saves once", async () => {
    render(<Column shown />);
    const row = () => screen.getByText("Chat 3").closest<HTMLElement>("[data-thread-row]")!;
    const field = () => screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.doubleClick(row());
    fireEvent.keyDown(field(), { key: "Escape" });
    await act(async () => {});
    expect(document.activeElement).toBe(row().querySelector('[aria-label="More"]'));
    expect(h.renamed).toEqual([]);
    fireEvent.doubleClick(row());
    fireEvent.change(field(), { target: { value: "Chat three" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await act(async () => {});
    expect(h.renamed).toEqual([["c3", "Chat three"]]);
    // The store has not heard the new title: the row still reads the old one.
    expect(document.activeElement).toBe(row().querySelector('[aria-label="More"]'));
  });
});
