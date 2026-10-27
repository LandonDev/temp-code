// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";

let resolveStart: (() => void) | null = null;
const implementPlan = vi.fn(
  () =>
    new Promise<{ id: string }>((resolve) => {
      resolveStart = () => resolve({ id: "built" });
    }),
);
vi.mock("../../lib/tcserver/plans", () => ({
  implementPlan: (...args: unknown[]) => implementPlan(...(args as [])),
}));
vi.mock("../../lib/tcserver/commands", () => ({ readFile: async () => "" }));
// The build's knobs are their own components with their own tests; here
// they only need to mount, and to be somewhere a press can land.
// The real picker's popover is portalled outside the dialog, as this is.
vi.mock("../../chrome/ModelPicker", async () => {
  const { createPortal } = await import("react-dom");
  return {
    ModelPicker: () =>
      createPortal(
        <button type="button" data-model-picker>
          model
        </button>,
        document.body,
      ),
  };
});
vi.mock("../../chrome/AccessPicker", () => ({ AccessPicker: () => <span data-access-picker /> }));
vi.mock("../../chrome/ThreadTune", () => ({
  ThreadTune: () => <div data-thread-tune />,
  normalizeTune: () => ({ instructions: "x" }),
}));
vi.mock("../../lib/models", () => ({
  mergeModelSettings: (_m: unknown, s: Record<string, string>) => s,
  nativeModelId: (m: string) => m,
  resolveModel: () => null,
}));

import { landedInPicker, StartBuildDialog } from "./StartBuildDialog";

const session = {
  id: "plan-1",
  environmentId: "local",
  harness: "claude",
  model: "claude-opus-5-5",
  modelSettings: { effort: "high" },
  runtimeMode: "ask",
  title: "Plan: Ship the thing",
  cwd: "/repo",
  projectId: "p1",
  workspaceId: null,
  planPath: "/repo/.temp-code/plan-1.md",
  blocks: [],
} as unknown as Session;

afterEach(() => {
  cleanup();
  implementPlan.mockClear();
  resolveStart = null;
});

async function open(tasks = ["a", "b"], onOpenChange = vi.fn()) {
  render(<StartBuildDialog session={session} tasks={tasks} open onOpenChange={onOpenChange} />);
  await act(async () => {});
  return onOpenChange;
}

const params = () => (implementPlan.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];

async function start(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await act(async () => {});
}

describe("the Start dialog", () => {
  it("offers one implementation thread or one orchestrator, never a count of threads", async () => {
    await open();
    expect(screen.getByText("Start the build")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Implement" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Orchestrate" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b[23] threads\b/);
    // Taller than a small window, it scrolls instead of hiding its footer.
    expect((document.querySelector('[data-slot="dialog-content"]') as HTMLElement).className).toMatch(/overflow-y-auto/);
  });

  it("Start starts exactly one implementation thread by default, and closes", async () => {
    const onOpenChange = await open();
    await start();
    expect(screen.getByText("Starting…")).toBeTruthy();
    await act(async () => resolveStart?.());
    expect(implementPlan).toHaveBeenCalledTimes(1);
    const [environmentId, planId] = implementPlan.mock.calls[0] as unknown as [string, string];
    expect(environmentId).toBe("local");
    expect(planId).toBe("plan-1");
    expect(params().threadType).toBe("implementation");
    expect(params()).not.toHaveProperty("workers");
    expect(params()).not.toHaveProperty("threadRules");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Orchestrate starts one orchestration thread with its rules", async () => {
    await open();
    expect(document.querySelector("[data-thread-tune]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Orchestrate" }));
    expect(document.querySelector("[data-thread-tune]")).toBeTruthy();
    await start();
    await act(async () => resolveStart?.());
    expect(implementPlan).toHaveBeenCalledTimes(1);
    expect(params().threadType).toBe("orchestration");
    expect(params().threadRules).toEqual({ instructions: "x" });
  });

  it("prefills the goal from the plan, and an emptied goal starts with none", async () => {
    await open();
    const goal = screen.getByLabelText("Goal") as HTMLInputElement;
    expect(goal.value).toBe("Every task in the plan's checklist is checked off and typecheck passes");
    fireEvent.change(goal, { target: { value: "" } });
    await start();
    await act(async () => resolveStart?.());
    expect(params().goal).toBeUndefined();
  });

  it("a plan without tasks prefills the plain goal", async () => {
    await open([]);
    expect((screen.getByLabelText("Goal") as HTMLInputElement).value).toBe(
      "The plan is fully implemented and typecheck passes",
    );
  });

  it("a press inside a picker keeps the dialog open; one outside closes it", async () => {
    const onOpenChange = await open();
    const picker = document.querySelector("[data-model-picker]") as HTMLElement;
    fireEvent.pointerDown(picker);
    fireEvent.mouseDown(picker);
    fireEvent.click(picker);
    await act(async () => {});
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    await act(async () => {});
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a failed start stays open with the error", async () => {
    implementPlan.mockImplementationOnce(() => Promise.reject(new Error("no such plan")));
    const onOpenChange = await open();
    await start();
    expect(screen.getByText("no such plan")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("refuses a close that landed in a picker, and only that", () => {
    const picker = document.createElement("div");
    picker.setAttribute("data-access-picker", "");
    const option = document.createElement("button");
    picker.appendChild(option);
    const press = { target: option } as unknown as Event;
    expect(landedInPicker("outside-press", press)).toBe(true);
    expect(landedInPicker("focus-out", { target: null, relatedTarget: option } as unknown as Event)).toBe(true);
    expect(landedInPicker("escape-key", press)).toBe(false);
    expect(landedInPicker("outside-press", { target: document.body } as unknown as Event)).toBe(false);
  });
});
