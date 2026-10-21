// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tcserver/commands", () => ({ sessionBatch: vi.fn() }));
vi.mock("../lib/connection/registry", () => ({ registry: { environment: () => undefined } }));

import * as commands from "../lib/tcserver/commands";
import { sessionStore } from "../lib/tcserver/store";
import { resetThreadBatchForTests, runThreadBatch } from "../lib/threadBatch";
import type { SessionMeta } from "../lib/tcserver/types";
import { ThreadBatchToasts } from "./ThreadBatchToasts";

const NOW = 5_000_000;
function meta(over: Partial<SessionMeta>): SessionMeta {
  return { id: "s", environmentId: "local", parentId: null, projectId: null, workspaceId: null, cwd: "/a", title: "t", status: "running", archived: false, updatedAt: NOW, ...over } as SessionMeta;
}
const list = [meta({ id: "a", title: "Search" }), meta({ id: "b", title: "Build" }), meta({ id: "c", title: "Deploy" })];
const sel = { catalog: { workspaces: [], projects: [] }, lastSeen: {}, floor: 0, now: NOW, scope: { kind: "all" } as const };

beforeEach(() => {
  resetThreadBatchForTests();
  vi.useFakeTimers();
  vi.spyOn(sessionStore, "metas").mockReturnValue(list);
  vi.spyOn(sessionStore, "isDraft").mockReturnValue(false);
  vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => list.find((m) => m.id === id) ?? null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ThreadBatchToasts", () => {
  it("fades a clean result after a while", async () => {
    vi.mocked(commands.sessionBatch).mockResolvedValue({ attempted: ["a", "b", "c"], succeeded: ["a", "b", "c"], failed: [] });
    render(<ThreadBatchToasts onOpen={() => {}} />);
    await act(() => runThreadBatch("pause", sel));
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Paused 3");
    expect(toast.getAttribute("data-batch-notice")).toBe("ok");
    act(() => {
      vi.advanceTimersByTime(8_100);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a failure on screen, names it, and the link opens the thread", async () => {
    vi.mocked(commands.sessionBatch).mockResolvedValue({
      attempted: ["a", "b", "c"],
      succeeded: ["b"],
      failed: [
        { sessionId: "a", error: "harness not responding" },
        { sessionId: "c", error: "link down" },
      ],
    });
    const onOpen = vi.fn();
    render(<ThreadBatchToasts onOpen={onOpen} />);
    await act(() => runThreadBatch("stop", sel));
    const toast = screen.getByRole("status");
    expect(toast.getAttribute("data-batch-notice")).toBe("failed");
    expect(toast.querySelector("span")!.textContent).toBe("Stopped 1 · 2 failed: Search (harness not responding) and 1 more");
    expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpen).toHaveBeenCalledWith("a", "local");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Dismiss removes it", async () => {
    vi.mocked(commands.sessionBatch).mockResolvedValue({ attempted: ["a"], succeeded: [], failed: [{ sessionId: "a", error: "x" }] });
    render(<ThreadBatchToasts onOpen={() => {}} />);
    await act(() => runThreadBatch("resume", sel));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
