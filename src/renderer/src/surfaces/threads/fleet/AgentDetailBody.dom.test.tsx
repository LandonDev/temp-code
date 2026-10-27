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
}));

vi.mock("../../../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/connection/status")>()),
  useEnvironments: () => h.environments,
}));
vi.mock("../../../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/threads/agents")>()),
  useMetaById: (id: string | null) => (id ? (h.metas.get(id) ?? null) : null),
  useSessionById: (id: string | null) => (id ? { id, blocks: [], loaded: true, environmentId: "local" } : undefined),
}));
vi.mock("../../../lib/tcserver/commands", () => ({ send: h.send, steer: h.steer }));
vi.mock("./contextCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contextCache")>()),
  useContextReading: () => null,
}));
vi.mock("../../AgentTranscript", () => ({ AgentTranscript: () => null }));

import { AgentDetailBody, AgentDetailHeader } from "./AgentDetailBody";
import { FLEET, fixtureMeta } from "./fleetFixture";
import { agentStatus } from "../../../lib/threads/agents";

afterEach(() => {
  cleanup();
  h.metas.clear();
  h.send.mockClear();
  h.steer.mockClear();
  h.environments = [{ id: "local", name: "This Mac" }];
});

describe("AgentDetailHeader", () => {
  it("says the numbers in one muted tabular line, no icons and no dots, the diff in its tones", () => {
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
    expect(line.querySelector("svg")).toBeNull();
    expect(line.textContent).not.toContain("·");
    expect(line.textContent).toContain("feature-x");
    expect(line.textContent).toContain("high");
    expect(line.querySelector(".text-success")?.textContent).toBe("+140");
    expect(line.querySelector(".text-destructive")?.textContent).toBe("−12");
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

  it("names a far child's host", () => {
    h.environments = [
      { id: "local", name: "This Mac" },
      { id: "env_box", name: "The box", platform: "linux" },
    ];
    h.metas.set("far", fixtureMeta("far", { environmentId: "env_box", title: "Far" }));
    const { container } = render(<AgentDetailBody agentId="far" parentCwd="/repo" onClose={() => {}} />);
    expect(container.querySelector("[data-host-glyph]")?.getAttribute("title")).toBe("The box");
  });
});
