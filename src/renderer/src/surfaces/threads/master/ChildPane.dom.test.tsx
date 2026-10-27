// @vitest-environment jsdom
/** A child opened from the board: Back and the title at once, the transcript's skeleton until its rows land. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";

const h = vi.hoisted(() => ({ meta: null as SessionMeta | null, session: undefined as Session | undefined }));
vi.mock("../../../lib/threads/agents", () => ({ useMetaById: () => h.meta, useSessionById: () => h.session }));
vi.mock("../../threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, newPassArmed: false, armNewPass: () => {} }),
}));
vi.mock("../ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));

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
});
