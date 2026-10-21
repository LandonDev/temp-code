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
vi.mock("../lib/tcserver/commands", () => ({ resume: vi.fn(), interrupt: vi.fn(), continueSession: vi.fn(), reasoningOf: () => "medium" }));
vi.mock("../lib/threadNotes", () => ({ useThreadNotes: (_env: string, id: string) => notes.get(id) }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./ModelSettings", () => ({ ModelSettings: () => null }));
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
    expect(screen.getByRole("alert").textContent).toContain("Notes feature needs you");
    expect(screen.getByRole("alert").textContent).toContain("· blocked: which port for the panel?");
  });

  it("says nothing extra without notes, and counts when several wait", () => {
    metas.push(meta("One"));
    const { unmount } = render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("One needs youOpen");
    unmount();
    metas.push(meta("Two"));
    notes.set("One", { text: "## State\n\n- stuck\n", updatedAt: 1, path: null });
    render(<ThreadBanners projectId="p1" onOpen={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("2 threads need youOpen first");
  });
});
