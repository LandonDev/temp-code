import { describe, expect, it } from "vitest";
import type { BatchStepSpec } from "@server/shared/contract-batch";
import { addStep, defaultName, KIND_CHOICES, moveStep, newStepId, removeStep, renameStep, shellDraftValid, stepLine, stepsValid } from "./rulesEdit";

const steps: BatchStepSpec[] = [
  { id: "land", name: "Merging", kind: "land" },
  { id: "gate", name: "Gate", kind: "gate" },
];

describe("editing the step list", () => {
  it("offers every kind the contract knows, each with its words", () => {
    expect(KIND_CHOICES.map((c) => c.value)).toEqual(["land", "gate", "release", "publish", "deploy", "shell"]);
    expect(defaultName("gate")).toBe("Gate");
    expect(defaultName("deploy")).toBe("Deploy");
    expect(defaultName("shell")).toBe("");
    expect(stepLine({ kind: "release" })).toBe("Release");
    expect(stepLine({ kind: "shell", run: "bun run smoke" })).toBe("bun run smoke");
    expect(stepLine({ kind: "shell" })).toBe("no command");
  });

  it("adds a built-in kind with its default name and a fresh id, a shell step with the draft", () => {
    expect(addStep(steps, "release").at(-1)).toEqual({ id: "release", name: "Release", kind: "release" });
    expect(newStepId("gate", steps)).toBe("gate-2");
    expect(newStepId("gate", [...steps, { id: "gate-2", name: "", kind: "gate" }])).toBe("gate-3");
    expect(addStep(steps, "shell", { name: " Smoke test ", run: " bun run smoke ", cwd: " " }).at(-1)).toEqual({ id: "shell", name: "Smoke test", kind: "shell", run: "bun run smoke" });
    expect(addStep(steps, "shell", { name: "Build", run: "gradle build", cwd: "/srv/plugin" }).at(-1)).toMatchObject({ cwd: "/srv/plugin" });
  });

  it("moves within the list and stays put at the ends, removes and renames by index", () => {
    expect(moveStep(steps, 1, -1).map((s) => s.id)).toEqual(["gate", "land"]);
    expect(moveStep(steps, 0, -1).map((s) => s.id)).toEqual(["land", "gate"]);
    expect(moveStep(steps, 1, 1).map((s) => s.id)).toEqual(["land", "gate"]);
    expect(removeStep(steps, 0).map((s) => s.id)).toEqual(["gate"]);
    expect(renameStep(steps, 1, "Full gate")[1].name).toBe("Full gate");
  });

  it("saves only a list where every step is named and every shell step has a command", () => {
    expect(stepsValid(steps)).toBe(true);
    expect(stepsValid([...steps, { id: "x", name: " ", kind: "gate" }])).toBe(false);
    expect(stepsValid([...steps, { id: "x", name: "Smoke", kind: "shell" }])).toBe(false);
    expect(stepsValid([...steps, { id: "x", name: "Smoke", kind: "shell", run: "bun t" }])).toBe(true);
    expect(shellDraftValid({ name: "Smoke", run: "" })).toBe(false);
    expect(shellDraftValid({ name: "Smoke", run: "bun t" })).toBe(true);
  });
});
