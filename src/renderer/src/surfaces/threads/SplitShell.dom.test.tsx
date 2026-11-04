// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animate } from "motion/react";
import { SplitShell } from "./SplitShell";

// A settle lands at once, so a test reads where it ends; the call is kept to read its spring.
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  animate: vi.fn((_from: number, to: number, options: { onUpdate?: (v: number) => void; onComplete?: () => void }) => {
    options.onUpdate?.(to);
    options.onComplete?.();
    return { stop: vi.fn() };
  }),
}));

afterEach(cleanup);

/** The shell is `width` wide; the board as drawn reads its flex basis against it. */
function mockShell(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let w = width;
    if (this.hasAttribute("data-board")) {
      const basis = this.style.flexBasis;
      const fit = /^min\((\d+)px, 50%\)$/.exec(basis);
      w = fit ? Math.min(Number(fit[1]), width / 2) : (parseFloat(basis) / 100) * width;
    }
    return { left: 0, width: w, top: 0, height: 600, right: w, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

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

describe("SplitShell's sash", () => {
  it("takes the keyboard: focusable, ArrowRight moves the split 2%, a double-click resets it", () => {
    const { container } = render(shell());
    const sash = screen.getByRole("separator", { name: "Resize" });
    const board = container.querySelector<HTMLElement>("[data-board]")!;
    expect(sash.tabIndex).toBe(0);
    expect(board.style.flexBasis).toBe("50%");
    fireEvent.keyDown(sash, { key: "ArrowRight" });
    expect(board.style.flexBasis).toBe("52%");
    fireEvent.keyDown(sash, { key: "ArrowLeft", shiftKey: true });
    expect(board.style.flexBasis).toBe("42%");
    fireEvent.doubleClick(sash);
    expect(board.style.flexBasis).toBe("50%");
    // Hovered /7, dragged /12, at once.
    expect(sash.className).toContain("hover:bg-foreground/7");
    expect(sash.className).not.toMatch(/transition/);
  });

  it("draws the conversation toggle's glyph at the 14px of its icon-sm neighbours", () => {
    render(shell());
    const toggle = screen.getByRole("button", { name: "Conversation" });
    expect(toggle.querySelector("svg")!.getAttribute("class") ?? "").not.toContain("size-4");
  });
});

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

  it("the header reads as a header: a 14px semibold title, its fact 12px muted and tabular, then equal 28px controls 2px apart", () => {
    render(shell({ detail: "3/7", actions: <button type="button">More</button> }));
    const title = document.querySelector("[data-view-title]") as HTMLElement;
    expect(title.className).toContain("text-sm");
    expect(title.className).toContain("font-semibold");
    const detail = document.querySelector("[data-view-detail]") as HTMLElement;
    expect(detail.className).toContain("text-xs");
    expect(detail.className).toContain("text-muted-foreground");
    expect(detail.className).toContain("tabular-nums");
    expect(title.parentElement?.className).toContain("gap-2");
    const actions = document.querySelector("[data-view-actions]") as HTMLElement;
    expect(actions.className).toContain("gap-0.5");
    // The view's buttons, then the conversation toggle last, with no extra margin.
    const kids = [...actions.children] as HTMLElement[];
    expect(kids.map((k) => k.getAttribute("aria-label") ?? k.textContent)).toEqual(["More", "Conversation"]);
    expect(kids.some((k) => /\bml-/.test(k.className))).toBe(false);
    expect(kids[1].className).toContain("h-7");
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
      mockShell(1000);
      fireEvent.pointerDown(sash(), { button: 0, clientX: 500 });
      fireEvent.pointerMove(window, { clientX: toX });
      fireEvent.pointerUp(window);
    };
    afterEach(() => vi.restoreAllMocks());

    it("takes its fit, capped at half the pane", () => {
      render(shell({ fit: 420 }));
      expect(basis()).toBe("min(420px, 50%)");
    });

    it("a drag replaces the fit with the dragged share, from the board as drawn, and a double-click goes back to the fit", () => {
      render(shell({ fit: 420 }));
      // The fitted board stands at 420px; 120px to the right is 540px, 54%.
      drag(620);
      expect(basis()).toBe("54%");
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

describe("SplitShell's drag", () => {
  const board = () => document.querySelector("[data-board]") as HTMLElement;
  const sash = () => screen.getByRole("separator", { name: "Resize" });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(animate).mockClear();
  });

  it("holds the pointer, marks the page resizing, and starts from the board as drawn", () => {
    mockShell(1600);
    render(shell({ fit: 300 }));
    const capture = vi.fn();
    sash().setPointerCapture = capture;
    fireEvent.pointerDown(sash(), { button: 0, pointerId: 7, clientX: 800 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(document.documentElement.classList.contains("is-resizing")).toBe(true);
    // One pixel moves the 300px board by one pixel of 1600: no jump to 30%.
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 801 });
    expect(parseFloat(board().style.flexBasis)).toBeCloseTo((301 / 1600) * 100, 4);
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(document.documentElement.classList.contains("is-resizing")).toBe(false);
  });

  it("keys move 2% from the drawn fit, not from 50", () => {
    mockShell(1600);
    render(shell({ fit: 600 }));
    fireEvent.keyDown(sash(), { key: "ArrowRight" });
    expect(parseFloat(board().style.flexBasis)).toBeCloseTo(37.5 + 2, 4);
  });

  it("Escape puts the board back where the drag began", () => {
    mockShell(1000);
    render(shell());
    fireEvent.pointerDown(sash(), { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 620 });
    expect(board().style.flexBasis).toBe("62%");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(board().style.flexBasis).toBe("50%");
    // The drag is over: a later move does nothing.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
    expect(board().style.flexBasis).toBe("50%");
  });

  it("dragged past 70% it stretches, and settles back at 70 on SPRING_GLIDE", () => {
    mockShell(1000);
    render(shell());
    fireEvent.pointerDown(sash(), { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 });
    const stretched = parseFloat(board().style.flexBasis);
    expect(stretched).toBeGreaterThan(70);
    expect(stretched).toBeLessThan(80);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(board().style.flexBasis).toBe("70%");
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, { stiffness: number; damping: number }];
    expect(from).toBeCloseTo(stretched);
    expect(to).toBe(70);
    expect(options.stiffness).toBe(700);
    expect(options.damping).toBe(50);
  });
});
