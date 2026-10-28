// The workspace column's project cards, for
// `bun run ui:preview src/renderer/src/chrome/WorkspaceSessions.fixtures.tsx#ProjectCards`.
// The presentational card fed plain props built by the same pure rules the column uses: no stores.
import { projectCardStatus } from "../lib/projectCardModel";
import { cardCounts, cardLines, projectCardAriaLabel } from "../lib/sidebarRows";
import type { SessionMeta } from "../lib/tcserver/types";
import { cardThreads, threadRow, type ThreadRow } from "../lib/workspaceSessions";
import { ProjectCardView } from "./WorkspaceSessions";

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
    <ProjectCardView
      name={name}
      branch={branch}
      mode={mode}
      latest={threads.length ? NOW - minutesAgo * 60_000 : 0}
      now={NOW}
      lines={cardLines(threads, status)}
      hidden={0}
      counts={cardCounts(status, archived)}
      ariaLabel={projectCardAriaLabel(name, status)}
      selected={selected}
      unread={status.unread.length > 0}
      onSelect={noop}
      menu={{ rows: () => [], onPick: noop }}
    />
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
      <Card name="Blocked" threads={[row("n1", { status: "waiting" }), row("f1", { status: "error" }), row("f2", { status: "error" }), row("d3")]} minutesAgo={8} />
      <Card name="Empty" branch={null} mode="local" threads={[]} />
    </div>
  );
}
