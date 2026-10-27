// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import { virtualChunk } from "../surfaces/chunks";

const h = vi.hoisted(() => ({ metas: [] as SessionMeta[] }));
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
        onRenameSession={() => {}}
        onDeleteSession={() => {}}
        scroller={scroller}
      />
    </div>
  );
}

const shownChats = () => screen.queryAllByText(/^Chat \d+$/).length;

let restore: (() => void)[] = [];
beforeAll(async () => {
  await virtualChunk.load();
});
beforeEach(() => {
  forgetColumnMemory();
  h.metas = Array.from({ length: 40 }, (_, i) => chat(i));
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
  restore.forEach((r) => r());
  observers.length = 0;
});
afterAll(() => forgetColumnMemory());

describe("the workspace column across a remount", () => {
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
