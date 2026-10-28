import type { BatchState, BoardDigest } from "@server/shared/contract-batch";
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { RowAgents } from "./agentSummary";
import { rowAgents } from "./agentSummary";
import { groupOf, GROUP_LABEL, GROUP_ORDER, type MasterGroupId } from "./useMasterModel";

/**
 * One batch as plain objects, for the board's static preview
 * (board.preview.tsx) and the dom test that keeps it honest: five rows in
 * the four sections, subagents under the first, and a foot whose shell
 * step is running. No store, no link.
 */

const at = new Date(2026, 9, 27, 12, 8).getTime();

const base = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    environmentId: "local",
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "implementation",
    planPath: null,
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    agentType: null,
    cwd: "/repo",
    archived: false,
    pinned: false,
    permission: "edits",
    context1m: true,
    masterId: "m",
    activity: null,
    failure: null,
    createdAt: 1,
    updatedAt: at,
    ...over,
  }) as SessionMeta;

export type FixtureRow = { meta: SessionMeta; digest: BoardDigest; agents: RowAgents | null; landed: boolean };

const todos = (inHand: number, total: number, names: string[]) =>
  names.slice(0, total).map((content, i) => ({ content, status: i < inHand ? "completed" : i === inHand ? "in_progress" : "pending" }) as const);

const agent = (id: string, status: SessionMeta["status"], over: Partial<SessionMeta>) =>
  base({ id, parentId: "home", masterId: null as unknown as string, status, threadType: null as unknown as SessionMeta["threadType"], agentType: "implementer", ...over });

export const FIXTURE_ROWS: FixtureRow[] = [
  {
    meta: base({ id: "home", title: "Home screen", status: "running", activity: "Running ios:test", createdAt: 1 }),
    digest: { todos: todos(2, 7, ["Read the brief", "Lay out the list", "Wire the rows to the store", "Empty state", "Swipe actions", "Tests", "Docs"]) },
    agents: rowAgents([
      agent("a1", "waiting", { title: "Run the tests", activity: "Bash", createdAt: 2 }),
      agent("a2", "running", { title: "Rail rows", activity: "Editing Rail.tsx", createdAt: 3 }),
      agent("a3", "idle", { title: "Read the store", createdAt: 1 }),
    ]),
    landed: false,
  },
  {
    meta: base({ id: "pricing", title: "Pricing survey", status: "waiting", threadType: "research", activity: "WebFetch", provider: "codex", model: "gpt-6.1-sol", context1m: false, createdAt: 2 }),
    digest: {},
    agents: null,
    landed: false,
  },
  { meta: base({ id: "tabs", title: "Tabs or spaces", status: "paused", threadType: "chat", reasoning: "medium", context1m: false, createdAt: 3 }), digest: {}, agents: null, landed: false },
  {
    meta: base({ id: "search", title: "Search plan", status: "queued", threadType: "planning", activity: "Queued · waiting for Home screen", createdAt: 4 }),
    digest: {},
    agents: null,
    landed: false,
  },
  {
    meta: base({ id: "foundations", title: "Design foundations", status: "idle", createdAt: 0 }),
    digest: { todos: todos(4, 4, ["Tokens", "Type scale", "Icons", "Docs"]) },
    agents: null,
    landed: true,
  },
];

/** The fixture's rows in their sections, in the board's order. */
export function fixtureGroups(rows: readonly FixtureRow[] = FIXTURE_ROWS): { id: MasterGroupId; label: string; rows: FixtureRow[] }[] {
  return GROUP_ORDER.map((id) => ({ id, label: GROUP_LABEL[id], rows: rows.filter((r) => groupOf(r.meta) === id) })).filter((g) => g.rows.length > 0);
}

const t = at - 5 * 60_000;

export const FIXTURE_BATCH: BatchState = {
  masterId: "m",
  rules: {
    land: "as-they-finish",
    then: "notify",
    summary: "Land, smoke test, gate",
    steps: [
      { id: "land", name: "Land", kind: "land" },
      { id: "smoke", name: "Smoke test", kind: "shell", run: "bun run smoke" },
      { id: "gate", name: "Gate", kind: "gate" },
    ],
  },
  steps: [
    { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 90_000, endedAt: t } as BatchState["steps"][number],
    {
      id: "smoke",
      status: "running",
      detail: "",
      at: 2,
      startedAt: t,
      log: [
        "$ bun run smoke",
        "booting a scratch instance",
        "instance up on :9231",
        "✓ opens the board",
        "✓ a row opens its thread",
        "✓ Back returns to the board",
        "✓ the foot follows the console",
        "checking the queued row",
      ],
    } as BatchState["steps"][number],
    { id: "gate", status: "pending", detail: "", at: null, log: [] } as unknown as BatchState["steps"][number],
  ],
  landed: ["foundations"],
  pending: ["home", "pricing", "tabs", "search"],
  held: [],
  blocked: null,
  finishedAt: null,
} as BatchState;
