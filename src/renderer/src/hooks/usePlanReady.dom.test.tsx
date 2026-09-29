// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn<(path: string) => Promise<string | null>>();
vi.mock("../lib/tcserver/commands", () => ({ readFile: (path: string) => readFile(path) }));

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
    readFile.mockImplementation(async (path) => (path === "written.md" ? "# plan" : ""));
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
    expect(readFile.mock.calls.map(([p]) => p).sort()).toEqual(["empty.md", "written.md"]);
    view.unmount();
  });
});
