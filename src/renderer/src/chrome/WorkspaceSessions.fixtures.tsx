// The workspace column's project cards, and the whole column (cards, then the
// Chats and Archived folds), for
// `bun run ui:preview src/renderer/src/chrome/WorkspaceSessions.fixtures.tsx#ProjectCards`
// and `…#Column`.
// The presentational card fed plain props built by the same pure rules the column uses: no stores.
import { projectCardStatus } from "../lib/projectCardModel";
import { cardLines, projectCardAriaLabel, projectCardCounts } from "../lib/sidebarRows";
import type { SessionMeta } from "../lib/tcserver/types";
import { cardThreads, threadRow, type ThreadRow } from "../lib/workspaceSessions";
import { Button } from "../components/ui/button";
import { Plus } from "./icons";
import { CardNowContext, ProjectCardView, SectionHeading, ThreadRowView } from "./WorkspaceSessions";

const NOW = Date.now();
const noop = () => {};

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    projectId: "p",
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/wt/p",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: NOW - 60 * 60_000,
    ...extra,
  }) as SessionMeta;

/** Seen up to an hour ago: older threads are dormant, newer settled ones unread. */
const SEEN = NOW - 30 * 60_000;
const row = (id: string, extra: Partial<SessionMeta> = {}, housed = false) => threadRow(meta(id, extra), {}, SEEN, housed);

function Card({
  name,
  branch = `tc/${name.toLowerCase().replace(/\W+/g, "-")}`,
  mode = "worktree",
  threads,
  archived = 0,
  minutesAgo = 3,
  selected = false,
}: {
  name: string;
  branch?: string | null;
  mode?: "worktree" | "local";
  threads: ThreadRow[];
  archived?: number;
  minutesAgo?: number;
  selected?: boolean;
}) {
  const status = projectCardStatus(cardThreads(threads), null, {}, SEEN);
  return (
    <CardNowContext.Provider value={NOW}>
      <ProjectCardView
        name={name}
        branch={branch}
        mode={mode}
        latest={threads.length ? NOW - minutesAgo * 60_000 : 0}
        lines={cardLines(threads, status)}
        hidden={0}
        counts={projectCardCounts(threads, null, {}, SEEN, archived)}
        ariaLabel={projectCardAriaLabel(name, status)}
        selected={selected}
        onSelect={noop}
        menu={{ rows: () => [], onPick: noop }}
      />
    </CardNowContext.Provider>
  );
}

const minutes = (n: number) => NOW - n * 60_000;

/** `width` is the workspace column's. */
export function ProjectCards({ width = 260 }: { width?: number }) {
  const master: ThreadRow = {
    ...row("m", { title: "Release train", status: "watching", isMaster: true, updatedAt: minutes(1) }),
    batch: [
      row("b1", { title: "Card view", masterId: "m", threadType: "implementation", status: "running", busySince: minutes(4), tasks: { done: 2, total: 5, current: "fixtures" } as SessionMeta["tasks"] }, true),
      row("b2", { title: "Docs pass", masterId: "m", threadType: "chat", status: "waiting" }, true),
      row("b3", { title: "Done one", masterId: "m", status: "done" }, true),
      row("b4", { title: "Queued one", masterId: "m", status: "queued" }, true),
    ],
  };
  // A watching master whose batch only waits: nothing in the block moves.
  const waitingMaster: ThreadRow = {
    ...row("m2", { title: "Docs train", status: "watching", isMaster: true, updatedAt: minutes(2) }),
    batch: [
      row("c1", { title: "Copy review", masterId: "m2", status: "waiting" }, true),
      row("c2", { title: "Queued two", masterId: "m2", status: "queued" }, true),
    ],
  };
  return (
    <div className="flex flex-col gap-1 bg-sidebar px-2 py-2" style={{ width }}>
      <Card name="Quiet" threads={[row("q1"), row("q2")]} minutesAgo={90} />
      <Card
        name="Alpha"
        selected
        threads={[
          row("w1", {
            title: "Restore the cards",
            threadType: "implementation",
            status: "running",
            busySince: minutes(2.2),
            tasks: { done: 3, total: 7, current: "card fixtures" } as SessionMeta["tasks"],
          }),
          row("w2", { title: "Probe the gateway", threadType: "research", status: "running", busySince: minutes(12) }),
          row("d1"),
          row("d2"),
        ]}
        archived={2}
      />
      <Card name="Paused work" threads={[row("p1", { title: "Docs pass", status: "paused", frozenActiveElapsed: 6 * 60_000 })]} />
      <Card name="Unread" mode="local" branch="main" threads={[row("u1", { title: "Fix login", status: "done", updatedAt: minutes(5) })]} minutesAgo={5} />
      <Card name="Batch" threads={[master]} minutesAgo={1} />
      <Card name="Batch waiting" threads={[waitingMaster]} minutesAgo={2} />
      <Card name="Blocked" threads={[row("n1", { status: "waiting" }), row("f1", { status: "error" }), row("f2", { status: "error" }), row("d3")]} minutesAgo={8} />
      <Card name="Empty" branch={null} mode="local" threads={[]} />
    </div>
  );
}

/** The column as the sidebar draws it: the 40px header, three cards (one
 *  selected, one with an unread line), the Chats fold 16px under them with
 *  four rows of mixed types and states, and the Archived heading. */
export function Column({ width = 260 }: { width?: number }) {
  const chats = [
    row("c1", { title: "Why is the build slow?", threadType: "research", status: "running", busySince: minutes(3) }),
    row("c2", { title: "Tabs or spaces", status: "waiting" }),
    row("c3", { title: "Rename the gateway", threadType: "planning", status: "done", updatedAt: minutes(4) }),
    row("c4", { title: "Notes on the release", status: "idle" }),
  ];
  return (
    <div className="flex flex-col bg-sidebar" style={{ width }}>
      <div className="box-content flex h-10 shrink-0 items-center gap-0.5 border-b border-border pr-1.5 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">temp-code</h2>
        <Button variant="ghost" size="icon-sm" aria-label="New thread" className="text-muted-foreground hover:text-foreground">
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-col gap-1 px-2 pt-2 pb-2">
        <Card name="Quiet" threads={[row("q1"), row("q2")]} minutesAgo={90} />
        <Card
          name="Alpha"
          selected
          threads={[
            row("w1", {
              title: "Restore the cards",
              threadType: "implementation",
              status: "running",
              busySince: minutes(2.2),
              tasks: { done: 3, total: 7, current: "card fixtures" } as SessionMeta["tasks"],
            }),
            row("w2", { title: "Probe the gateway", threadType: "research", status: "running", busySince: minutes(12) }),
          ]}
          archived={2}
        />
        <Card name="Unread" mode="local" branch="main" threads={[row("u1", { title: "Fix login", status: "done", updatedAt: minutes(5) })]} minutesAgo={5} />
        <div className="pt-3">
          <SectionHeading label="Chats" open onToggle={noop} />
          <div className="flex flex-col">
            {chats.map((r) => (
              <ThreadRowView key={r.id} row={r} selected={r.id === "c2"} onOpen={noop} />
            ))}
          </div>
        </div>
        <div className="pt-3">
          <SectionHeading label="Archived" open={false} onToggle={noop} />
        </div>
      </div>
    </div>
  );
}
