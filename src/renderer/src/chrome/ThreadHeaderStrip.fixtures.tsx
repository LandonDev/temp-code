// Fixtures for `bun run ui:preview src/renderer/src/chrome/ThreadHeaderStrip.tsx#ThreadHeaderStrip`.
import { registry } from "../lib/connection/registry";
import type { EnvironmentStatus } from "../lib/connection/types";
import { NewThreadChooser } from "./NewThreadChooser";
import type { ChipThread, StripChip } from "./ThreadHeaderStrip";
import { ThreadMenu } from "./ThreadMenu";

const now = Date.now();

// Two hosts for the two-row fixture: this Mac connected, the box dropped.
// The registry's status setter is private; a preview has no socket to open.
for (const [id, name] of [["local", "This Mac"], ["env_box", "The box"]] as const)
  registry.add({ id, name, routes: [], credentialRef: null });
const statuses = registry as unknown as { setStatus(id: string, status: EnvironmentStatus): void };
statuses.setStatus("local", { ...registry.statusOf("local"), transport: "open" });

function chip(id: string, title: string, over: Partial<StripChip> = {}, thread: Partial<ChipThread> = {}): StripChip {
  const status = over.status ?? "idle";
  return {
    id,
    tabId: `tab-${id}`,
    live: true,
    status,
    unread: false,
    updatedAt: now,
    ...over,
    thread: {
      id,
      title,
      status,
      updatedAt: now,
      projectId: "p1",
      parentId: null,
      archived: false,
      threadType: "chat",
      ...thread,
    },
  };
}

const end = (
  <ThreadMenu
    host={null}
    cost={1.24}
    rows={[]}
    onPick={() => {}}
    running={1}
    onPauseAll={() => Promise.resolve()}
    terminal={{ active: false }}
    recent={[]}
    onOpenRecent={() => {}}
    archived={[]}
    onRestore={() => {}}
    panel={{ open: false, onToggle: () => {} }}
  />
);

const common = {
  planReady: {},
  renamingId: null,
  stripRef: "fn",
  activeRef: "fn",
  onSelect: "fn",
  onStartRename: "fn",
  onRename: "fn",
  onContextMenu: "fn",
  end,
};

export default [
  {
    name: "A project: active, working, needs you, unread, master",
    props: {
      ...common,
      masterIds: new Set(["m"]),
      model: {
        activeId: "a",
        dormant: [],
        live: [
          chip("a", "Header strip"),
          chip("w", "Typecheck the renderer", { status: "running" }, { threadType: "implementation", activity: "typecheck" }),
          chip("n", "Approve the migration", { status: "waiting" }, { threadType: "planning" }),
          chip("u", "Search across hosts", { unread: true }, { threadType: "research" }),
          chip("m", "Release batch", { status: "watching" }, { threadType: "orchestration" }),
        ],
      },
      trailing: <NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />,
    },
  },
  {
    name: "Every state at rest: plan ready, paused, failed, queued, stopped, a paused tree",
    props: {
      ...common,
      planReady: { p: true },
      model: {
        activeId: "d",
        dormant: [],
        live: [
          chip("d", "Done and seen", { status: "done" }),
          chip("p", "Plan A19: master board", {}, { threadType: "planning" }),
          chip("z", "Pause the gate", { status: "paused" }),
          chip("f", "Fix the box deploy", { status: "error" }, { failure: { summary: "Usage cap" } }),
          chip("q", "Wait for the cap", { status: "queued" }, { activity: "Queued · 120 of 120 running" }),
          chip("s", "Old turn", { status: "stopped" }),
          chip("t", "Orchestrate A17", { status: "running" }, { threadType: "orchestration", treeHasPaused: true }),
        ],
      },
    },
  },
  {
    name: "Two rows: four live, five settled, the active chip on the shelf, the box offline",
    props: {
      ...common,
      model: {
        activeId: "s2",
        live: [
          chip("w", "Typecheck the renderer", { status: "running" }, { threadType: "implementation", activity: "typecheck", environmentId: "local" }),
          chip("n", "Approve the migration", { status: "waiting" }, { threadType: "planning", environmentId: "env_box" }),
          chip("u", "Search across hosts", { unread: true }, { threadType: "research", environmentId: "local" }),
          chip("m", "Release batch", { status: "watching" }, { threadType: "orchestration", environmentId: "local" }),
        ],
        dormant: [
          chip("s1", "Fix the context meter", { live: false }, { threadType: "implementation", environmentId: "local" }),
          chip("s2", "Header chips tell the truth", { live: false }, { environmentId: "local" }),
          chip("s3", "Box deploy notes", { live: false }, { environmentId: "env_box" }),
          chip("s4", "Plan the iPhone Duo shell", { live: false, status: "done" }, { threadType: "planning", environmentId: "local" }),
          chip("s5", "Why is the build slow on the box this week", { live: false }, { threadType: "research", environmentId: "env_box" }),
        ],
      },
      trailing: <NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />,
    },
  },
  {
    name: "An overflowing live row: both scroll arrows",
    props: {
      ...common,
      overflow: { left: true, right: true },
      onScrollBy: "fn",
      model: {
        activeId: "o3",
        dormant: [],
        live: Array.from({ length: 12 }, (_, i) =>
          chip(`o${i}`, `Thread number ${i + 1}`, i % 3 === 0 ? { status: "running" } : {}),
        ),
      },
      trailing: <NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />,
    },
  },
  {
    name: "An empty project",
    props: {
      ...common,
      model: { activeId: null, live: [], dormant: [] },
      trailing: <NewThreadChooser workspaceId={null} empty onStart={() => {}} />,
    },
  },
];
