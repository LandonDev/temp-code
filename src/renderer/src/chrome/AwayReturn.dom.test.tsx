// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AwaySnapshot } from "@server/shared/contract-away";
import { attachAwayLink, resetAwayForTest } from "../lib/away";
import { registry } from "../lib/connection/registry";
import { sessionStore } from "../lib/tcserver/store";
import type { ServerPush, SessionMeta } from "../lib/tcserver/types";
import { dialogsChunk } from "../surfaces/chunks";
import { AwayReturn } from "./AwayReturn";
import { AWAY_RETURN_GATHER_MS, createAwayReturn, decisionsLabel, returnLine } from "./awayReturnModel";

vi.mock("../hooks/paneVisibility", () => ({ usePaneVisible: () => true }));

type ToastOptions = { id: string; action: { label: string; onClick: () => void } };
const toast = vi.hoisted(() => ({ call: vi.fn<(line: string, options: ToastOptions) => void>() }));
vi.mock("./toastSync", () => ({ loadToast: () => Promise.resolve(toast.call) }));

const snap = (enabled: boolean, at: number, threads: { sessionId: string; count: number }[] = []): AwaySnapshot => ({
  state: { enabled, at, by: "env_mac" },
  decided: { since: at, threads },
});

/** A host the store follows: it answers `away.get` with `first`, then pushes. */
function host(environmentId: string, first: AwaySnapshot) {
  let push: (p: ServerPush) => void = () => {};
  attachAwayLink({
    environmentId,
    connected: true,
    request: async () => first,
    onPush: (l: (p: ServerPush) => void) => ((push = l), () => {}),
    onOpen: () => () => {},
  } as never);
  return (p: AwaySnapshot) => act(() => push({ push: "away", ...p } as ServerPush));
}

beforeEach(() => {
  resetAwayForTest();
  vi.spyOn(registry, "onLink").mockReturnValue(() => {});
  toast.call.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetAwayForTest();
});

describe("returnLine", () => {
  it("counts threads, singular and plural, and decisions the same way", () => {
    expect(returnLine(4)).toBe("Decided without you in 4 threads");
    expect(returnLine(1)).toBe("Decided without you in 1 thread");
    expect(decisionsLabel(3)).toBe("3 decisions");
    expect(decisionsLabel(1)).toBe("1 decision");
  });
});

describe("createAwayReturn", () => {
  it("gathers each host's tally for three seconds after a host turns Away off", () => {
    let now = 1_000;
    const show = vi.fn();
    const push = createAwayReturn(show, () => now);
    push("local", snap(true, 1), snap(false, 2, [{ sessionId: "a", count: 2 }, { sessionId: "z", count: 0 }]));
    expect(show).toHaveBeenLastCalledWith([{ environmentId: "local", sessionId: "a", count: 2 }]);
    now += 1_000;
    push("env_box", snap(true, 1), snap(false, 2, [{ sessionId: "b", count: 1 }]));
    expect(show).toHaveBeenLastCalledWith([
      { environmentId: "local", sessionId: "a", count: 2 },
      { environmentId: "env_box", sessionId: "b", count: 1 },
    ]);
    now += AWAY_RETURN_GATHER_MS;
    push("env_box", snap(false, 2), snap(false, 2, [{ sessionId: "b", count: 5 }]));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("shows nothing when nothing was decided, or when Away only turned on", () => {
    const show = vi.fn();
    const push = createAwayReturn(show, () => 0);
    push("local", snap(true, 1), snap(false, 2));
    push("local", snap(false, 2), snap(true, 3, [{ sessionId: "a", count: 1 }]));
    expect(show).not.toHaveBeenCalled();
  });
});

describe("AwayReturn", () => {
  it("toasts the threads that decided once a live push turns Away off", async () => {
    render(<AwayReturn onOpen={() => {}} />);
    const push = host("local", snap(true, 1));
    await act(async () => {});
    push(snap(false, 2, [{ sessionId: "a", count: 3 }, { sessionId: "b", count: 1 }, { sessionId: "c", count: 2 }, { sessionId: "d", count: 1 }]));
    await waitFor(() => expect(toast.call).toHaveBeenCalled());
    const [line, options] = toast.call.mock.calls.at(-1)!;
    expect(line).toBe("Decided without you in 4 threads");
    expect(options.id).toBe("away-return");
    expect(options.action.label).toBe("Review");
  });

  it("a stretch the host decided only by allowing (each allow counted on its thread) still toasts with Review", async () => {
    render(<AwayReturn onOpen={() => {}} />);
    const push = host("local", snap(true, 1));
    await act(async () => {});
    push(snap(false, 2, [{ sessionId: "allowed-only", count: 2 }]));
    await waitFor(() => expect(toast.call).toHaveBeenCalled());
    const [line, options] = toast.call.mock.calls.at(-1)!;
    expect(line).toBe("Decided without you in 1 thread");
    expect(options.action.label).toBe("Review");
  });

  it("says one thread in the singular", async () => {
    render(<AwayReturn onOpen={() => {}} />);
    const push = host("local", snap(true, 1));
    await act(async () => {});
    push(snap(false, 2, [{ sessionId: "a", count: 3 }]));
    await waitFor(() => expect(toast.call).toHaveBeenCalledWith("Decided without you in 1 thread", expect.anything()));
  });

  it("shows nothing at boot, and nothing when no thread decided", async () => {
    render(<AwayReturn onOpen={() => {}} />);
    // The first word at boot says off with a tally: no push, no toast.
    host("env_box", snap(false, 2, [{ sessionId: "a", count: 3 }]));
    const push = host("local", snap(true, 1));
    await act(async () => {});
    push(snap(false, 2));
    await act(async () => {});
    expect(toast.call).not.toHaveBeenCalled();
  });

  it("opens the list on Review, and a row opens its thread and closes the list", async () => {
    await dialogsChunk.load();
    const metas = new Map(
      ["a", "b"].map((id) => [id, { id, title: id === "a" ? "Fix the login flow" : "Port the rail", threadType: "implementation" } as SessionMeta]),
    );
    vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => metas.get(id) ?? null);
    const onOpen = vi.fn();
    render(<AwayReturn onOpen={onOpen} />);
    const push = host("local", snap(true, 1));
    await act(async () => {});
    push(snap(false, 2, [{ sessionId: "b", count: 1 }, { sessionId: "a", count: 3 }]));
    await waitFor(() => expect(toast.call).toHaveBeenCalled());
    act(() => toast.call.mock.calls.at(-1)![1].action.onClick());
    const dialog = await screen.findByRole("dialog", { name: "Decided while you were away" });
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-away-thread]")];
    expect(rows.map((r) => r.dataset.awayThread)).toEqual(["a", "b"]);
    expect(rows[0].textContent).toContain("3 decisions");
    expect(rows[1].textContent).toContain("1 decision");
    expect(rows[0].querySelector("[data-type-glyph=implementation]")).not.toBeNull();
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledWith("a", "local");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }, 30_000);
});
