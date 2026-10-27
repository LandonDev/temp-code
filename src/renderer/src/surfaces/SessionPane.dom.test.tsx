// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadState, Session } from "../lib/session";

const { retryLoad, block } = vi.hoisted(() => ({
  retryLoad: vi.fn(),
  block: { degraded: null as unknown, name: "box", text: null as string | null },
}));
vi.mock("../lib/tcserver/store", () => ({ sessionStore: { retryLoad, isDraft: () => false }, useQueue: () => [] }));
vi.mock("../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => block, ConnectionLine: () => null }));
vi.mock("../chrome/Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("../chrome/MacBridgeCards", () => ({ MacBridgeThreadCards: () => null }));
vi.mock("../lib/macBridge", () => ({ useMacBridgeRequests: () => [] }));
vi.mock("../chrome/AppshotFlyIn", () => ({ AppshotFlyIn: () => null }));
vi.mock("../lib/appshots", () => ({ noteActiveSession: () => {} }));
vi.mock("../chrome/MessageQueue", () => ({ MessageQueue: () => null }));
vi.mock("../chrome/SessionReview", () => ({ SessionReview: () => null }));
vi.mock("../lib/recents", () => ({ looksLikeProject: () => true }));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));
// Every chunk the pane warms is a stub, whichever ones it names: a new
// chunk import never leaves this suite red.
vi.mock("./chunks", () => new Proxy({}, { has: (_target, key) => key !== "then", get: (_target, key) => (key === "then" ? undefined : {}) }));
vi.mock("../lib/lazyChunk", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/lazyChunk")>()), preloadWhenIdle: () => {} }));
vi.mock("./EmptySession", () => ({ EmptySession: () => <div data-testid="empty-session" /> }));
vi.mock("./threads/ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));
vi.mock("./threads/WorkingStrip", () => ({ WorkingStrip: () => null }));
vi.mock("../lib/tcserver/commands", () => ({ focusSignal: { pane: () => {}, left: () => {} } }));
vi.mock("../lib/preconnect", () => ({ askPreconnect: () => {}, idleForPreconnect: () => false }));
vi.mock("../lib/notes", () => ({ createNote: () => {}, noteTitle: () => "" }));
vi.mock("../lib/settings", () => ({ loadNotesEnabled: () => true, subscribeNotesEnabled: () => () => {} }));

import { SessionPane, loadLineText } from "./SessionPane";
import { SessionActionsContext } from "./threadChat";

const NOW = 1_000_000;

function session(load: LoadState | undefined, blocks: Session["blocks"] = []): Session {
  return {
    id: "s1",
    environmentId: "env_box",
    harness: "claude",
    model: "claude:sonnet-5.5",
    modelSettings: {},
    runtimeMode: "supervised",
    title: "Box thread",
    cwd: "/srv/work/x",
    projectId: null,
    workspaceId: null,
    blocks,
    ...(load ? { load } : {}),
  } as Session;
}

const noop = () => {};
const actions = {
  onCwdChange: noop,
  onBranchChange: noop,
  onModelChange: noop,
  onModelSettingsChange: noop,
  onRuntimeModeChange: noop,
  onThreadTypeChange: noop,
  onSubmit: noop,
  onStop: noop,
  onApproval: noop,
  onNewTerminal: noop,
};
type Split = { inSplit?: boolean; focused?: boolean; onClose?: (id: string) => void };
function paneProps(s: Session, split: Split = {}) {
  return {
    session: s,
    visible: true,
    focused: split.focused ?? true,
    inSplit: split.inSplit ?? false,
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: split.onClose ?? noop,
    onOpenFile: noop,
    onOpenDiff: noop,
  };
}
function pane(s: Session, split: Split = {}) {
  return render(
    <SessionActionsContext.Provider value={actions}>
      <SessionPane {...paneProps(s, split)} />
    </SessionActionsContext.Provider>,
  );
}

const skeleton = () => document.querySelector('[data-surface-skeleton="transcript"]');
const line = () => document.querySelector("[data-load-line]");
const parts = () => [...(line()?.querySelectorAll("span > span") ?? [])].map((part) => part.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  block.degraded = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  retryLoad.mockReset();
});

describe("the pane while a transcript loads", () => {
  it("loading: the skeleton with the composer in place, no line and never the empty state", () => {
    pane(session({ phase: "loading", since: NOW, attempt: 0 }));
    expect(skeleton()).not.toBeNull();
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(line()).toBeNull();
    expect(screen.queryByTestId("empty-session")).toBeNull();
    expect(screen.queryByTestId("thread-view")).toBeNull();
  });

  it("loaded with no rows: the empty state, no skeleton", () => {
    pane(session({ phase: "loaded", since: NOW, attempt: 0 }));
    expect(screen.getByTestId("empty-session")).toBeTruthy();
    expect(skeleton()).toBeNull();
  });

  it("loaded with rows that fold to no blocks: the thread's own view, never the empty state", () => {
    pane(session({ phase: "loaded", since: NOW, attempt: 0, empty: false }));
    expect(screen.getByTestId("thread-view")).toBeTruthy();
    expect(screen.queryByTestId("empty-session")).toBeNull();
  });

  it("loaded and the host says it has no rows: the empty state", () => {
    pane(session({ phase: "loaded", since: NOW, attempt: 0, empty: true }));
    expect(screen.getByTestId("empty-session")).toBeTruthy();
  });

  it("an empty thread pinned as master opens its own view (the board), loaded or not", () => {
    const empty = session({ phase: "loaded", since: NOW, attempt: 0, empty: true });
    const { rerender } = pane(empty);
    expect(screen.getByTestId("empty-session")).toBeTruthy();
    // The host's meta push lands the pin on the same empty session.
    rerender(
      <SessionActionsContext.Provider value={actions}>
        <SessionPane {...paneProps({ ...empty, isMaster: true })} />
      </SessionActionsContext.Provider>,
    );
    expect(screen.getByTestId("thread-view")).toBeTruthy();
    expect(screen.queryByTestId("empty-session")).toBeNull();
    cleanup();
    pane({ ...session({ phase: "loading", since: NOW, attempt: 0 }), isMaster: true });
    expect(screen.getByTestId("thread-view")).toBeTruthy();
    expect(skeleton()).toBeNull();
  });

  it("rows on screen win over any phase", () => {
    pane(session({ phase: "slow", since: NOW, attempt: 0 }, [{ id: "b1", role: "user", text: "hi" } as Session["blocks"][number]]));
    expect(screen.getByTestId("thread-view")).toBeTruthy();
    expect(skeleton()).toBeNull();
    expect(line()).toBeNull();
  });

  it("slow: the skeleton and one line naming the host with the seconds ticking, and Retry", () => {
    pane(session({ phase: "slow", since: NOW - 12_000, attempt: 0 }));
    expect(skeleton()).not.toBeNull();
    expect(parts()).toEqual(["Waiting for box", "12 s"]);
    expect(screen.getByRole("button", { name: "Retry" }).dataset.slot).toBe("button");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(parts()).toEqual(["Waiting for box", "13 s"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryLoad).toHaveBeenCalledWith("s1");
  });

  it("failed: what went wrong, the countdown to the next try, and Retry now", () => {
    pane(session({ phase: "failed", since: NOW - 5_000, attempt: 3, error: "timed out", retryAt: NOW + 4_000 }));
    expect(skeleton()).not.toBeNull();
    expect(parts()).toEqual(["Box did not answer", "timed out", "retrying in 4 s"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(line()?.textContent).toContain("retrying in 3 s");
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retryLoad).toHaveBeenCalledWith("s1");
  });

  it("a host that is down says so once, above the composer, not here too", () => {
    block.degraded = { kind: "reconnecting" };
    pane(session({ phase: "failed", since: NOW, attempt: 1, error: "connection closed", retryAt: NOW + 1_000 }));
    expect(skeleton()).not.toBeNull();
    expect(line()).toBeNull();
  });
});

describe("the pane in a split", () => {
  it("has the pane header with the title, its focus and Close", () => {
    const onClose = vi.fn();
    pane(session({ phase: "loaded" }), { inSplit: true, focused: false, onClose });
    const header = document.querySelector<HTMLElement>("[data-pane-header]")!;
    expect(header.dataset.focused).toBe("false");
    expect(header.textContent).toContain("Box thread");
    expect(header.querySelector("[title]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("has no header alone in its tab", () => {
    pane(session({ phase: "loaded" }));
    expect(document.querySelector("[data-pane-header]")).toBeNull();
  });
});

describe("loadLineText", () => {
  it("words each phase in parts, with no dots or parentheses", () => {
    expect(loadLineText("box", { phase: "loading", since: NOW, attempt: 0 }, NOW)).toBeNull();
    expect(loadLineText("box", { phase: "loaded", since: NOW, attempt: 0 }, NOW)).toBeNull();
    expect(loadLineText("the box", { phase: "slow", since: NOW - 8_400, attempt: 0 }, NOW)).toEqual(["Waiting for the box", "8 s"]);
    expect(loadLineText("the box", { phase: "failed", since: NOW, attempt: 1, error: "connection closed", retryAt: NOW + 900 }, NOW)).toEqual([
      "The box did not answer",
      "connection closed",
      "retrying in 1 s",
    ]);
    expect(loadLineText("box", { phase: "failed", since: NOW, attempt: 1, retryAt: NOW - 1 }, NOW)).toEqual(["Box did not answer", "retrying…"]);
    expect(loadLineText("box", { phase: "failed", since: NOW, attempt: 1, error: "unknown session" }, NOW)).toEqual([
      "Box could not open this thread",
      "unknown session",
    ]);
  });
});
