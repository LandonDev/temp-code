// @vitest-environment jsdom
/**
 * The agent detail's content (A18): the numbers line is words and counts
 * with no icons or dots, Open hands the agent to a pane and closes, and the
 * field steers a live agent and messages a settled one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SessionMeta } from "../../../lib/tcserver/types";

const h = vi.hoisted(() => ({
  environments: [{ id: "local", name: "This Mac" }] as { id: string; name: string; platform?: string }[],
  metas: new Map<string, SessionMeta>(),
  send: vi.fn(async () => {}),
  steer: vi.fn(async () => {}),
  transcript: null as Record<string, unknown> | null,
  session: null as Record<string, unknown> | null,
}));

vi.mock("../../../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/connection/status")>()),
  useEnvironments: () => h.environments,
}));
vi.mock("../../../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/threads/agents")>()),
  useMetaById: (id: string | null) => (id ? (h.metas.get(id) ?? null) : null),
  useSessionById: (id: string | null) => (id ? { id, blocks: [], loaded: true, environmentId: "local", ...h.session } : undefined),
}));
vi.mock("../../../lib/tcserver/commands", () => ({ send: h.send, steer: h.steer }));
vi.mock("../../../lib/contextCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/contextCache")>()),
  useContextReading: () => null,
}));
vi.mock("../../AgentTranscript", () => ({
  AgentTranscript: (props: Record<string, unknown>) => {
    h.transcript = props;
    return null;
  },
}));

import { AgentDetailBody, AgentDetailHeader } from "./AgentDetailBody";
import { setHarnessModels, resetHarnessModelOverlays } from "../../../lib/models";
import { TurnEnd } from "../../transcript/TurnEnd";
import type { TurnSession } from "../../turnState";
import { FLEET, fixtureMeta } from "./fleetFixture";
import { agentStatus } from "../../../lib/threads/agents";

afterEach(() => {
  cleanup();
  resetHarnessModelOverlays();
  h.metas.clear();
  h.send.mockClear();
  h.steer.mockClear();
  h.environments = [{ id: "local", name: "This Mac" }];
  h.session = null;
});

describe("AgentDetailHeader", () => {
  it("says the numbers after the model, with no dots and the diff in its tones", () => {
    const meta = FLEET[0].meta;
    const { container } = render(
      <AgentDetailHeader
        meta={meta}
        status={agentStatus(meta)}
        branch="feature-x"
        parts={[
          { key: "diff", adds: 140, dels: 12 },
          { key: "tasks", text: "3/7 tasks" },
          { key: "cost", text: "$0.12" },
        ]}
      />,
    );
    const line = container.querySelector('[data-slot="agent-numbers"]')!;
    expect(line.className).toContain("tabular-nums");
    expect(line.querySelector("[data-model-line] [data-model]")).not.toBeNull();
    expect(line.textContent).not.toContain("·");
    expect(line.textContent).toContain("feature-x");
    // The words and numbers are one comma run, never facts apart by space alone.
    expect(line.querySelector('[data-slot="agent-facts"]')?.textContent).toBe("feature-x, +140 −12, 3/7 tasks, $0.12");
    expect(line.querySelector("[data-model-effort]")?.textContent).toBe("High");
    expect(line.querySelector(".text-success")?.textContent).toBe("+140");
    expect(line.querySelector(".text-destructive")?.textContent).toBe("−12");
  });
  it("leads the detail with the same model name and effort as the panel row", () => {
    setHarnessModels("codex", [{ id: "codex:gpt-6.1-sol", nativeId: "gpt-6.1-sol", harness: "codex", name: "GPT-6.1 Sol" }]);
    const meta = fixtureMeta("sol", { provider: "codex", model: "gpt-6.1-sol", reasoning: "xhigh" });
    const { container } = render(<AgentDetailHeader meta={meta} status={agentStatus(meta)} parts={[]} />);
    const line = container.querySelector("[data-slot=agent-numbers]")!;
    expect(line.firstElementChild?.hasAttribute("data-model-line")).toBe(true);
    expect(line.querySelector("[data-model-name]")?.textContent).toBe("GPT-6.1 Sol");
    expect(line.querySelector("[data-model-effort]")?.textContent).toBe("Extra high");
  });

});

describe("AgentDetailBody", () => {
  it("Open hands the agent to a pane and closes", () => {
    h.metas.set("a1", FLEET[2].meta);
    const onOpenSession = vi.fn();
    const onClose = vi.fn();
    const { getByText } = render(
      <AgentDetailBody agentId="a1" parentCwd="/repo" onOpenSession={onOpenSession} onClose={onClose} />,
    );
    fireEvent.click(getByText("Open"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith("a1");
  });

  it("a failed steer keeps the person's words and says why under the field; a sent one clears it", async () => {
    h.metas.set("live", fixtureMeta("live", { status: "running" }));
    h.steer.mockImplementationOnce(async () => {
      throw new Error("no live harness");
    });
    const view = render(<AgentDetailBody agentId="live" parentCwd="/repo" onClose={() => {}} />);
    const field = view.getByPlaceholderText("Steer this agent…") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "use the cache" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Couldn't steer: no live harness"));
    expect(field.value).toBe("use the cache");
    expect(view.getByRole("alert").className).toContain("text-destructive");
    // Typing again clears the line; a send that lands clears the field.
    fireEvent.change(field, { target: { value: "use the cache, please" } });
    expect(view.queryByRole("alert")).toBeNull();
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("holds the transcript's skeleton while its sheet slides in", () => {
    h.metas.set("idle", fixtureMeta("idle", { status: "idle" }));
    const view = render(<AgentDetailBody agentId="idle" parentCwd="/repo" ready={false} onClose={() => {}} />);
    expect(view.container.querySelector('[data-surface-skeleton="transcript"]')).toBeTruthy();
    view.rerender(<AgentDetailBody agentId="idle" parentCwd="/repo" ready onClose={() => {}} />);
    expect(view.container.querySelector('[data-surface-skeleton="transcript"]')).toBeNull();
  });

  it("steers a live agent and messages a settled one", async () => {
    h.metas.set("live", fixtureMeta("live", { status: "running" }));
    const live = render(<AgentDetailBody agentId="live" parentCwd="/repo" onClose={() => {}} />);
    const field = live.getByPlaceholderText("Steer this agent…");
    fireEvent.change(field, { target: { value: "use the cache" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(h.steer).toHaveBeenCalledOnce());
    expect(h.send).not.toHaveBeenCalled();
    cleanup();

    h.metas.set("idle", fixtureMeta("idle", { status: "idle" }));
    const idle = render(<AgentDetailBody agentId="idle" parentCwd="/repo" onClose={() => {}} />);
    const field2 = idle.getByPlaceholderText("Message this agent…");
    fireEvent.change(field2, { target: { value: "one more thing" } });
    fireEvent.submit(field2.closest("form")!);
    await waitFor(() => expect(h.send).toHaveBeenCalledOnce());
  });

  it("the header says no elapsed time: the turn's closing line already does", () => {
    h.metas.set("old", fixtureMeta("old", { status: "running", createdAt: Date.now() - 252_000 }));
    const { container } = render(<AgentDetailBody agentId="old" parentCwd="/repo" onClose={() => {}} />);
    expect(container.textContent).not.toMatch(/\d+m \d+s/);
  });

  it("hands the agent's session to its transcript, so a paused turn reads Paused, not Worked for", async () => {
    h.metas.set("old", fixtureMeta("old", { status: "paused" }));
    render(<AgentDetailBody agentId="old" parentCwd="/repo" onClose={() => {}} />);
    await waitFor(() => expect(h.transcript).not.toBeNull());
    expect(h.transcript?.turn).toMatchObject({ id: "old" });
    expect(h.transcript?.liveState).toBeUndefined();
  });

  it("a watching agent's sheet ends in the Watching row: its transcript gets the session's background", async () => {
    const user = { id: "u", role: "user", text: "go" };
    const background = { tasks: [{ id: "b1", label: "sleep 90 seconds", kind: "shell", startedAt: 1 }], agents: [], batch: null, watchingSince: Date.now() - 120_000 };
    h.metas.set("w", fixtureMeta("w", { status: "watching" }));
    h.session = { status: "watching", blocks: [user], background };
    render(<AgentDetailBody agentId="w" parentCwd="/repo" onClose={() => {}} />);
    await waitFor(() => expect(h.transcript).not.toBeNull());
    const turn = h.transcript?.turn as TurnSession;
    expect(turn.background).toEqual(background);
    expect(h.transcript?.liveState).toBeUndefined();
    const { container } = render(
      <TurnEnd
        turn={{ id: "t", index: 0, isLast: true, settled: true, blocks: turn.blocks, userBlock: turn.blocks[0], durationMs: 2_000, startedAt: 1 }}
        harnessOf={() => undefined}
        turnState={turn}
      />,
    );
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/^Watchingsleep 90 seconds2m( \d+s)?$/);
  });

  it("names a far child's host", () => {
    h.environments = [
      { id: "local", name: "This Mac" },
      { id: "env_box", name: "The box", platform: "linux" },
    ];
    h.metas.set("far", fixtureMeta("far", { environmentId: "env_box", title: "Far" }));
    const { container } = render(<AgentDetailBody agentId="far" parentCwd="/repo" onClose={() => {}} />);
    expect(container.querySelector("[data-host-glyph]")?.getAttribute("aria-label")).toBe("The box");
  });
});
