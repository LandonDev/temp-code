// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("beside the board the chat keeps 360px and the board yields; alone or folded it has no minimum", () => {
    const view = render(shell());
    const chat = () => document.querySelector("[data-chat]") as HTMLElement;
    expect(chat().className).toContain("min-w-90");
    expect((document.querySelector("[data-board]") as HTMLElement).className).toContain("min-w-0");
    view.rerender(shell({ hasBoard: false }));
    expect(chat().className).not.toContain("min-w-90");
    view.rerender(shell({ collapsed: true }));
    expect(chat().className).not.toContain("min-w-90");
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

  describe("a fitted board", () => {
    const basis = () => (document.querySelector("[data-board]") as HTMLElement).style.flexBasis;
    const sash = () => screen.getByRole("separator", { name: "Resize" });
    const drag = (toX: number) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, width: 1000, top: 0, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.pointerDown(sash(), { button: 0, clientX: 500 });
      fireEvent.pointerMove(window, { clientX: toX });
      fireEvent.pointerUp(window);
    };
    afterEach(() => vi.restoreAllMocks());

    it("takes its fit, capped at half the pane", () => {
      render(shell({ fit: 420 }));
      expect(basis()).toBe("min(420px, 50%)");
    });

    it("a drag replaces the fit with the dragged share, and a double-click goes back to the fit", () => {
      render(shell({ fit: 420 }));
      drag(620);
      expect(basis()).toBe("62%");
      fireEvent.doubleClick(sash());
      expect(basis()).toBe("min(420px, 50%)");
    });

    it("folded, the board takes the whole pane", () => {
      render(shell({ fit: 420, collapsed: true }));
      expect(basis()).toBe("100%");
    });

    it("without a fit the board keeps half, and a double-click resets a drag to half", () => {
      render(shell());
      expect(basis()).toBe("50%");
      drag(300);
      expect(basis()).toBe("30%");
      fireEvent.doubleClick(sash());
      expect(basis()).toBe("50%");
    });
  });

  it("the board never tweens its width", () => {
    render(shell());
    const board = document.querySelector("[data-board]") as HTMLElement;
    expect(board.style.transition).toBe("");
    expect(board.className).not.toMatch(/flex-basis|transition-all/);
  });

  it("a board there at mount paints without the fade; one arriving live fades in, and again after it left", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const board = () => document.querySelector("[data-board]") as HTMLElement | null;
      const restored = render(shell());
      await waitFor(() => expect(board()?.className).toContain("opacity-100"));
      restored.unmount();

      const view = render(shell({ hasBoard: false }));
      expect(board()).toBeNull();
      now = 2_000;
      view.rerender(shell());
      expect(board()?.className).toContain("opacity-0");
      expect(board()?.className).toContain("transition-opacity");
      expect(board()?.className).toContain("motion-reduce:transition-none");
      await waitFor(() => expect(board()?.className).toContain("opacity-100"));
      view.rerender(shell({ hasBoard: false }));
      expect(board()).toBeNull();
      view.rerender(shell());
      expect(board()?.className).toContain("opacity-0");
      await waitFor(() => expect(board()?.className).toContain("opacity-100"));
    } finally {
      clock.mockRestore();
    }
  });
});
