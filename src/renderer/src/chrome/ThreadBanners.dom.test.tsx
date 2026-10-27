// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";

const { metas, notes } = vi.hoisted(() => ({
  metas: [] as SessionMeta[],
  notes: new Map<string, { text: string; updatedAt: number | null; path: string | null }>(),
}));
vi.mock("../lib/tcserver/store", () => ({
  useSessionMetas: () => metas,
  sessionFromMeta: (m: SessionMeta) => ({ harness: m.provider, model: m.model, modelSettings: {} }),
}));
const { killBackground } = vi.hoisted(() => ({ killBackground: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/tcserver/commands", () => ({ resume: vi.fn(), interrupt: vi.fn(), continueSession: vi.fn(), reasoningOf: () => "medium", killBackground }));
vi.mock("../lib/threadNotes", () => ({ useThreadNotes: (_env: string, id: string) => notes.get(id) }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./Popover", () => ({ Popover: () => null }));

import { ThreadBanners } from "./ThreadBanners";

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local", id, parentId: null, projectId: "p1", workspaceId: "w1", threadType: "implementation",
    planPath: null, provider: "claude", model: "m", reasoning: "medium", agentType: "implementer", title: id, cwd: "/a",
    status: "waiting", pinned: false, archived: false, permission: "supervised", fast: false, ultrafast: false,
    context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null, nativeId: null, createdAt: 1, updatedAt: 2,
    ...over,
  } as SessionMeta;
}

afterEach(() => {
  cleanup();
  metas.length = 0;
  notes.clear();
});

describe("the needs-you banner", () => {
  it("carries the waiting thread's State line beside its title", () => {
    metas.push(meta("Notes feature"));
    notes.set("Notes feature", { text: "## State\n\n- [ ] blocked: which port for the panel?\n- next\n", updatedAt: 1, path: null });
    render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toBe("Needs youNotes featureblocked: which port for the panel?Open");
    expect(banner.textContent).not.toContain("·");
    expect(banner.querySelector('[data-slot="status-mark"]')?.getAttribute("data-state")).toBe("waiting");
  });

  it("says nothing extra without notes, and counts when several wait", () => {
    metas.push(meta("One"));
    const { unmount } = render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("Needs youOneOpen");
    unmount();
    metas.push(meta("Two"));
    notes.set("One", { text: "## State\n\n- stuck\n", updatedAt: 1, path: null });
    render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("Needs you2 threadsOpen first");
  });
});

describe("the stale-watching banner", () => {
  it("counts the stale watchers, leaves the fresh one and the thread on screen out, and Stop all stops each", async () => {
    const now = Date.now();
    const bg = (since: number) => ({ tasks: [], agents: [], batch: null, watchingSince: since });
    metas.push(
      meta("a", { status: "watching", background: bg(now - 40 * 60_000) }),
      meta("b", { status: "watching", background: bg(now - 90 * 60_000) }),
      meta("fresh", { status: "watching", background: bg(now - 5 * 60_000) }),
      meta("here", { status: "watching", background: bg(now - 60 * 60_000) }),
    );
    const onOpen = vi.fn();
    render(<ThreadBanners projectId="p1" activeSessionId="here" onOpen={onOpen} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe("Watching2 threadsfor over 30 minStop allOpen");
    screen.getByText("Open").click();
    expect(onOpen).toHaveBeenCalledWith("b");
    screen.getByText("Stop all").click();
    await vi.waitFor(() => expect(killBackground).toHaveBeenCalledTimes(2));
    expect(killBackground.mock.calls.map((c) => (c as unknown as string[])[0]).sort()).toEqual(["a", "b"]);
  });

  it("renders nothing while every watcher is fresh", () => {
    metas.push(meta("fresh", { status: "watching", background: { tasks: [], agents: [], batch: null, watchingSince: Date.now() } }));
    const { container } = render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("the paused and recovery banners", () => {
  it("say Paused with the subject and the batch, with Stop and Continue, and no wash", () => {
    metas.push(meta("Master", { status: "paused", treeHasPaused: true }), meta("Child", { status: "paused", treeHasPaused: true, masterId: "Master" }));
    render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe("PausedMasterand 1 batch thread with itStopContinue");
    expect(banner.className).not.toMatch(/bg-|text-warning/);
  });

  it("says Failed with the thread and offers Continue beside the model chevron", () => {
    metas.push(meta("Search", { status: "error", treeCanContinue: true }));
    render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toBe("FailedSearchContinue");
    expect(screen.getByRole("button", { name: "Continue on another model" })).toBeTruthy();
  });
});
