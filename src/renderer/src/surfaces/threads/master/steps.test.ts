import { describe, expect, it } from "vitest";
import type { BatchState, BatchStep, BatchStepSpec } from "@server/shared/contract-batch";
import { consoleStep, liveStep, liveSteps, nearBottom, progressText, specOf, stepTime, tailLines, type LiveStep } from "./steps";

const batch = { landed: ["a"], pending: ["b", "c"] };
const live = (over: Partial<LiveStep>): LiveStep => ({ id: "gate", name: "Gate", kind: "gate", status: "pending", detail: "", log: [], ...over });
const specs: BatchStepSpec[] = [
  { id: "merge", name: "Merging", kind: "land" },
  { id: "gate", name: "Gate", kind: "gate" },
  { id: "smoke", name: "Smoke test", kind: "shell", run: "bun run smoke" },
];

describe("a step as the foot reads it", () => {
  it("takes the host's telemetry whole, named by the rules' row, and reads an older host's done step as passed", () => {
    const wire = { id: "gate", status: "running", detail: "", at: 5, startedAt: 100, progress: { done: 3, total: 7, label: "vitest" }, log: ["a", "b"] } as unknown as BatchStep;
    expect(liveStep(wire, batch, specs)).toEqual({ id: "gate", name: "Gate", kind: "gate", status: "running", detail: "", startedAt: 100, endedAt: undefined, progress: { done: 3, total: 7, label: "vitest" }, log: ["a", "b"] });
    expect(liveStep({ id: "gate", status: "done", detail: "ok", at: 9 } as unknown as BatchStep, batch, specs)).toMatchObject({ status: "passed", endedAt: 9, startedAt: undefined, log: [] });
    expect(liveStep({ id: "gate", status: "running", detail: "", at: 4 } as unknown as BatchStep, batch, specs)).toMatchObject({ status: "running", startedAt: 4 });
  });

  it("a shell step carries its command; a step the rules do not name is named by its id", () => {
    expect(liveStep({ id: "smoke", status: "pending", detail: "", at: null, log: [] } as unknown as BatchStep, batch, specs)).toMatchObject({ name: "Smoke test", kind: "shell", run: "bun run smoke" });
    expect(specOf("deploy", specs)).toEqual({ id: "deploy", name: "deploy", kind: "deploy" });
    expect(specOf("lint-3", specs)).toEqual({ id: "lint-3", name: "lint-3", kind: "shell" });
  });

  it("lends a land step its progress from landed and pending when the host sent none", () => {
    const merge = { id: "merge", status: "running", detail: "", at: 1 } as unknown as BatchStep;
    expect(liveStep(merge, batch, specs).progress).toEqual({ done: 1, total: 3 });
    expect(liveStep(merge, { landed: [], pending: [] }, specs).progress).toBeUndefined();
  });

  it("lists the state's steps in the state's order and a step the rules name that the host has not seen as pending at the end", () => {
    const state = {
      rules: { land: "as-they-finish", steps: specs, then: "notify" },
      steps: [
        { id: "gate", status: "passed", detail: "", at: 2, log: [] },
        { id: "merge", status: "passed", detail: "", at: 1, log: [] },
      ],
      ...batch,
    } as unknown as BatchState;
    expect(liveSteps(state).map((s) => `${s.id}:${s.name}:${s.status}`)).toEqual(["gate:Gate:passed", "merge:Merging:passed", "smoke:Smoke test:pending"]);
  });

  it("times a finished step by its ends and a running one by now", () => {
    expect(stepTime(live({ status: "passed", startedAt: 1_000, endedAt: 253_000 }), 0)).toBe("4m 12s");
    expect(stepTime(live({ status: "running", startedAt: 1_000 }), 66_000)).toBe("1m 5s");
    expect(stepTime(live({ status: "pending" }), 0)).toBeNull();
    expect(stepTime(live({ status: "passed", startedAt: 1_000 }), 0)).toBeNull();
  });

  it("reads progress as a count, a label and a percent when the total is known", () => {
    expect(progressText({ done: 3, total: 7, label: "vitest" })).toEqual({ count: "3 of 7", label: "vitest", pct: 43 });
    expect(progressText({ done: 2, total: 0 })).toEqual({ count: "2", label: null, pct: null });
    expect(progressText(undefined)).toBeNull();
  });
});

describe("the console", () => {
  it("shows the running step, else a failed one until it is folded, else nothing", () => {
    const steps = [live({ id: "land", status: "passed" }), live({ id: "gate", status: "failed" }), live({ id: "release", status: "pending" })];
    expect(consoleStep(steps, new Set())?.id).toBe("gate");
    expect(consoleStep(steps, new Set(["gate"]))).toBeNull();
    expect(consoleStep([live({ id: "land", status: "running" }), ...steps], new Set())?.id).toBe("land");
    expect(consoleStep([live({ id: "land", status: "passed" })], new Set())).toBeNull();
  });

  it("keeps the last 200 lines and follows only while the scroller sits at its bottom", () => {
    const log = Array.from({ length: 250 }, (_, i) => `l${i}`);
    expect(tailLines(log)).toHaveLength(200);
    expect(tailLines(log)[0]).toBe("l50");
    expect(nearBottom({ scrollTop: 100, scrollHeight: 300, clientHeight: 200 })).toBe(true);
    expect(nearBottom({ scrollTop: 94, scrollHeight: 300, clientHeight: 200 })).toBe(true);
    expect(nearBottom({ scrollTop: 60, scrollHeight: 300, clientHeight: 200 })).toBe(false);
  });
});
