// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TOAST_WIDTH, toastInset } from "./toaster";
import { toastAnchor } from "../../lib/toastAnchor";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { SplitShell } from "../../surfaces/threads/SplitShell";
import { BatchFoot } from "../../surfaces/threads/master/BatchFoot";
import { emptyBatch } from "@server/shared/contract-batch";

afterEach(cleanup);

const WINDOW = { width: 1440, height: 900 };
const TOAST_H = 64;

/** The toast's box at the bottom of the stack, from the inset. */
function toastBox(viewport: { width: number; height: number }, inset: { bottom: number; right: number; width: number }) {
  const bottom = viewport.height - inset.bottom;
  const right = viewport.width - inset.right;
  return { top: bottom - TOAST_H, bottom, left: right - inset.width, right };
}

function meets(a: { top: number; bottom: number; left: number; right: number }, b: typeof a): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("toastInset", () => {
  it("sits 16/16 from the window's corner with no anchor", () => {
    expect(toastInset(WINDOW, null)).toEqual({ bottom: 16, right: 16, width: TOAST_WIDTH });
  });

  it("sits 8px above the anchor's top and 16px inside its right edge", () => {
    // A 28px strip over a 120px composer: the footer starts 148px above the bottom.
    expect(toastInset(WINDOW, { top: 752, right: 1100 })).toEqual({ bottom: 156, right: 356, width: TOAST_WIDTH });
  });

  it("stays clear of a right panel: the column's edge, not the window's", () => {
    const withPanel = toastInset(WINDOW, { top: 752, right: 1440 - 320 });
    expect(withPanel.right).toBe(320 + 16);
  });

  it("rises with a tall composer", () => {
    const short = toastInset(WINDOW, { top: 752, right: 1100 });
    const tall = toastInset(WINDOW, { top: 500, right: 1100 });
    expect(tall.bottom - short.bottom).toBe(252);
  });

  it("never comes closer than 16px to an edge in a narrow window", () => {
    expect(toastInset({ width: 480, height: 600 }, { top: 640, right: 520 })).toEqual({ bottom: 16, right: 16, width: TOAST_WIDTH });
  });

  it("in a master's chat beside its board, stays inside the chat's column: no wider than it less 16px a side", () => {
    // 1000px window: the board to 640, the master's chat from 641 to the edge.
    const viewport = { width: 1000, height: 900 };
    const chat = { top: 760, left: 641, right: 1000, bottom: 900 };
    const inset = toastInset(viewport, chat);
    expect(inset.width).toBe(1000 - 641 - 32);
    const box = toastBox(viewport, inset);
    expect(box.left).toBeGreaterThanOrEqual(chat.left + 16);
    expect(box.right).toBe(chat.right - 16);
    // A wide column keeps the full toast.
    expect(toastInset({ width: 1440, height: 900 }, { top: 752, left: 272, right: 1168 }).width).toBe(TOAST_WIDTH);
  });

  it("puts no toast over the composer's Send button", () => {
    for (const [viewport, footer] of [
      [WINDOW, { top: 752, left: 272, right: 1168, bottom: 892 }],
      [WINDOW, { top: 420, left: 272, right: 1168, bottom: 892 }],
      [{ width: 900, height: 700 }, { top: 560, left: 0, right: 900, bottom: 700 }],
    ] as const) {
      const send = { top: footer.bottom - 44, bottom: footer.bottom - 12, left: footer.right - 52, right: footer.right - 20 };
      const inset = toastInset(viewport, footer);
      expect(meets(toastBox(viewport, inset), send)).toBe(false);
    }
  });
});

describe("ChatFooter's toast anchor", () => {
  const slots = (anchor: boolean) => ({ transcript: null, strip: <div />, composer: <div />, anchor });

  it("marks and registers only the focused pane's footer", () => {
    const view = render(<ChatFooter slots={slots(false)} />);
    expect(view.container.querySelector("[data-toast-anchor]")).toBeNull();
    expect(toastAnchor()).toBeNull();
    view.rerender(<ChatFooter slots={slots(true)} />);
    const footer = view.container.querySelector<HTMLElement>("[data-toast-anchor]");
    expect(footer).not.toBeNull();
    expect(toastAnchor()).toBe(footer);
    view.rerender(<ChatFooter slots={slots(false)} />);
    expect(toastAnchor()).toBeNull();
  });

  it("follows the pane that gained the focus last, and falls back when it leaves", () => {
    const a = render(<ChatFooter slots={slots(true)} />);
    const b = render(<ChatFooter slots={slots(true)} />);
    expect(toastAnchor()).toBe(b.container.firstElementChild);
    b.unmount();
    expect(toastAnchor()).toBe(a.container.firstElementChild);
    a.unmount();
    expect(toastAnchor()).toBeNull();
  });
});

describe("the master view's seat", () => {
  const slots = { transcript: null, strip: <div />, composer: <div />, anchor: true };
  const shell = (collapsed: boolean, foot: boolean) => (
    <SplitShell
      board={
        <BatchFoot batch={emptyBatch("m1")} titleOf={() => undefined} onSave={async () => {}} onStop={async () => {}} toastAnchor={foot} />
      }
      chat={<ChatFooter slots={slots} />}
      hasBoard
      collapsed={collapsed}
      onToggleChat={() => {}}
      title="Master"
    />
  );

  it("with the chat open the stack sits over the chat; folded, above the board's foot; open again, back over the chat", () => {
    const view = render(shell(false, false));
    const footer = view.container.querySelector<HTMLElement>("[data-toast-anchor]")!;
    expect(toastAnchor()).toBe(footer);
    // MasterView passes toastAnchor={!chatOpen} to the foot.
    view.rerender(shell(true, true));
    expect(footer.closest("[inert]")).not.toBeNull();
    expect(toastAnchor()).toBe(view.container.querySelector("[data-batch-foot]"));
    view.rerender(shell(false, false));
    expect(toastAnchor()).toBe(footer);
  });

  it("a folded chat seats nothing even with no foot to take its place: the window's corner", () => {
    const view = render(shell(true, false));
    expect(toastAnchor()).toBeNull();
    view.unmount();
  });
});
