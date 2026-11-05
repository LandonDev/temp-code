// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { menuChunk, virtualChunk } from "../surfaces/chunks";
import { resetMenus, warmMenus } from "./menuRows";

const h = vi.hoisted(() => ({
  metas: [] as SessionMeta[],
  renamed: [] as [string, string][],
  catalog: { projects: [], workspaces: [] } as { projects: ProjectMeta[]; workspaces: WorkspaceMeta[] },
}));
vi.mock("../lib/tcserver/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/store")>()),
  useSessionMetas: () => h.metas,
}));
vi.mock("../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/workspaces")>()),
  useWorkspaceCatalog: () => h.catalog,
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
function Column({ shown, scope = null, active }: { shown: boolean; scope?: string | null; active?: string }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setScroller(el), []);
  if (!shown) return null;
  return (
    <div ref={ref} data-testid="scroller" style={{ overflowY: "auto" }}>
      <WorkspaceSessions
        key={scope ?? "home"}
        workspaceId={scope}
        selectedProjectId={null}
        activeSessionId={active}
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
const workspace = (id: string) => ({ environmentId: "local", id, name: id, path: `/${id}`, createdAt: 1 }) as WorkspaceMeta;

let restore: (() => void)[] = [];
beforeEach(() => {
  forgetColumnMemory();
  resetMenus();
  vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => h.metas.find((m) => m.id === id) ?? null);
  h.metas = Array.from({ length: 40 }, (_, i) => chat(i));
  h.renamed = [];
  h.catalog = { projects: [], workspaces: [] };
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

describe("a loose chat's column across Settings", () => {
  beforeAll(async () => {
    await virtualChunk.load();
  });

  it("keeps a small offset with the loose chat selected", () => {
    const view = render(<Column shown active="c2" />);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 14;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Column shown={false} active="c2" />);
    view.rerender(<Column shown active="c2" />);
    expect(screen.getByTestId("scroller").scrollTop).toBe(14);
  });

  /** A scroller that clamps like a browser's: it scrolls at most `room` px. */
  function clamping(el: HTMLElement, room: { px: number }) {
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, room.px));
      },
    });
  }
  const growList = () =>
    act(() => {
      for (const o of observers) o.cb([...o.els].map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
    });

  it("comes back at its offset when the list first lays out shorter than it measures", () => {
    const room = { px: 14 };
    const view = render(<Column shown active="c2" />);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 14;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Column shown={false} active="c2" />);
    // Back: the new scroller, its list laid out from estimates, has 4px of room.
    room.px = 4;
    const proto = HTMLDivElement.prototype;
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get() {
        if (this.dataset.testid === "scroller" && !Object.getOwnPropertyDescriptor(this, "scrollTop")) clamping(this, room);
        return Object.getOwnPropertyDescriptor(this, "scrollTop")?.get?.call(this) ?? scrollTop.get!.call(this);
      },
      set(v: number) {
        if (this.dataset.testid === "scroller" && !Object.getOwnPropertyDescriptor(this, "scrollTop")) clamping(this, room);
        const own = Object.getOwnPropertyDescriptor(this, "scrollTop");
        if (own?.set) own.set.call(this, v);
        else scrollTop.set!.call(this, v);
      },
    });
    try {
      view.rerender(<Column shown active="c2" />);
      const again = screen.getByTestId("scroller");
      expect(again.scrollTop).toBe(4);
      // The rows measure: the list is its full height, the offset fits again.
      room.px = 14;
      growList();
      expect(again.scrollTop).toBe(14);
      // A scroll by the person from here is theirs to keep.
      again.scrollTop = 6;
      act(() => {
        again.dispatchEvent(new Event("scroll"));
      });
      growList();
      expect(again.scrollTop).toBe(6);
    } finally {
      delete (proto as { scrollTop?: number }).scrollTop;
    }
  });
});

