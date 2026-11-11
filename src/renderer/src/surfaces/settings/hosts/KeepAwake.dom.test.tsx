// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KeepAwakeStatusWire } from "@server/shared/contract-power";
import { KeepAwakeRow } from "./KeepAwake";

/** Settings → Hosts → This Mac's Keep awake row: the mode's select, "On now" while the hold is taken, a refused change on its row. */

const status = (over: Partial<KeepAwakeStatusWire> = {}): KeepAwakeStatusWire => ({
  mode: "while-working",
  supported: true,
  holding: false,
  onBattery: false,
  ...over,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const choose = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByLabelText("Keep this Mac awake"));
  await flush();
  const option = await screen.findByRole("option", { name });
  await flush();
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(option, { button: 0 });
  fireEvent.click(option);
  await flush();
};

afterEach(cleanup);

describe("KeepAwakeRow", () => {
  it("says On now only while the hold is taken", () => {
    const idle = render(<KeepAwakeRow status={status()} onSet={async () => null} />);
    expect(idle.container.querySelector("[data-keep-awake]")?.getAttribute("data-keep-awake")).toBe("idle");
    expect(idle.queryByText("On now")).toBeNull();
    idle.unmount();
    const holding = render(<KeepAwakeRow status={status({ holding: true })} onSet={async () => null} />);
    expect(holding.getByText("On now")).toBeTruthy();
    expect(holding.getByText("Keep awake")).toBeTruthy();
  });

  it("sets the mode from its select and keeps a refusal on the row", async () => {
    const set: string[] = [];
    render(<KeepAwakeRow status={status()} onSet={async (mode) => (set.push(mode), "refused: admin only")} />);
    await choose("Never");
    expect(set).toEqual(["never"]);
    expect(await screen.findByText("refused: admin only")).toBeTruthy();
  });
});
