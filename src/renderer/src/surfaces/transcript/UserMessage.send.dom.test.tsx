// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";
import { recordSendOrigin, resetSendOrigin } from "../../lib/sendOrigin";
import { ParkPendingContext } from "../turnState";
import { FLIP_REACH_PX, UserMessageBlock } from "./UserMessage";

/** The bubble rests at top 400, left 300; the field was `fieldTop` px down the window. */
const REST = { top: 400, left: 300, width: 200, height: 38, right: 500, bottom: 438, x: 300, y: 400 };
const mount = (parking: boolean, fieldTop: number) => {
  recordSendOrigin({ top: fieldTop, left: 40, width: 700, height: 44 } as DOMRect);
  const block: Block = { id: "u", role: "user", text: "Fix the build", born: Date.now() };
  const view = render(
    <ParkPendingContext.Provider value={() => parking}>
      <UserMessageBlock block={block} stickyIndex={1} environmentId="local" />
    </ParkPendingContext.Provider>,
  );
  return view.container.querySelector<HTMLElement>("[data-user-bubble]")!;
};

beforeEach(() => {
  resetSendOrigin();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ ...REST, toJSON: () => REST } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the bubble's send entrance", () => {
  it("rises with the content while the transcript parks the prompt, even right beside the field", () => {
    const bubble = mount(true, REST.top + 20);
    expect(bubble.classList.contains("bubble-send-in")).toBe(true);
    expect(bubble.classList.contains("bubble-send-flip")).toBe(false);
    expect(bubble.style.getPropertyValue("--send-dy")).toBe("");
  });

  it("flies from the field when followed and it lands within reach", () => {
    const bubble = mount(false, REST.top + FLIP_REACH_PX - 10);
    expect(bubble.classList.contains("bubble-send-flip")).toBe(true);
    expect(bubble.style.getPropertyValue("--send-dy")).toBe(`${FLIP_REACH_PX - 10}px`);
    expect(bubble.style.getPropertyValue("--send-dx")).toBe("-260px");
  });

  it("rises when followed from farther than its reach", () => {
    const bubble = mount(false, REST.top + FLIP_REACH_PX + 40);
    expect(bubble.classList.contains("bubble-send-in")).toBe(true);
    expect(bubble.classList.contains("bubble-send-flip")).toBe(false);
  });
});
