// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tcserver/commands", () => ({ sessionBatch: vi.fn() }));
vi.mock("../lib/connection/registry", () => ({ registry: { environment: () => undefined } }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

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
  vi.spyOn(sessionStore, "metas").mockReturnValue(list);
  vi.spyOn(sessionStore, "isDraft").mockReturnValue(false);
  vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => list.find((m) => m.id === id) ?? null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

type Options = { id: string; duration: number; description?: string; onDismiss: () => void; onAutoClose?: () => void; action?: { label: string; onClick: () => void } };
const options = (call: unknown[]) => call[1] as Options;

describe("ThreadBatchToasts", () => {
  it("shows a clean result as a sonner toast that leaves on its own", async () => {
    vi.mocked(commands.sessionBatch).mockResolvedValue({ attempted: ["a", "b", "c"], succeeded: ["a", "b", "c"], failed: [] });
    render(<ThreadBatchToasts onOpen={() => {}} />);
    await act(() => runThreadBatch("pause", sel));
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
    const [title] = vi.mocked(toast).mock.calls[0];
    const opts = options(vi.mocked(toast).mock.calls[0]);
    expect(title).toBe("Paused 3");
    expect(opts.duration).toBe(8_000);
    expect(toast.error).not.toHaveBeenCalled();
    await act(async () => {
      opts.onAutoClose?.();
      await Promise.resolve();
    });
    expect(toast.dismiss).toHaveBeenCalledWith(opts.id);
  });

  it("keeps a failure until it is read, names it, and Open opens the thread", async () => {
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
    const [title] = vi.mocked(toast.error).mock.calls[0];
    const opts = options(vi.mocked(toast.error).mock.calls[0]);
    expect(title).toBe("Stopped 1");
    expect(opts.description).toBe("2 failed: Search (harness not responding)");
    expect(opts.duration).toBe(Infinity);
    opts.action!.onClick();
    expect(onOpen).toHaveBeenCalledWith("a", "local");
    // The second failure is its own toast under the lead, with its error and Open.
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(2);
    const second = options(vi.mocked(toast.error).mock.calls[1]);
    expect(second.id).toBe(`${opts.id}:c`);
    expect(second.description).toBe("link down");
    second.action!.onClick();
    expect(onOpen).toHaveBeenLastCalledWith("c", "local");
    opts.onDismiss();
    expect(toast.dismiss).toHaveBeenCalledWith(`${opts.id}:c`);
  });

  it("a dismissed toast drops its notice", async () => {
    vi.mocked(commands.sessionBatch).mockResolvedValue({ attempted: ["a"], succeeded: [], failed: [{ sessionId: "a", error: "x" }] });
    render(<ThreadBatchToasts onOpen={() => {}} />);
    await act(() => runThreadBatch("resume", sel));
    const opts = options(vi.mocked(toast).mock.calls[0]);
    await act(async () => {
      opts.onDismiss();
      await Promise.resolve();
    });
    expect(toast.dismiss).toHaveBeenCalledWith(opts.id);
  });
});
