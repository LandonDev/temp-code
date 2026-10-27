// @vitest-environment jsdom
/**
 * The panel yields to the thread (docs/LAYOUT.md "The right side"): in a
 * row too narrow for THREAD_MIN + PANEL_MIN it is not drawn, keeps its open
 * state, and returns when the row widens; between, it shrinks.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_MIN, rightPanel, THREAD_MIN } from "../../lib/rightPanel";
import type { Session } from "../../lib/session";

vi.mock("../chunks", () => ({
  threadViewsChunk: { surface: () => () => null },
  rightPanelChunk: {
    surface: () => (props: { width?: number }) => <aside aria-label="Thread panel" data-width={props.width} />,
  },
}));
vi.mock("./ChatView", () => ({ ChatView: () => <div data-chat /> }));
vi.mock("../../lib/masterThread", () => ({ isMasterThread: () => false }));

import { ThreadView } from "./ThreadView";

let resize: (width: number) => void = () => {};
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe() {
    resize = (width) => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  rightPanel.reset();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = { id: "t1", parentId: null, threadType: "chat" } as unknown as Session;
const view = () =>
  render(
    <ThreadView
      session={session}
      composing={false}
      onArmNewPass={() => {}}
      onOpenFile={() => {}}
      onOpenDiff={() => {}}
      {...({} as never)}
    />,
  );
const panel = () => screen.queryByRole("complementary", { name: "Thread panel" });

describe("ThreadView's panel", () => {
  it("hides with no room, keeps its open state, and returns when the row widens", () => {
    rightPanel.open("t1");
    view();
    act(() => resize(1200));
    expect(panel()?.getAttribute("data-width")).toBe("320");

    act(() => resize(THREAD_MIN + 280));
    expect(panel()?.getAttribute("data-width")).toBe("280");

    act(() => resize(THREAD_MIN + PANEL_MIN - 1));
    expect(panel()).toBeNull();
    expect(rightPanel.get("t1").open).toBe(true);
    expect(rightPanel.hasRoom("t1")).toBe(false);

    act(() => resize(1000));
    expect(panel()).not.toBeNull();
    expect(rightPanel.hasRoom("t1")).toBe(true);
  });

  it("gives the room back when the thread leaves the screen", () => {
    rightPanel.open("t1");
    const { unmount } = view();
    act(() => resize(400));
    expect(rightPanel.hasRoom("t1")).toBe(false);
    unmount();
    expect(rightPanel.hasRoom("t1")).toBe(true);
  });
});
