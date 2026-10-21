// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn<(environmentId: string, path: string) => Promise<string | null>>();
vi.mock("../lib/tcserver/commands", () => ({ readFile: (environmentId: string, path: string) => readFile(environmentId, path) }));

import { isSettledPlanning, usePlanReady } from "./usePlanReady";

type Input = Parameters<typeof usePlanReady>[0][number];

function Probe({ threads, onReady }: { threads: Input[]; onReady: (r: Record<string, boolean>) => void }) {
  onReady(usePlanReady(threads));
  return null;
}

afterEach(() => readFile.mockReset());

describe("isSettledPlanning", () => {
  it("counts idle and watching planning threads that have a plan path", () => {
    expect(isSettledPlanning({ threadType: "planning", status: "idle", planPath: "p.md" })).toBe(true);
    expect(isSettledPlanning({ threadType: "planning", status: "watching", planPath: "p.md" })).toBe(true);
    expect(isSettledPlanning({ threadType: "planning", status: "running", planPath: "p.md" })).toBe(false);
    expect(isSettledPlanning({ threadType: "planning", status: "watching", planPath: null })).toBe(false);
    expect(isSettledPlanning({ threadType: "implementation", status: "watching", planPath: "p.md" })).toBe(false);
  });
});

describe("usePlanReady", () => {
  it("peeks the plan of a planning thread that watches background work", async () => {
    readFile.mockImplementation(async (_environmentId, path) => (path === "written.md" ? "# plan" : ""));
    let ready: Record<string, boolean> = {};
    const threads: Input[] = [
      { id: "w", threadType: "planning", status: "watching", planPath: "written.md" },
      { id: "e", threadType: "planning", status: "watching", planPath: "empty.md" },
      { id: "r", threadType: "planning", status: "running", planPath: "written.md" },
      { id: "i", threadType: "implementation", status: "watching", planPath: "written.md" },
    ];
    const view = render(<Probe threads={threads} onReady={(r) => (ready = r)} />);
    await act(async () => {});
    expect(ready).toEqual({ w: true, e: false });
    expect(readFile.mock.calls.map(([environmentId, p]) => { expect(environmentId).toBe("local"); return p; }).sort()).toEqual(["empty.md", "written.md"]);
    view.unmount();
  });
});

vi.mock("../lib/tcserver/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/projects")>()),
  hostOfCwd: () => "local",
}));

describe("usePlanReady with plan_complete", () => {
  it("marks a completed plan ready on the server's word, without peeking at its file", async () => {
    readFile.mockImplementation(async () => "");
    let ready: Record<string, boolean> = {};
    const threads: Input[] = [
      { id: "c", threadType: "planning", status: "idle", planPath: "c.md", planCompletedAt: 5 },
      { id: "r", threadType: "planning", status: "running", planPath: "r.md", planCompletedAt: 5 },
      { id: "u", threadType: "planning", status: "idle", planPath: "u.md" },
    ];
    render(<Probe threads={threads} onReady={(r) => (ready = r)} />);
    await act(async () => {});
    expect(ready).toEqual({ c: true, u: false });
    expect(readFile).not.toHaveBeenCalledWith(expect.anything(), "c.md");
  });
});
