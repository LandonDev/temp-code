// A twelve-agent fleet shaped like the test server's TC_TEST_FLEET=large seed
// (scripts/ios-client-test-server.ts), for the rows', header's and detail's
// static looks and their tests.
import { agentStatus, type AgentStatus } from "../../../lib/threads/agents";
import type { Block } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";

const T0 = 1_761_500_000_000;

export function fixtureMeta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id,
    parentId: "ios-orch",
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    agentType: "implementer",
    title: "",
    cwd: "/srv/agents/work/temp-code",
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: T0,
    updatedAt: T0 + 252_000,
    ...over,
  } as SessionMeta;
}

/** The approval the reviewer waits on, as its transcript holds it. */
export const REVIEW_APPROVAL: Block = {
  id: "a2ap",
  role: "approval",
  text: "",
  approval: { requestId: "a2ap" },
  tool: { name: "Bash", title: "rm -rf ios/TempCodeClient/.build" },
} as Block;

export const FLEET: { meta: SessionMeta; blocks?: Block[] }[] = [
  {
    meta: fixtureMeta("ios-orch-a1", { title: "Build the shell", status: "running", activity: "Editing HomeView.swift" }),
  },
  {
    meta: fixtureMeta("ios-orch-a2", {
      title: "Review the fold",
      agentType: "reviewer",
      provider: "codex",
      model: "gpt-6-astra",
      status: "waiting",
    }),
    blocks: [REVIEW_APPROVAL],
  },
  { meta: fixtureMeta("ios-orch-a3", { title: "Find the row sizes", agentType: "explorer", status: "idle" }) },
  ...[4, 5, 6, 7, 8].map((n) => ({ meta: fixtureMeta(`ios-orch-a${n}`, { title: `Port module ${n}`, status: "idle" as const }) })),
  { meta: fixtureMeta("ios-orch-a9", { title: "Port module 9", status: "watching", activity: "Waiting on bun test" }) },
  {
    meta: fixtureMeta("ios-orch-a10", {
      title: "Port module 10",
      status: "error",
      failure: { kind: "quota", account: "work", summary: "Usage cap reached on work", cause: "" },
    }),
  },
  { meta: fixtureMeta("ios-orch-a11", { title: "Port module 11", status: "queued", activity: "Queued · 120 of 120 running" }) },
  { meta: fixtureMeta("ios-orch-a12", { title: "Port module 12", status: "stopped" }) },
];

export const FLEET_METAS: SessionMeta[] = FLEET.map((f) => f.meta);

export const FLEET_ROWS: { meta: SessionMeta; status: AgentStatus }[] = FLEET.map((f) => ({
  meta: f.meta,
  status: agentStatus(f.meta, f.blocks),
}));
