// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeaderModel } from "../lib/threadHeaderModel";
import { ThreadHeaderStrip, type ChipThread, type StripChip } from "./ThreadHeaderStrip";

const thread = (id: string, title: string): ChipThread => ({
  id,
  title,
  status: "idle",
  updatedAt: 1,
  projectId: "p1",
  parentId: null,
  archived: false,
  threadType: "chat",
});

const chip = (id: string, title: string): StripChip => ({
  id,
  thread: thread(id, title),
  tabId: `tab-${id}`,
  live: true,
  status: "idle",
  unread: false,
  tone: null,
  updatedAt: 1,
});

const model: HeaderModel<ChipThread> = {
  live: [chip("a", "Alpha"), chip("b", "Beta"), chip("c", "Gamma")],
  dormant: [],
  activeId: "a",
};

function mount() {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  render(
    <ThreadHeaderStrip
      model={model}
      onSelect={onSelect}
      archived={[]}
      onRestore={() => {}}
      stripRef={() => {}}
      planReady={{}}
      renamingId={null}
      onStartRename={() => {}}
      onRename={() => {}}
      onContextMenu={onContextMenu}
      activeRef={() => {}}
    />,
  );
  return { onSelect, onContextMenu };
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

afterEach(cleanup);

describe("ThreadHeaderStrip pointer", () => {
  it("a right press does not select, and the contextmenu that follows opens that chip's menu", () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 2 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Beta"));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0]![0].id).toBe("b");
  });

  it("a Control-click is a right-click on the Mac: no select, the menu", () => {
    const { onSelect, onContextMenu } = mount();
    fireEvent.pointerDown(tab("Gamma"), { button: 0, ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(tab("Gamma"));
    expect(onContextMenu.mock.calls[0]![0].id).toBe("c");
  });

  it("a primary press selects", () => {
    const { onSelect } = mount();
    fireEvent.pointerDown(tab("Beta"), { button: 0 });
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("the strip's rows take clicks: they are out of the window's drag region", () => {
    mount();
    for (const row of document.querySelectorAll("[data-strip]")) {
      expect(row.getAttribute("data-tauri-drag-region")).toBe("false");
    }
    expect(document.querySelectorAll("[data-strip]").length).toBeGreaterThan(0);
  });
});
