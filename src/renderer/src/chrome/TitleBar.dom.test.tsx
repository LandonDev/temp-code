// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../lib/connection";
import type { Catalog } from "../lib/projectContext";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { buildHeaderModel, orderModel } from "../lib/threadHeaderModel";
import type { ThreadHeaderProps } from "./ThreadHeader";
import { TitleBar } from "./TitleBar";

vi.mock("./WindowControls", () => ({ WindowControls: () => null }));

const header: ThreadHeaderProps = {
  model: { live: [], dormant: [], activeId: null },
  planReady: {},
  archived: [],
  workspaceId: null,
  cost: null,
  running: 0,
  railOpen: false,
  onSelect: () => {},
  onRename: () => {},
  onArchive: () => {},
  onDelete: () => {},
  onAction: () => {},
  onSetRules: () => {},
  onRestore: () => {},
  onNew: () => {},
  onPauseAll: () => Promise.resolve(),
  onToggleRail: () => {},
  onSetType: () => {},
};

function bar(over: Partial<ComponentProps<typeof TitleBar>> = {}) {
  render(
    <TitleBar
      tabs={[]}
      activeId=""
      cwd="/Users/me/repo"
      header={header}
      onToggleSidebar={() => {}}
      onNew={() => {}}
      onNewTerminal={vi.fn()}
      onShowTerminal={vi.fn()}
      {...over}
    />,
  );
}

afterEach(() => {
  cleanup();
  sessionStore.reset();
});

const chat = {
  environmentId: "env_local",
  id: "loose-chat",
  parentId: null,
  projectId: null,
  workspaceId: "w1",
  threadType: "chat",
  title: "A loose chat",
  cwd: "/w1",
  status: "idle",
  archived: false,
  pinned: false,
  busySince: null,
  createdAt: 1,
  updatedAt: 1,
} as SessionMeta;

/** A host that lists the given threads and nothing else. */
function listing(metas: SessionMeta[]): Link {
  return {
    environmentId: "env_local",
    connected: true,
    profile: "local",
    request: <T,>(method: string) => Promise.resolve((method === "session.list" ? metas : null) as T),
    onPush: () => () => {},
    onOpen: () => () => {},
    onClose: () => () => {},
  };
}

describe("TitleBar", () => {
  it("the terminal is a row of the thread menu, not a title bar button", () => {
    bar();
    expect(screen.queryByRole("button", { name: /Terminal/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Panel" })).toBeTruthy();
  });
});

describe("TitleBar with no project selected", () => {
  it("a loose chat on screen has its chip and the thread menu lists its rows", async () => {
    Element.prototype.scrollIntoView = () => {};
    sessionStore.attach(listing([chat]));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const catalog = { workspaces: [{ id: "w1", path: "/w1" }], projects: [] } as unknown as Catalog;
    const model = orderModel(
      buildHeaderModel({
        threads: [chat],
        tabs: [{ id: "tab", sessionIds: [chat.id] }],
        scope: { loose: "w1", catalog },
        activeTabId: "tab",
        onScreenId: chat.id,
        lastSeen: { [chat.id]: 1 },
        planReady: {},
      }),
      [],
    );
    bar({ header: { ...header, model } });
    expect(screen.getByText("A loose chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    for (const name of ["Rename", "Type", /^Archive/]) expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
  });
});
