// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { toastInset } from "./toaster";
import { toastAnchor } from "../../lib/toastAnchor";
import { ChatFooter } from "../../surfaces/threads/chatSlots";

afterEach(cleanup);

const WINDOW = { width: 1440, height: 900 };
/** sonner's toast width (toaster.tsx `--width`). */
const TOAST_W = 340;
const TOAST_H = 64;

/** The toast's box at the bottom of the stack, from the inset. */
function toastBox(viewport: { width: number; height: number }, inset: { bottom: number; right: number }) {
  const bottom = viewport.height - inset.bottom;
  const right = viewport.width - inset.right;
  return { top: bottom - TOAST_H, bottom, left: right - TOAST_W, right };
}

function meets(a: { top: number; bottom: number; left: number; right: number }, b: typeof a): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("toastInset", () => {
  it("sits 16/16 from the window's corner with no anchor", () => {
    expect(toastInset(WINDOW, null)).toEqual({ bottom: 16, right: 16 });
  });

  it("sits 8px above the anchor's top and 16px inside its right edge", () => {
    // A 28px strip over a 120px composer: the footer starts 148px above the bottom.
    expect(toastInset(WINDOW, { top: 752, right: 1100 })).toEqual({ bottom: 156, right: 356 });
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
    expect(toastInset({ width: 480, height: 600 }, { top: 640, right: 520 })).toEqual({ bottom: 16, right: 16 });
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
