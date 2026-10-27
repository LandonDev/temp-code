// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../lib/session";

const { state, openSettings } = vi.hoisted(() => ({
  state: { session: undefined as Session | undefined, listed: true },
  openSettings: vi.fn(),
}));
vi.mock("../lib/tcserver/store", () => ({
  useSession: () => state.session,
  sessionStore: { hasListed: () => state.listed, ensureLoaded: () => Promise.resolve() },
}));
vi.mock("./SessionPane", () => ({ SessionPane: () => <div data-testid="session-pane" /> }));
vi.mock("./FilePane", () => ({ FilePane: () => null }));
vi.mock("../lib/threadResources", () => ({ hostName: (id: string) => (id === "env_box" ? "box" : "this Mac") }));
vi.mock("../stores/shell", () => ({ shell: { openSettings } }));

import { SessionLeaf } from "./PaneTree";

afterEach(() => {
  cleanup();
  openSettings.mockClear();
  state.session = undefined;
  state.listed = true;
});

const base = { visible: true, focused: true, inSplit: false, composerFocused: false, recents: [], onFocus: () => {}, onOpenFile: () => {}, onOpenDiff: () => {} };

function thread(phase: "loading" | "gone"): Session {
  return {
    id: "t1",
    environmentId: "env_box",
    harness: "claude",
    model: "claude:sonnet-5.5",
    modelSettings: {},
    runtimeMode: "supervised",
    title: "",
    cwd: "/repo",
    blocks: [],
    load: { phase, since: 0, attempt: 0 },
  } as Session;
}

describe("SessionLeaf for a thread no host has", () => {
  it("a gone thread says which host it left, and closes its tab or opens the archive", () => {
    state.session = thread("gone");
    const onClose = vi.fn();
    render(<SessionLeaf id="t1" {...base} onClose={onClose} />);
    expect(screen.getByText("No longer on box")).toBeTruthy();
    expect(screen.queryByTestId("session-pane")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(onClose).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: "Open archived" }));
    expect(openSettings).toHaveBeenCalledWith("archive");
  });

  it("a thread the store dropped after the hosts listed draws the line, not nothing", () => {
    render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(screen.getByText("No longer on any host")).toBeTruthy();
  });

  it("before any host has listed, a missing thread may still be on its way: nothing yet", () => {
    state.listed = false;
    const { container } = render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("a provisional thread still loading is an ordinary pane", () => {
    state.session = thread("loading");
    render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(screen.getByTestId("session-pane")).toBeTruthy();
  });
});
