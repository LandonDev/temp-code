// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Escape belongs to the innermost layer: the inbox closes on Escape only
 *  when no field, menu or dialog inside it took the key first. */

vi.mock("../hooks/useTabGroupLogos", () => ({ useTabGroupLogos: () => ({}) }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => null }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

import { InboxView } from "./InboxView";

afterEach(cleanup);

async function mount() {
  const onClose = vi.fn();
  const view = render(<InboxView cwd="/tmp/project" besideRail onClose={onClose} />);
  await act(async () => {});
  return { view, onClose };
}

describe("the inbox's Escape", () => {
  it("closes the inbox from the page", async () => {
    const { onClose } = await mount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets a focused field go first and keeps what it holds", async () => {
    const { view, onClose } = await mount();
    const field = view.getByLabelText("Filter inbox") as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "gate" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(field);
    expect(field.value).toBe("gate");
  });

  it("leaves Escape to a confirm open above it", async () => {
    const { onClose } = await mount();
    const confirm = document.createElement("div");
    confirm.setAttribute("role", "alertdialog");
    const button = document.createElement("button");
    confirm.append(button);
    document.body.append(confirm);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    confirm.remove();
  });
});
