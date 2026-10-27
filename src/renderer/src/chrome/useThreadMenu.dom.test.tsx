// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sessions, commands, dropThread, goalOpen, tabs } = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  commands: { pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()), interrupt: vi.fn(() => Promise.resolve()) },
  dropThread: vi.fn(),
  goalOpen: vi.fn(),
  tabs: { state: { activeTabId: "tab1", tabs: [{ id: "tab1", focusedId: "other" }] } },
}));

vi.mock("../lib/tcserver/store", () => ({
  sessionStore: { get: (id: string) => sessions.get(id), metaOf: () => null },
}));
vi.mock("../lib/tcserver/commands", () => commands);
vi.mock("../lib/macBridge", () => ({
  bridgeableEnvironment: () => false,
  loadThreadBridge: vi.fn(),
  setThreadBridge: vi.fn(),
  useThreadBridge: () => null,
}));
vi.mock("../lib/masterThread", () => ({ useMasterIds: () => new Set<string>(), masterMenuLabel: (m: boolean) => (m ? "Not a master" : "Make master thread") }));
vi.mock("../lib/threadResources", () => ({
  archiveThread: vi.fn(() => Promise.resolve()),
  isRemovable: (row: { kind: string }) => row.kind !== "port",
  liveResources: () => [],
  loadThreadResources: vi.fn(() => Promise.resolve([])),
  startThreadResources: () => () => {},
  useThreadResources: () => [],
}));
vi.mock("./ThreadHostChip", () => ({ useThreadHost: () => ({ host: null, movingTo: null, moves: [], pick: () => false, dialog: null }) }));
vi.mock("./GoalDialog", () => ({ goalDialog: { open: goalOpen, close: vi.fn() } }));
vi.mock("../stores/workspace", () => ({ workspaceTabsStore: { getState: () => tabs.state } }));
vi.mock("../stores/workspaceActions", () => ({ workspaceActions: { dropThread } }));

import { SessionActionsContext, type SessionActions } from "../surfaces/threadChat";
import { RowsContextMenu, RowsMenu } from "./menuRows";
import { useThreadMenu } from "./useThreadMenu";

afterEach(() => {
  cleanup();
  sessions.clear();
  vi.clearAllMocks();
});

const thread = (id: string, over: Record<string, unknown> = {}) =>
  sessions.set(id, { id, environmentId: "local", title: id, status: "running", threadType: "chat", projectId: "p1", parentId: null, harness: "claude", ...over });

/** A rail-like list and a chip-like ⋯, both on the one hook. */
function Surfaces({ onScreen = () => false }: { onScreen?: (id: string) => boolean }) {
  const menu = useThreadMenu({ onRename: () => {}, onScreen });
  return (
    <>
      <RowsContextMenu label="Rail" rowsFor={(id) => (id ? menu.rowsFor(id) : null)} onPick={(pick, id) => id && menu.onPick(id, pick)} onOpenChange={(open, id) => menu.onOpenChange(id, open)}>
        <ul>
          <li data-menu-id="t1">Row t1</li>
        </ul>
      </RowsContextMenu>
      <RowsMenu
        label="Chip"
        trigger={<button type="button">More</button>}
        rows={() => menu.rowsFor("t1")}
        onPick={(pick) => menu.onPick("t1", pick)}
        onOpenChange={(open) => menu.onOpenChange("t1", open)}
      />
      {menu.dialogs}
    </>
  );
}

const labels = (root: HTMLElement) => [...root.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent);

function withActions(node: ReactNode, actions: Partial<SessionActions>) {
  return <SessionActionsContext.Provider value={actions as SessionActions}>{node}</SessionActionsContext.Provider>;
}

describe("one thread menu on every surface", () => {
  it("a right-click on a rail row and the chip's ⋯ open the same rows", async () => {
    thread("t1");
    render(<Surfaces />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    const rail = labels(await screen.findByRole("menu", { name: "Rail" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Rail" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const chip = labels(await screen.findByRole("menu", { name: "Chip" }));
    expect(chip).toEqual(rail);
    expect(rail).toEqual(expect.arrayContaining(["Rename", "Pause", "Stop", "Delete…"]));
  });

  it("Pause calls the pause command for that thread", async () => {
    thread("t1");
    render(<Surfaces />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rail" })).getByText("Pause"));
    expect(commands.pause).toHaveBeenCalledWith("t1");
  });

  it("a Type pick goes through the chat's onThreadTypeChange", async () => {
    thread("t1", { status: "idle" });
    const onThreadTypeChange = vi.fn();
    render(withActions(<Surfaces />, { onThreadTypeChange }));
    fireEvent.contextMenu(screen.getByText("Row t1"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rail" })).getByText("Type"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Plan" }));
    expect(onThreadTypeChange).toHaveBeenCalledWith("t1", "planning");
  });

  it("Goal… shows only with the thread's composer on screen, and opens its dialog", async () => {
    thread("t1", { status: "idle" });
    render(<Surfaces />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    expect(labels(await screen.findByRole("menu", { name: "Rail" }))).not.toContain("Goal…");
    cleanup();
    render(<Surfaces onScreen={(id) => id === "t1"} />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rail" })).getByText("Goal…"));
    expect(goalOpen).toHaveBeenCalledWith("t1");
  });

  it("Open to the side splits the focused pane and opens the thread on its right", async () => {
    thread("t1", { status: "idle" });
    render(<Surfaces />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rail" })).getByText("Open to the side"));
    expect(dropThread).toHaveBeenCalledWith("t1", "other", "right");
  });

  it("Delete… confirms before it deletes", async () => {
    thread("t1", { status: "idle" });
    render(<Surfaces />);
    fireEvent.contextMenu(screen.getByText("Row t1"));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Rail" })).getByText("Delete…"));
    expect(await screen.findByText("Delete t1?")).toBeTruthy();
  });
});