describe("the workspace column across a workspace switch", () => {
  beforeAll(async () => {
    await virtualChunk.load();
  });

  it("each scope comes back at its own offset, a fresh one at the top, and keeps its own Chats fold", () => {
    h.catalog = { projects: [], workspaces: [workspace("w1"), workspace("w2")] };
    h.metas = Array.from({ length: 40 }, (_, i) => ({ ...chat(i), workspaceId: "w1" }));
    const view = render(<Column shown scope="w1" />);
    const scroller = screen.getByTestId("scroller");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(shownChats()).toBe(0);
    scroller.scrollTop = 248;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<Column shown scope="w2" />);
    // The sidebar's scroller stays; the new scope starts where it was, at the top.
    expect(screen.getByTestId("scroller")).toBe(scroller);
    expect(scroller.scrollTop).toBe(0);
    view.rerender(<Column shown scope="w1" />);
    expect(scroller.scrollTop).toBe(248);
    expect(shownChats()).toBe(0);
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

describe("the Chats fold", () => {
  const chatsFold = (root: HTMLElement) => screen.getByText("Chats").closest<HTMLElement>("[data-fold-spaced], [data-index]") ?? root;

  it("starts 16px below the project cards, a new group", () => {
    h.catalog = {
      workspaces: [{ environmentId: "local", id: "w1", name: "Work", path: "/w1", createdAt: 1 } as WorkspaceMeta],
      projects: [
        { environmentId: "local", id: "p1", workspaceId: "w1", name: "Alpha", mode: "local", branch: "main", cwd: "/w1", archived: false, createdAt: 1 } as ProjectMeta,
      ],
    };
    h.metas = Array.from({ length: 3 }, (_, i) => ({ ...chat(i), workspaceId: "w1" }));
    const view = render(<Column shown scope="w1" />);
    expect(view.container.querySelector("[data-project-card]")).not.toBeNull();
    const fold = chatsFold(view.container);
    expect(fold.getAttribute("data-fold-spaced")).toBe("true");
    expect(fold.className).toContain("pt-3");
  });

  it("its heading has no fill, open or folded: only a card sits on one", () => {
    h.catalog = { projects: [], workspaces: [workspace("w1")] };
    h.metas = Array.from({ length: 3 }, (_, i) => ({ ...chat(i), workspaceId: "w1" }));
    const view = render(<Column shown scope="w1" />);
    const heading = screen.getByRole("button", { name: /^Chats/ });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.className).toContain("aria-expanded:bg-transparent");
    expect(heading.className).not.toMatch(/(^|\s)aria-expanded:bg-foreground/);
    expect(view.container.querySelector('[class*="sidebar-group"]')).toBeNull();
  });

  it("starts at the top of the home, where no card comes before it", () => {
    const view = render(<Column shown />);
    expect(view.container.querySelector("[data-project-card]")).toBeNull();
    expect(view.container.querySelector("[data-fold-spaced]")).toBeNull();
    expect(view.container.querySelector(".pt-3")).toBeNull();
  });

  it("is no fold at the home: the column's header says Chats and holds New thread", () => {
    render(<Column shown />);
    expect(screen.queryByText("Chats")).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(shownChats()).toBe(32);
  });
});

describe("a project card's menu", () => {
  it("offers the fleet switches over the project and its copies, and no hand-made pause, stop or continue", async () => {
    await act(async () => {
      await menuChunk.load();
      warmMenus();
    });
    const project = { environmentId: "local", id: "p1", workspaceId: "w1", name: "app", mode: "local", branch: null, cwd: "/w1/app", createdAt: 1, updatedAt: 1, archived: false } as unknown as ProjectMeta;
    h.catalog = { projects: [project], workspaces: [workspace("w1")] };
    h.metas = [{ ...chat(1), projectId: "p1", workspaceId: "w1", cwd: "/w1/app", status: "running", busySince: 1 } as SessionMeta];
    vi.spyOn(sessionStore, "metas").mockImplementation(() => h.metas);
    render(<Column shown scope="w1" />);
    const card = document.querySelector<HTMLElement>("[data-project-card]")!.parentElement!;
    fireEvent.click(within(card).getAllByRole("button", { name: "More" })[0]);
    const menu = await screen.findByRole("menu");
    const names = within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(["Pause all", "Resume all", "Stop all"]));
    expect(names).not.toContain("Archive done");
    for (const gone of ["Continue paused threads", "Pause active threads", "Stop active threads"]) expect(names).not.toContain(gone);
    // Counted over the scope: one thread runs, none is paused.
    expect(within(menu).getByRole("menuitem", { name: /Pause all/ }).getAttribute("aria-disabled")).not.toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /Resume all/ }).getAttribute("aria-disabled")).toBe("true");
  });
});
