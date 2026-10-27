// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";

const implementPlan = vi.fn(async () => ({ id: "built" }));
vi.mock("../../lib/tcserver/plans", () => ({
  implementPlan: (...args: unknown[]) => implementPlan(...(args as [])),
}));
vi.mock("../../lib/tcserver/commands", () => ({ readFile: async () => "" }));
// The build's knobs are their own components with their own tests; here
// they only need to mount.
vi.mock("../../chrome/ModelPicker", () => ({ ModelPicker: () => <span data-model-picker /> }));
vi.mock("../../chrome/ModelSettings", () => ({ ModelSettings: () => <span data-model-settings /> }));
vi.mock("../../chrome/AccessPicker", () => ({ AccessPicker: () => <span data-access-picker /> }));
vi.mock("../../chrome/ThreadTune", () => ({
  ThreadTune: () => null,
  normalizeTune: () => undefined,
  tuneSummary: () => null,
}));
vi.mock("../AgentMarkdown", () => ({ AgentMarkdown: () => null }));
vi.mock("./fleet/FleetPanel", () => ({ FleetPulseLine: () => null }));
vi.mock("../../lib/models", () => ({
  mergeModelSettings: (_m: unknown, s: Record<string, string>) => s,
  nativeModelId: (m: string) => m,
  resolveModel: () => null,
}));

import { StartButton } from "./PlanView";

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
});

async function open(): Promise<void> {
  render(<StartButton session={session} tasks={["a", "b"]} />);
  fireEvent.click(screen.getByRole("button", { name: /^Start/ }));
  await act(async () => {});
}

describe("the plan's Start", () => {
  it("offers no count of parallel threads: one implementation thread, or one orchestrator", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /^\d thread/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b[23] threads\b/);
    expect(screen.getByText("Implement")).toBeTruthy();
    expect(screen.getByText("Orchestrate")).toBeTruthy();
  });

  it("Implement starts exactly one implementation thread seeded from the plan", async () => {
    await open();
    fireEvent.click(screen.getByText("Implement"));
    await act(async () => {});
    // One call into the server's own start (plan.implement): the plan
    // thread's id, one build, never a count.
    expect(implementPlan).toHaveBeenCalledTimes(1);
    const [environmentId, planId, params] = implementPlan.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(environmentId).toBe("local");
    expect(planId).toBe("plan-1");
    expect(params.threadType).toBe("implementation");
    expect(params).not.toHaveProperty("workers");
  });

  it("Orchestrate starts exactly one orchestration thread", async () => {
    await open();
    fireEvent.click(screen.getByText("Orchestrate"));
    await act(async () => {});
    expect(implementPlan).toHaveBeenCalledTimes(1);
    const [, , params] = implementPlan.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(params.threadType).toBe("orchestration");
  });
});
