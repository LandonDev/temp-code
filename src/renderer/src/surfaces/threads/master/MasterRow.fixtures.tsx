// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/master/MasterRow.tsx#MasterRowView`.
// A row's subagent lines draw working as a dot: the row's own mark is the one that moves.
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { RowAgents } from "./agentSummary";

const now = Date.now();
const noop = () => {};
const menu = { rowsFor: () => [], onPick: noop, onOpenChange: noop };

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    id: "c1",
    environmentId: "local",
    parentId: null,
    projectId: "p",
    workspaceId: null,
    threadType: "implementation",
    provider: "claude",
    model: "claude-opus-5-5",
    title: "Home screen",
    cwd: "/wt/p",
    status: "running",
    archived: false,
    pinned: false,
    busySince: now - 4 * 60_000,
    createdAt: now - 10 * 60_000,
    updatedAt: now,
    ...over,
  }) as SessionMeta;

const agents = (lines: RowAgents["lines"]): RowAgents => ({ lines, more: 0, moreWaiting: 0, done: 1 });
const line = (id: string, title: string, state: RowAgents["lines"][number]["state"], detail: string) => ({
  id,
  environmentId: "local",
  title,
  state,
  detail,
  agentType: "implementer" as SessionMeta["agentType"],
  threadType: "chat" as SessionMeta["threadType"],
});

const props = (m: SessionMeta, a: RowAgents) => ({
  meta: m,
  digest: {},
  agents: a,
  landed: false,
  host: null,
  hostGlyph: () => null,
  onOpen: noop,
  menu,
});

export default [
  {
    // The row spins; its working subagent's line is a dot beside the word.
    name: "working, a working subagent",
    props: props(
      meta({ statusDetail: "Editing Rail.tsx" }),
      agents([line("a1", "Rail rows", "working", "Editing Rail.tsx"), line("a2", "Copy review", "waiting", "Approve Bash")]),
    ),
  },
  {
    // The row watches its subagent: a ring and Watching, nothing turns.
    name: "watching, a working subagent",
    props: props(meta({ status: "watching", statusDetail: "Rail rows", busySince: null }), agents([line("a1", "Rail rows", "working", "Editing Rail.tsx")])),
  },
];
