// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";

const NOW = 5_000_000;
let metas: SessionMeta[] = [];
const listeners = new Set<() => void>();
const setMetas = (next: SessionMeta[]) => {
  metas = next;
  for (const l of listeners) l();
};

vi.mock("../lib/tcserver/store", async () => {
  const React = await import("react");
  return {
    sessionStore: {
      metas: () => metas,
      isDraft: () => false,
      metaOf: (id: string) => metas.find((m) => m.id === id) ?? null,
      get: () => undefined,
    },
    useSessionMetas: () =>
      React.useSyncExternalStore(
        (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => metas,
      ),
  };
});
vi.mock("../lib/threadBatchSelection", () => ({
  useBatchSelection: (scope: unknown) => ({ catalog: { workspaces: [], projects: [] }, lastSeen: { c: NOW }, floor: 0, now: NOW, scope }),
}));
vi.mock("../lib/tcserver/commands", () => ({ sessionBatch: vi.fn() }));
vi.mock("../lib/connection/registry", () => ({ registry: { environment: () => undefined } }));

import * as commands from "../lib/tcserver/commands";
import { requestThreadBatch, resetThreadBatchForTests, setResourceCleanup, useBatchPending } from "../lib/threadBatch";
import { ThreadBatchDialog } from "./ThreadBatchDialog";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return { id: "s", environmentId: "local", parentId: null, projectId: null, workspaceId: null, cwd: "/a", title: "t", status: "idle", archived: false, updatedAt: NOW - 11 * 60_000, ...over } as SessionMeta;
}

const box = { kind: "host", environmentId: "local", name: "the box" } as const;
const sel = () => ({ catalog: { workspaces: [], projects: [] }, lastSeen: { c: NOW }, floor: 0, now: NOW, scope: box });

function Probe() {
  const pending = useBatchPending();
  return <span data-testid="pending">{pending ? pending.action : "none"}</span>;
}

beforeEach(() => {
  resetThreadBatchForTests();
  vi.mocked(commands.sessionBatch).mockReset().mockResolvedValue({ attempted: [], succeeded: [], failed: [] });
  setMetas([meta({ id: "a", status: "running" }), meta({ id: "b", status: "running" }), meta({ id: "c", status: "idle" })]);
});
afterEach(() => {
  cleanup();
  listeners.clear();
});

describe("ThreadBatchDialog", () => {
  it("shows nothing until a menu asks, then the live count, and runs on OK", async () => {
    render(
      <>
        <ThreadBatchDialog />
        <Probe />
      </>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => requestThreadBatch("pause", box, sel));
    expect(screen.getByText("Pause 2 running threads on the box?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause 2" })).toBeTruthy();
    // A thread finished while the dialog showed: the count follows.
    act(() => setMetas([meta({ id: "a", status: "running" }), meta({ id: "b", status: "idle" })]));
    expect(screen.getByText("Pause 1 running thread on the box?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause 1" }));
    });
    expect(commands.sessionBatch).toHaveBeenCalledWith("local", "pause", ["a"], {});
    expect(screen.getByTestId("pending").textContent).toBe("none");
  });

  it("disables OK when the count fell to nothing, and Cancel closes", async () => {
    render(<ThreadBatchDialog />);
    await act(() => requestThreadBatch("stop", box, sel));
    act(() => setMetas([meta({ id: "a", status: "idle" })]));
    expect(screen.getByText("Nothing to stop on the box")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commands.sessionBatch).not.toHaveBeenCalled();
  });

  it("offers the clean-up checkbox, on by default, only when the host can release resources", async () => {
    render(<ThreadBatchDialog />);
    await act(() => requestThreadBatch("archiveDone", box, sel));
    expect(screen.getByText("Archive 1 finished thread on the box?")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    });
    expect(commands.sessionBatch).toHaveBeenLastCalledWith("local", "archive", ["c"], {});

    setResourceCleanup({ count: (ids) => ids.length * 2 });
    await act(() => requestThreadBatch("archiveDone", box, sel));
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("and remove their 2 worktrees and simulators")).toBeTruthy();
    fireEvent.click(checkbox);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    });
    expect(commands.sessionBatch).toHaveBeenLastCalledWith("local", "archive", ["c"], {});

    await act(() => requestThreadBatch("archiveDone", box, sel));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    });
    expect(commands.sessionBatch).toHaveBeenLastCalledWith("local", "archive", ["c"], { cleanup: true });
  });
});
