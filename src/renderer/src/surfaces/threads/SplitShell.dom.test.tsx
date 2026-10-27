// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitShell } from "./SplitShell";

afterEach(cleanup);

const shell = (over: Partial<Parameters<typeof SplitShell>[0]> = {}) => (
  <SplitShell
    board={<p>the board</p>}
    chat={<p>the chat</p>}
    hasBoard
    collapsed={false}
    onToggleChat={() => {}}
    title="Plan"
    {...over}
  />
);

describe("SplitShell", () => {
  it("without a board the chat fills the pane: no header, no separator", () => {
    render(shell({ hasBoard: false }));
    expect(screen.getByText("the chat")).toBeTruthy();
    expect(screen.queryByText("the board")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();
  });

  it("the header renders the title, the detail and the actions", () => {
    render(shell({ detail: "4 tasks", actions: <button type="button">Start build</button> }));
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("4 tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start build" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize" })).toBeTruthy();
  });

  it("no title, no header", () => {
    render(shell({ title: undefined }));
    expect(screen.getByText("the board")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();
  });

  it("the toggle's pressed state follows the fold and flips it", () => {
    const onToggleChat = vi.fn();
    const view = render(shell({ onToggleChat }));
    const toggle = screen.getByRole("button", { name: "Conversation" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(onToggleChat).toHaveBeenCalledWith(false);
    view.rerender(shell({ onToggleChat, collapsed: true }));
    const folded = screen.getByRole("button", { name: "Conversation" });
    expect(folded.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(folded);
    expect(onToggleChat).toHaveBeenLastCalledWith(true);
  });

  it("the folded chat stays mounted and inert, and there is no edge tab", () => {
    render(shell({ collapsed: true }));
    const chat = document.querySelector("[data-chat]") as HTMLElement;
    expect(chat.textContent).toContain("the chat");
    expect(chat.hasAttribute("inert")).toBe(true);
    expect(chat.className).toContain("invisible");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("button", { name: /show conversation/i })).toBeNull();
  });

  it("the board never tweens its width", () => {
    render(shell());
    const board = document.querySelector("[data-board]") as HTMLElement;
    expect(board.style.transition).toBe("");
    expect(board.className).not.toMatch(/flex-basis|transition-all/);
  });
});
