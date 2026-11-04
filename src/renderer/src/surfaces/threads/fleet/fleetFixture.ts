// A twelve-agent fleet shaped like the test server's TC_TEST_FLEET=large seed
// (scripts/ios-client-test-server.ts), for the rows', header's and detail's
// static looks and their tests. Live agents' clocks start a little before
// the module loads, so a preview reads "2m 31s", not days.
import { agentStatus, type AgentStatus } from "../../../lib/threads/agents";
import type { Block } from "../../../lib/session";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { createElement } from "react";
import { CloudServer } from "../../../chrome/icons";
import type { HostGlyphOf } from "../ModelMark";

const T0 = 1_761_500_000_000;
const NOW = Date.now();

/** The second host's id in the fixtures. */
export const BOX = "env_box";

/** A host glyph without a store: the box's server glyph, nothing for this machine. */
export const fixtureHostGlyph: HostGlyphOf = (environmentId) =>
  environmentId === BOX
    ? createElement(
        "span",
        { role: "img", "aria-label": "The box", "data-host-glyph": environmentId, className: "inline-flex shrink-0 text-muted-foreground" },
        createElement(CloudServer, { className: "size-3" }),
      )
    : null;

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
    meta: fixtureMeta("ios-orch-a1", {
      title: "Build the shell",
      status: "running",
      activity: "Editing HomeView.swift",
      busySince: NOW - 151_000,
      tasks: { done: 3, total: 7 },
    }),
  },
  {
    meta: fixtureMeta("ios-orch-a2", {
      title: "Review the fold",
      agentType: "reviewer",
      provider: "codex",
      model: "gpt-6-astra",
      status: "waiting",
      environmentId: BOX,
      busySince: NOW - 48_000,
    }),
    blocks: [REVIEW_APPROVAL],
  },
  {
    meta: fixtureMeta("ios-orch-a3", {
      title: "Find the row sizes",
      agentType: "explorer",
      status: "idle",
      provider: "codex",
      model: "gpt-6.1-sol",
      lastEventAt: T0 + 74_000,
    }),
  },
  ...[4, 5, 6, 7, 8].map((n) => ({
    meta: fixtureMeta(`ios-orch-a${n}`, { title: `Port module ${n}`, status: "idle" as const, lastEventAt: T0 + n * 61_000 }),
  })),
  {
    meta: fixtureMeta("ios-orch-a9", {
      title: "Port module 9",
      status: "watching",
      activity: "Waiting on bun test",
      busySince: NOW - 400_000,
      background: { tasks: [], agents: [], watchingSince: NOW - 95_000 } as unknown as SessionMeta["background"],
    }),
  },
  {
    meta: fixtureMeta("ios-orch-a10", {
      title: "Port module 10",
      status: "error",
      lastEventAt: T0 + 512_000,
      failure: { kind: "quota", account: "work", summary: "Usage cap reached on work", cause: "" },
    }),
  },
  { meta: fixtureMeta("ios-orch-a11", { title: "Port module 11", status: "queued", activity: "Queued · 120 of 120 running" }) },
  { meta: fixtureMeta("ios-orch-a12", { title: "Port module 12", status: "stopped", lastEventAt: T0 + 33_000 }) },
];

export const FLEET_METAS: SessionMeta[] = FLEET.map((f) => f.meta);

export const FLEET_ROWS: { meta: SessionMeta; status: AgentStatus }[] = FLEET.map((f) => ({
  meta: f.meta,
  status: agentStatus(f.meta, f.blocks),
}));

/** Two agents the shell's builder spawned, and one of theirs: a tree under one row. */
export const FLEET_DESCENDANTS: SessionMeta[] = [
  fixtureMeta("ios-orch-a1-c1", {
    parentId: "ios-orch-a1",
    title: "Lay out the sidebar",
    agentType: "explorer",
    status: "running",
    activity: "Reading SidebarView.swift",
    busySince: NOW - 22_000,
    createdAt: T0 + 1,
  }),
  fixtureMeta("ios-orch-a1-c1-g1", {
    parentId: "ios-orch-a1-c1",
    title: "Measure the rows",
    agentType: "explorer",
    status: "idle",
    createdAt: T0 + 2,
    lastEventAt: T0 + 19_000,
  }),
  fixtureMeta("ios-orch-a1-c2", {
    parentId: "ios-orch-a1",
    title: "Check the tab bar",
    agentType: "reviewer",
    status: "idle",
    createdAt: T0 + 3,
    lastEventAt: T0 + 41_000,
  }),
];

/** The fleet and its descendants, every row a store would hold. */
export const FLEET_TREE_METAS: SessionMeta[] = [...FLEET_METAS, ...FLEET_DESCENDANTS];

const BLOCKS = new Map(FLEET.map((f) => [f.meta.id, f.blocks]));

/** A row's status as the store would read it, for views drawn without one. */
export const fixtureStatus = (meta: SessionMeta): AgentStatus => agentStatus(meta, BLOCKS.get(meta.id));
