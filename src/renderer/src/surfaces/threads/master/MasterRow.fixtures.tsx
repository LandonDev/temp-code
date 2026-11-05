// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/master/MasterRow.tsx#MasterRowView`.
// A row's subagent lines draw working as a dot: the row's own mark is the one
// that moves. Each row's model mark ends with its effort (low, high, xhigh), and
// a Cursor row, which has none, draws the model alone.
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
    reasoning: "high",
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

const agents = (lines: RowAgents["lines"]): RowAgents => ({ lines, more: 0, moreWaiting: 0, done: lines.length ? 1 : 0 });
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
  {
    name: "working on GPT-6.1 Sol at extra high",
    props: props(meta({ id: "c2", title: "Settings sheet", provider: "codex", model: "gpt-6.1-sol", reasoning: "xhigh", statusDetail: "Running the tests" }), agents([])),
  },
  {
    name: "working at low effort",
    props: props(meta({ id: "c3", title: "Copy pass", model: "claude-opus-5-5", reasoning: "low", statusDetail: "Reading Composer.tsx" }), agents([])),
  },
  {
    name: "a Cursor row: no effort",
    props: props(meta({ id: "c4", title: "Lint fixes", provider: "cursor", model: "composer-2.5", reasoning: undefined, statusDetail: "Editing eslint.config.js" }), agents([])),
  },
  {
    // Under Needs you the section says the word, so the detail stands alone
    // under the title and starts on its edge.
    name: "waiting on an approval",
    props: props(meta({ id: "c5", title: "Delete the old cache", status: "waiting", activity: "rm -rf build", busySince: null }), agents([])),
  },
];
