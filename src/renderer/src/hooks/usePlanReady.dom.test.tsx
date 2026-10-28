// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The hook must never read a plan file; the mock is how the test knows.
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
  it("counts idle, watching and done planning threads that have a plan path", () => {
    expect(isSettledPlanning({ threadType: "planning", status: "idle", planPath: "p.md" })).toBe(true);
    expect(isSettledPlanning({ threadType: "planning", status: "watching", planPath: "p.md" })).toBe(true);
    expect(isSettledPlanning({ threadType: "planning", status: "done", planPath: "p.md" })).toBe(true);
    expect(isSettledPlanning({ threadType: "planning", status: "running", planPath: "p.md" })).toBe(false);
    expect(isSettledPlanning({ threadType: "planning", status: "watching", planPath: null })).toBe(false);
    expect(isSettledPlanning({ threadType: "implementation", status: "watching", planPath: "p.md" })).toBe(false);
  });
});

describe("usePlanReady", () => {
  it("is plan_complete's word alone: a completed settled plan is ready, a written one without it is not, and no file is read", async () => {
    readFile.mockImplementation(async () => "# a written plan");
    let ready: Record<string, boolean> = {};
    const threads: Input[] = [
      { id: "c", threadType: "planning", status: "idle", planPath: "c.md", planCompletedAt: 5 },
      { id: "d", threadType: "planning", status: "done", planPath: "d.md", planCompletedAt: 5 },
      { id: "w", threadType: "planning", status: "watching", planPath: "w.md", planCompletedAt: 5 },
      { id: "r", threadType: "planning", status: "running", planPath: "r.md", planCompletedAt: 5 },
      { id: "u", threadType: "planning", status: "idle", planPath: "u.md" },
      { id: "i", threadType: "implementation", status: "idle", planPath: "i.md", planCompletedAt: 5 },
    ];
    render(<Probe threads={threads} onReady={(r) => (ready = r)} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(ready).toEqual({ c: true, d: true, w: true });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps its answer's identity while the ready set holds", () => {
    const answers: Record<string, boolean>[] = [];
    const threads: Input[] = [{ id: "c", threadType: "planning", status: "idle", planPath: "c.md", planCompletedAt: 5 }];
    const view = render(<Probe threads={threads} onReady={(r) => answers.push(r)} />);
    view.rerender(<Probe threads={[...threads, { id: "x", threadType: "chat", status: "idle" }]} onReady={(r) => answers.push(r)} />);
    expect(answers[0]).toBe(answers[1]);
    view.rerender(<Probe threads={[]} onReady={(r) => answers.push(r)} />);
    expect(answers[2]).toEqual({});
  });
});
