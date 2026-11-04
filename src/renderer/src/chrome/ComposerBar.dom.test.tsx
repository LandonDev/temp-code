// @vitest-environment jsdom
/**
 * The row under the composer's box: the model button, the context meter (an
 * existing thread with a reading) and the permission mode (none for fx; no
 * account or goal control for anyone); the box's `+` menu with its three
 * rows; the send button speaking the intent Enter would carry out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

const store = vi.hoisted(() => ({ blocks: new Map<string, unknown[]>(), listeners: new Set<() => void>() }));
vi.mock("../lib/tcserver/store", () => ({
  sessionStore: {
    subscribe: (l: () => void) => {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    get: (id: string) => (store.blocks.has(id) ? { blocks: store.blocks.get(id) } : undefined),
  },
}));

vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));

import { AddMenu, ComposerBar, SendButton, useDraftRow } from "./ComposerBar";
import { ContextMeter } from "./ContextMeter";
import type { HarnessId } from "../lib/session";

function bar(harness: HarnessId, context?: ReactNode) {
  return render(
    <ComposerBar
      harness={harness}
      model={<button type="button">Opus 5.5</button>}
      runtimeMode="supervised"
      onRuntimeModeChange={() => {}}
      onClose={() => {}}
      context={context}
    />,
  );
}

function rowNames(container: HTMLElement): string[] {
  const row = container.querySelector<HTMLElement>("[data-composer-bar]")!;
  return [...row.querySelectorAll("button, [role=combobox]")].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent ?? "",
  );
}

function add(handlers: { onAttach?: () => void; onInsert?: (mark: "@" | "/") => void; attachable?: boolean } = {}) {
  return render(
    <AddMenu
      attachable={handlers.attachable ?? true}
      onAttach={handlers.onAttach ?? (() => {})}
      onInsert={handlers.onInsert ?? (() => {})}
      fieldOf={() => null}
    />,
  );
}

async function openAdd() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  });
  return screen.getByRole("menu", { name: "Add" });
}

describe("ComposerBar, the row under the box", () => {
  it("holds the model button and the mode for Claude and Codex; Add and Send live in the box", () => {
    for (const harness of ["claude", "codex"] as const) {
      const { container, unmount } = bar(harness);
      expect(rowNames(container)).toEqual(["Opus 5.5", "Permission mode: Supervised"]);
      unmount();
    }
  });

  it("is a 24px size container 4px under the box, with the box's edges, and the mode is a quiet 24px control", () => {
    const { container } = bar("claude");
    const row = container.querySelector<HTMLElement>("[data-composer-bar]")!;
    expect(row.className).toContain("@container/composer-bar");
    expect(row.className.split(" ")).toEqual(expect.arrayContaining(["mt-1", "h-6", "items-center"]));
    expect(row.className).not.toMatch(/\b(mx|px|ms|me)-/);
    const mode = screen.getByRole("combobox", { name: "Permission mode: Supervised" });
    expect(mode.className.split(" ")).toEqual(
      expect.arrayContaining(["data-[size=sm]:h-6", "text-xs", "text-muted-foreground", "hover:bg-foreground/5"]),
    );
    expect(within(mode).getByText("Supervised").className).toContain("@max-[20rem]/composer-bar:hidden");
  });

  it("fx has no permission mode; nobody has an account or goal control", () => {
    const { container } = bar("fx");
    expect(rowNames(container)).toEqual(["Opus 5.5"]);
    for (const name of [/account/i, /goal/i, /context/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("the context meter stands between the model and the mode, quiet, and its percent gives way first", () => {
    const meter = <ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} />;
    const { container, unmount } = bar("claude", meter);
    expect(rowNames(container)).toEqual(["Opus 5.5", "Context 42% full", "Permission mode: Supervised"]);
    const button = screen.getByRole("button", { name: "Context 42% full" });
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["h-6", "text-xs", "hover:bg-foreground/5"]));
    // Under 25rem the percent goes, before the model's effort word (23rem).
    expect(within(button).getByText("42%").className).toContain("@max-[25rem]/composer-bar:hidden");
    unmount();
    const fx = bar("fx", meter);
    expect(rowNames(fx.container)).toEqual(["Opus 5.5", "Context 42% full"]);
  });

  it("an amber meter stays amber on hover", () => {
    bar("claude", <ContextMeter sessionId="s" usage={{ used: 176_000, window: 200_000 }} />);
    const button = screen.getByRole("button", { name: "Context 88% full" });
    expect(button.className).toContain("hover:text-warning");
    expect(button.className).not.toContain("hover:text-foreground");
  });
});

describe("AddMenu", () => {
  it("is the box's 28px `+`, never shrinking", () => {
    add();
    const button = screen.getByRole("button", { name: "Add" });
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["size-7", "shrink-0"]));
  });

  it("attach, mention and skills", async () => {
    const onAttach = vi.fn();
    const onInsert = vi.fn();
    add({ onAttach, onInsert });
    let menu = await openAdd();
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Attach files",
      "Mention a file or thread",
      "Skills and commands",
    ]);
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Mention a file or thread" })));
    expect(onInsert).toHaveBeenLastCalledWith("@");
    menu = await openAdd();
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Skills and commands" })));
    expect(onInsert).toHaveBeenLastCalledWith("/");
    menu = await openAdd();
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Attach files" })));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("Attach files is disabled where the harness takes no attachments", async () => {
    add({ attachable: false });
    const menu = await openAdd();
    expect(within(menu).getByRole("menuitem", { name: "Attach files" }).getAttribute("aria-disabled")).toBe("true");
  });
});

afterEach(cleanup);

describe("SendButton", () => {
  it("names the intent and sends, queues or steers through onSubmit", () => {
    const onSubmit = vi.fn();
    const onPause = vi.fn();
    const { rerender } = render(<SendButton intent="send" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith(false);
    rerender(<SendButton intent="steer" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Steer" }), { metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith(true);
    expect(onPause).not.toHaveBeenCalled();
  });

  it("an empty box mid-turn is Pause", () => {
    const onSubmit = vi.fn();
    const onPause = vi.fn();
    render(<SendButton intent="pause" disabled={false} onSubmit={onSubmit} onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disabled while there is nothing to send, easing its opacity both ways", () => {
    render(<SendButton intent="send" disabled onSubmit={() => {}} onPause={() => {}} />);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.className).toContain("transition-[opacity,color]");
    expect(button.className).toContain("duration-(--dur-fast)");
    expect(button.className).not.toMatch(/overflow-hidden|scale/);
    expect(button.classList).toContain("t-raise-primary");
    expect(button.querySelector("span.overflow-hidden")).not.toBeNull();
  });

  it("swaps its glyph through SwapIcon on every change of intent, with no blur", () => {
    const props = { disabled: false, onSubmit: () => {}, onPause: () => {} };
    const { rerender } = render(<SendButton intent="send" {...props} />);
    const button = () => screen.getByRole("button");
    expect(button().querySelectorAll("span.grid")).toHaveLength(1);
    for (const intent of ["queue", "steer", "pause"] as const) {
      rerender(<SendButton intent={intent} {...props} />);
      // The old glyph leaves while the new one comes: two sides at once.
      expect(button().querySelectorAll("span.grid").length).toBeGreaterThanOrEqual(2);
    }
    expect(button().innerHTML).not.toContain("blur");
  });
});

describe("useDraftRow", () => {
  it("shows the row on a new thread and the shell screen, and drops it after the first message", () => {
    store.blocks.set("t", []);
    const { result, rerender } = renderHook(({ id, shell }) => useDraftRow(id, shell), {
      initialProps: { id: "t" as string | undefined, shell: false },
    });
    expect(result.current).toBe(true);
    act(() => {
      store.blocks.set("t", [{ kind: "user" }]);
      for (const l of store.listeners) l();
    });
    expect(result.current).toBe(false);
    rerender({ id: "t", shell: true });
    expect(result.current).toBe(true);
    rerender({ id: undefined, shell: false });
    expect(result.current).toBe(true);
  });
});
