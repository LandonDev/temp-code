// @vitest-environment jsdom
/**
 * The host glyph (chrome/HostGlyph.tsx) wherever agents and Inbox items are
 * listed outside the rail: the fleet panel's row and detail, the
 * orchestrator's spawn row (a cross-host child before its row is known),
 * and the Inbox row, which drew the host's name before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SessionMeta } from "../lib/tcserver/types";

const h = vi.hoisted(() => ({
  environments: [
    { id: "local", name: "This Mac" },
    { id: "env_box", name: "The box", platform: "linux" },
  ] as { id: string; name: string; platform?: string }[],
  metas: new Map<string, SessionMeta>(),
}));

vi.mock("../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection/status")>()),
  useEnvironments: () => h.environments,
}));
vi.mock("../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/threads/agents")>()),
  useMetaById: (id: string | null) => (id ? (h.metas.get(id) ?? null) : null),
  useSessionById: () => null,
}));
vi.mock("./threads/fleet/useFleetModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./threads/fleet/useFleetModel")>()),
  useAgentModel: () => ({ session: null, live: false, idle: true, line: { text: "", tone: "muted" }, stats: { adds: 0, dels: 0, tasksDone: 0, tasksTotal: 0, ctxPct: null }, elapsed: 0 }),
}));
vi.mock("./threads/fleet/contextCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./threads/fleet/contextCache")>()),
  useContextReading: () => null,
}));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));

import { AgentRow } from "./threads/fleet/AgentRow";
import { AgentDetail } from "./threads/fleet/AgentDetail";
import { AgentSpawnRow, hostOfAgentId } from "./AgentSpawnRow";
import { InboxRow } from "./InboxView";

const agent = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "env_box",
    id: "a1",
    parentId: "root",
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    agentType: "worker",
    title: "Port the view",
    cwd: "/srv/repo",
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as SessionMeta;

const glyphOf = (el: ParentNode) => el.querySelector("[data-host-glyph]");

afterEach(() => {
  cleanup();
  h.metas.clear();
});

describe("the host glyph beside agents and Inbox items", () => {
  it("the fleet row and the agent's detail name the child's host", () => {
    h.metas.set("a1", agent());
    const row = render(<AgentRow agent={agent()} now={10} onOpen={() => {}} />);
    expect(glyphOf(row.container)?.getAttribute("title")).toBe("The box");
    expect(glyphOf(row.container)?.getAttribute("data-host-kind")).toBe("server");
    const detail = render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={() => {}} />);
    expect(glyphOf(detail.container)?.getAttribute("title")).toBe("The box");
  });

  it("the spawn row names the child's host, from the row or from a cross-host id", () => {
    h.metas.set("a1", agent({ environmentId: "local" }));
    const known = render(<AgentSpawnRow block={{ agent: { id: "a1", title: "Port the view" } } as never} />);
    expect(glyphOf(known.container)?.getAttribute("title")).toBe("This Mac");
    const far = render(<AgentSpawnRow block={{ agent: { id: "env_box:s9", title: "Far child" } } as never} />);
    expect(glyphOf(far.container)?.getAttribute("data-host-glyph")).toBe("env_box");
    expect(hostOfAgentId("plain-id")).toBeUndefined();
  });

  it("with one host nothing is drawn", () => {
    const saved = h.environments;
    h.environments = [saved[0]];
    try {
      const row = render(<AgentRow agent={agent()} now={10} onOpen={() => {}} />);
      expect(glyphOf(row.container)).toBeNull();
    } finally {
      h.environments = saved;
    }
  });

  it("the Inbox row draws the host's glyph where it wrote the name", () => {
    const item = {
      kind: "pr",
      number: 7,
      title: "Fix the gate",
      url: "https://github.com/me/app/pull/7",
      state: "OPEN",
      updatedAt: new Date().toISOString(),
      labels: [],
      assignees: [],
      draft: false,
      repo: "me/app",
      projectPath: "/srv/repo",
      provider: "github",
      environmentId: "env_box",
    } as never;
    const card = render(
      <InboxRow item={item} active={false} environmentId="env_box" showSource onSelect={() => {}} />,
    );
    expect(glyphOf(card.container)?.getAttribute("title")).toBe("The box");
    expect(card.container.textContent).not.toContain("The box");
  });
});
