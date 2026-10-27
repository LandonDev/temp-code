// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus } from "../chrome/menuRows";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";

afterEach(cleanup);
beforeEach(() => resetMenus());

const selection = { text: "the chosen words", rect: new DOMRect(100, 200, 80, 16) };

describe("TranscriptSelectionMenu", () => {
  it("shows nothing without a selection", async () => {
    render(<TranscriptSelectionMenu selection={null} onAddToChat={() => {}} onDismiss={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("floats over a selection; Add to chat sends the text and drops the selection", async () => {
    const onAddToChat = vi.fn();
    const onDismiss = vi.fn();
    const clear = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ removeAllRanges: clear } as unknown as Selection);
    render(<TranscriptSelectionMenu selection={selection} onAddToChat={onAddToChat} onDismiss={onDismiss} />);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text actions" });
    fireEvent.click(toolbar.querySelector("button[aria-label='Add to chat']")!);
    expect(onAddToChat).toHaveBeenCalledWith("the chosen words");
    expect(clear).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("Escape clears the selection and dismisses", async () => {
    const onDismiss = vi.fn();
    const clear = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ removeAllRanges: clear } as unknown as Selection);
    render(<TranscriptSelectionMenu selection={selection} onAddToChat={() => {}} onDismiss={onDismiss} />);
    await screen.findByRole("toolbar", { name: "Selected text actions" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(clear).toHaveBeenCalled();
  });
});
