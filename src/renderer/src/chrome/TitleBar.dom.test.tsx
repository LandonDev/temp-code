// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      deckLayout
      onToggleSidebar={() => {}}
      onSelect={() => {}}
      onNew={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
      onNewTerminal={vi.fn()}
      onShowTerminal={vi.fn()}
      {...over}
    />,
  );
}

afterEach(cleanup);

describe("TitleBar in deck layout", () => {
  it("with the thread header, the terminal is a row of the thread menu, not a title bar button", () => {
    bar({ header });
    expect(screen.queryByRole("button", { name: /Terminal/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Panel" })).toBeTruthy();
  });

  it("without the thread header the terminal button stays", () => {
    bar();
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeTruthy();
  });
});
