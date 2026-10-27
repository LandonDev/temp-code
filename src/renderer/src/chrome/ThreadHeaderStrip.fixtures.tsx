// Fixtures for `bun run ui:preview src/renderer/src/chrome/ThreadHeaderStrip.tsx#ThreadHeaderStrip`.
import { NewThreadChooser } from "./NewThreadChooser";
import type { ChipThread, StripChip } from "./ThreadHeaderStrip";
import { ThreadMenu } from "./ThreadMenu";

const now = Date.now();

function chip(id: string, title: string, over: Partial<StripChip> = {}, thread: Partial<ChipThread> = {}): StripChip {
  const status = over.status ?? "idle";
  return {
    id,
    tabId: `tab-${id}`,
    live: true,
    status,
    unread: false,
    tone: null,
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
    dev={{ shown: false, open: false, onToggle: () => {} }}
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
      // trailing: the chooser joins once it renders statically
    },
  },
  {
    name: "An empty project",
    props: {
      ...common,
      model: { activeId: null, live: [], dormant: [] },
      // trailing (empty)
    },
  },
];
