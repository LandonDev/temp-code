// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { OpenAgentDetailContext } from "./agentDetailContext";
import { AgentSpawnRow, AgentStepRow, reportVerb, SpawnChildRow } from "./AgentSpawnRow";

afterEach(() => {
  cleanup();
  sessionStore.reset();
});

const meta = (id: string, title: string, status = "running"): SessionMeta =>
  ({ id, parentId: "p", provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title, cwd: "/r",
    environmentId: "local", archived: false, status, createdAt: 0 }) as unknown as SessionMeta;
const push = async (m: SessionMeta) =>
  act(async () => {
    sessionStore.injectPush({ push: "session", session: m }, "local");
    await new Promise((r) => setTimeout(r, 50));
  });
const seen = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent ?? "";
};

describe("reportVerb", () => {
  it("says what the agent did by the status it settled in", () => {
    for (const s of ["done", "idle", "watching", undefined, "anything"]) expect(reportVerb(s)).toBe("Finished");
    for (const s of ["failed", "error", "blocked"]) expect(reportVerb(s)).toBe("Failed");
    expect(reportVerb("waiting")).toBe("Needs you");
    expect(reportVerb("stopped")).toBe("Stopped");
    expect(reportVerb("paused")).toBe("Paused");
  });
});

describe("AgentStepRow", () => {
  it("leads with the state's glyph, still, then the verb and the title", async () => {
    await push(meta("a", "Review the perf pass", "done"));
    for (const [status, state, verb] of [
      ["idle", "done", "Finished"],
      ["error", "failed", "Failed"],
      ["waiting", "waiting", "Needs you"],
      ["stopped", "stopped", "Stopped"],
      ["paused", "paused", "Paused"],
    ] as const) {
      const { container, unmount } = render(<AgentStepRow id="a" status={status} />);
      expect(container.querySelector('[data-slot="status-mark"]')?.getAttribute("data-state"), status).toBe(state);
      expect(seen(container), status).toBe(`${verb}Review the perf pass`);
      expect(container.querySelector(".status-breathe")).toBeNull();
      unmount();
    }
  });

  it("names an agent the store has not listed by the report's stamp, and opens its detail", () => {
    const open = vi.fn();
    const { container } = render(
      <OpenAgentDetailContext.Provider value={open}>
        <AgentStepRow id="far" status="done" stamped="Far child" />
      </OpenAgentDetailContext.Provider>,
    );
    expect(seen(container)).toBe("FinishedFar child");
    fireEvent.click(container.querySelector('button[aria-label="Finished Far child"]')!);
    expect(open).toHaveBeenCalledWith("far");
  });

  it("the batch's own report reads the batch and opens nothing", () => {
    const open = vi.fn();
    const { container } = render(
      <OpenAgentDetailContext.Provider value={open}>
        <AgentSpawnRow block={{ id: "r", role: "system", text: "", agent: { id: "self", title: "Master", status: "done", batch: true } }} />
      </OpenAgentDetailContext.Provider>,
    );
    expect(seen(container)).toBe("Finishedthe batch");
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("SpawnChildRow", () => {
  it("says Spawned, the title, and where the child stands, with no host glyph on one host", async () => {
    await push(meta("a", "Review the perf pass", "running"));
    const { container } = render(<SpawnChildRow id="a" task="Review only. Do not edit" />);
    expect(seen(container)).toBe("SpawnedReview the perf passWorking");
    expect(container.querySelector("[data-host-glyph]")).toBeNull();
  });

  it("draws a running child's Working as a dot, never a spinner", async () => {
    await push(meta("a", "Review the perf pass", "running"));
    const { container } = render(<SpawnChildRow id="a" task="Review only" />);
    expect(container.querySelector("[data-slot=working-dot]")).not.toBeNull();
    expect(container.querySelector("[data-slot=spinner]")).toBeNull();
    expect(container.querySelector("[data-slot=status-word]")?.textContent).toBe("Working");
  });

  it("stands on the spawn's title, then its task's first line, until the store has one", () => {
    expect(seen(render(<SpawnChildRow id="x" inputTitle="Audit the gateway" task="long prompt" />).container)).toBe("SpawnedAudit the gateway");
    cleanup();
    expect(seen(render(<SpawnChildRow id="y" task={"Audit every caller\nin depth"} />).container)).toBe("SpawnedAudit every caller");
  });

  it("re-words when the agent's title lands", async () => {
    const { container } = render(<SpawnChildRow id="b" task="Review only. Do not edit" />);
    expect(seen(container)).toBe("SpawnedReview only. Do not edit");
    await push(meta("b", "Payment flow review", "running"));
    expect(seen(container)).toBe("SpawnedPayment flow reviewWorking");
  });
});
