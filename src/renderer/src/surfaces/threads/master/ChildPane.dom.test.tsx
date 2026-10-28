// @vitest-environment jsdom
/** A child opened from the board: Back and the title at once, the transcript's skeleton until its rows land. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Session } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";

const h = vi.hoisted(() => ({ meta: null as SessionMeta | null, session: undefined as Session | undefined }));
vi.mock("../../../lib/threads/agents", () => ({ useMetaById: () => h.meta, useSessionById: () => h.session }));
vi.mock("../../threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, newPassArmed: false, armNewPass: () => {} }),
}));
vi.mock("../ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));
const retryLoad = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/tcserver/store", () => ({ sessionStore: { retryLoad } }));
vi.mock("../../../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ name: "box", degraded: null }) }));
vi.mock("../../SessionPane", () => ({
  LoadLine: ({ load, onRetry }: { load: { phase: string }; onRetry: () => void }) =>
    load.phase === "failed" ? <button onClick={onRetry}>Retry now</button> : null,
}));

import { ChildPane } from "./ChildPane";

afterEach(() => {
  cleanup();
  h.meta = null;
  h.session = undefined;
});

const noop = () => {};
const pane = () =>
  render(<ChildPane sessionId="c1" environmentId="local" title="Home screen" focusComposer={false} onBack={noop} onOpenFile={noop} onOpenDiff={noop} />);
const skeleton = () => document.querySelector('[data-surface-skeleton="transcript"]');

describe("ChildPane", () => {
  it("shows Back and the board row's title with the skeleton before the thread is known", () => {
    pane();
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
    expect(screen.getByText("Home screen")).toBeTruthy();
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByTestId("thread-view")).toBeNull();
  });

  it("a failed load says so with Retry beside the skeleton", () => {
    h.meta = { id: "c1", environmentId: "local", title: "Home" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "failed", since: 0, attempt: 2 } } as unknown as Session;
    pane();
    expect(skeleton()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retryLoad).toHaveBeenCalledWith("c1");
  });

  it("holds focus on the pane while a Message open waits for the rows, so Escape still goes back", () => {
    const onBack = vi.fn();
    render(<ChildPane sessionId="c1" environmentId="local" title="Home screen" focusComposer onBack={onBack} onOpenFile={noop} onOpenDiff={noop} />);
    const root = document.querySelector("[data-child-pane]") as HTMLElement;
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "Escape" });
    expect(onBack).toHaveBeenCalled();
  });

  it("keeps the skeleton while the rows load, then shows the thread", () => {
    h.meta = { id: "c1", environmentId: "local", title: "Home" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "loading", since: 0, attempt: 0 } } as unknown as Session;
    const { rerender } = pane();
    expect(screen.getByText("Home")).toBeTruthy();
    expect(skeleton()).toBeTruthy();
    h.session = { id: "c1", blocks: [], load: { phase: "loaded", since: 0, attempt: 0 } } as unknown as Session;
    rerender(<ChildPane sessionId="c1" environmentId="local" title="Home screen" focusComposer={false} onBack={noop} onOpenFile={noop} onOpenDiff={noop} />);
    expect(skeleton()).toBeNull();
    expect(screen.getByTestId("thread-view")).toBeTruthy();
  });

  it("a paused child whose rows were never fetched shows the skeleton, then the thread once the store marks it loaded", () => {
    h.meta = { id: "c1", environmentId: "local", title: "Home", status: "paused" } as SessionMeta;
    h.session = { id: "c1", blocks: [] } as unknown as Session;
    const { rerender } = pane();
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByTestId("thread-view")).toBeNull();
    h.session = { id: "c1", blocks: [], loaded: true } as unknown as Session;
    rerender(<ChildPane sessionId="c1" environmentId="local" title="Home screen" focusComposer={false} onBack={noop} onOpenFile={noop} onOpenDiff={noop} />);
    expect(skeleton()).toBeNull();
    expect(screen.getByTestId("thread-view")).toBeTruthy();
  });

  it("an errored child with no rows fetched is a skeleton too, never a blank body", () => {
    h.meta = { id: "c1", environmentId: "local", title: "Home", status: "error" } as SessionMeta;
    h.session = { id: "c1", blocks: [] } as unknown as Session;
    pane();
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByTestId("thread-view")).toBeNull();
  });

  it("an empty thread the host answered opens its view", () => {
    h.meta = { id: "c1", environmentId: "local", title: "Home" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "loaded", since: 0, attempt: 0, empty: true } } as unknown as Session;
    pane();
    expect(screen.getByTestId("thread-view")).toBeTruthy();
  });
});
