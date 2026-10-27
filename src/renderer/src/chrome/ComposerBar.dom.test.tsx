// @vitest-environment jsdom
/**
 * The composer's bar: one row of `+`, the model button, the permission
 * mode and send (no mode for fx; no account, goal or context control for
 * anyone); the `+` menu's three rows; the send button speaking the intent
 * Enter would carry out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

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

import { ComposerBar, SendButton, useDraftRow } from "./ComposerBar";
import type { HarnessId } from "../lib/session";

function bar(harness: HarnessId, handlers: { onAttach?: () => void; onInsert?: (mark: "@" | "/") => void } = {}) {
  return render(
    <ComposerBar
      harness={harness}
      model={<button type="button">Opus 5.5</button>}
      runtimeMode="supervised"
      onRuntimeModeChange={() => {}}
      onAttach={handlers.onAttach ?? (() => {})}
      onInsert={handlers.onInsert ?? (() => {})}
      fieldOf={() => null}
      onClose={() => {}}
      send={<SendButton intent="send" disabled onSubmit={() => {}} onPause={() => {}} />}
    />,
  );
}

function rowNames(container: HTMLElement): string[] {
  const row = container.querySelector<HTMLElement>("[data-composer-bar]")!;
  return [...row.querySelectorAll("button, [role=combobox]")].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent ?? "",
  );
}

async function openAdd() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  });
  return screen.getByRole("menu", { name: "Add" });
}

describe("ComposerBar", () => {
  it("holds exactly +, the model button, the mode and send for Claude and Codex", () => {
    for (const harness of ["claude", "codex"] as const) {
      const { container, unmount } = bar(harness);
      expect(rowNames(container)).toEqual(["Add", "Opus 5.5", "Permission mode: Supervised", "Send"]);
      unmount();
    }
  });

  it("is a size container whose mode label gives way to its icon, and Add and Send never shrink", () => {
    const { container } = bar("claude");
    const row = container.querySelector<HTMLElement>("[data-composer-bar]")!;
    expect(row.className).toContain("@container/composer-bar");
    const mode = screen.getByRole("combobox", { name: "Permission mode: Supervised" });
    expect(within(mode).getByText("Supervised").className).toContain("@max-[21rem]/composer-bar:hidden");
    for (const name of ["Add", "Send"]) expect(screen.getByRole("button", { name }).className).toContain("shrink-0");
  });

  it("fx has no permission mode; nobody has an account, goal or context control", () => {
    const { container } = bar("fx");
    expect(rowNames(container)).toEqual(["Add", "Opus 5.5", "Send"]);
    for (const name of [/account/i, /goal/i, /context/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("the + menu: attach, mention and skills", async () => {
    const onAttach = vi.fn();
    const onInsert = vi.fn();
    bar("claude", { onAttach, onInsert });
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

  it("Attach files is disabled for fx", async () => {
    bar("fx");
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

  it("disabled while there is nothing to send", () => {
    render(<SendButton intent="send" disabled onSubmit={() => {}} onPause={() => {}} />);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
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
