// The rail's and the workspace column's status marks, for
// `bun run ui:preview src/renderer/src/chrome/RailMarks.sketch.tsx#RailMarksSketch`.
// Presentational pieces only, fed plain props: no stores.
import type { SessionMeta } from "../lib/tcserver/types";
import { groupMark, type GroupMark } from "../lib/sidebarRows";
import { threadRow, type ThreadRow } from "../lib/workspaceSessions";
import { ProjectMascot } from "./ProjectMascot";
import { RailHeading, RailRow } from "./RailRow";
import { MoreHorizontal } from "./icons";
import { ProjectRowView, ThreadRowView } from "./WorkspaceSessions";
import { WorkspaceLineView, WorkspaceMarkView } from "./WorkspaceRowMarks";

const noop = () => {};

const row = (id: string, title: string, extra: Partial<SessionMeta> = {}, seen: Record<string, number> = { [id]: 1000 }): ThreadRow =>
  threadRow(
    {
      environmentId: "local",
      id,
      parentId: null,
      projectId: "p1",
      workspaceId: null,
      threadType: "chat",
      title,
      cwd: "/a",
      status: "idle",
      archived: false,
      pinned: false,
      busySince: null,
      createdAt: 1,
      updatedAt: 100,
      ...extra,
    } as SessionMeta,
    seen,
  );

const markOf = (rows: ThreadRow[]): GroupMark<ThreadRow> => groupMark(rows)!;

function Workspace({ name, color, mark, unread = false, selected = false }: { name: string; color: string; mark?: GroupMark<ThreadRow>; unread?: boolean; selected?: boolean }) {
  return (
    <>
      <RailRow
        glyph={<ProjectMascot project={name} color={color} />}
        label={name}
        selected={selected}
        emphasis={unread}
        trailingInteractive
        trailing={mark ? <WorkspaceMarkView mark={mark} /> : null}
        hoverAction={{ label: "Workspace options", icon: MoreHorizontal, menu: true, onClick: noop }}
      />
      {mark ? <WorkspaceLineView mark={mark} /> : null}
    </>
  );
}

const alpha = [
  row("a1", "Plan A2: rail marks", { status: "running", activity: "Running bun test" }),
  row("a2", "The global UI standard", { status: "waiting" }),
  row("a3", "Queue the stability build", { status: "queued" }),
  row("a4", "Retry the deploy", { status: "stopped" }),
  {
    ...row("m", "iOS batch 2", { status: "watching", isMaster: true }),
    batch: [
      row("b1", "Board rows", { status: "done", masterId: "m" }),
      row("b2", "Board foot", { status: "done", masterId: "m" }),
      row("b3", "Board steps", { status: "done", masterId: "m" }),
      row("b4", "Rules dialog", { status: "running", masterId: "m" }),
      row("b5", "Add sheet", { status: "running", masterId: "m" }),
      row("b6", "Archive", { status: "queued", masterId: "m" }),
      row("b7", "Proof", { status: "queued", masterId: "m" }),
    ],
  },
  row("a5", "Notes on the box", { status: "done", updatedAt: 500 }, { a5: 10 }),
  row("a6", "Old settled thread", { status: "done" }),
];

export function RailMarksSketch() {
  return (
    <div className="flex gap-6 bg-background p-4">
      <nav aria-label="Workspaces" className="flex w-[260px] flex-col bg-sidebar py-2">
        <div className="px-2">
          <RailHeading>Workspaces</RailHeading>
          <Workspace name="temp-code" color="var(--chart-1)" selected mark={markOf([row("t1", "Fix the login flow", { status: "running", updatedAt: 90 }), row("t2", "Typecheck", { status: "running" }), row("t3", "Bundle check", { status: "starting" })])} />
          <Workspace name="cosmic-prisons-with-a-long-name" color="var(--chart-2)" mark={markOf([row("c1", "Approve Bash on deploy", { status: "waiting" })])} />
          <Workspace name="aliax" color="var(--chart-3)" unread />
          <Workspace name="landing-site" color="var(--chart-4)" />
        </div>
      </nav>
      <div className="flex w-[300px] flex-col bg-sidebar px-2 py-2">
        <ProjectRowView name="Alpha" open mark={markOf(alpha)} unread menu={{ rows: () => [], onPick: noop }} />
        {alpha.map((t) => (
          <ThreadRowView key={t.id} row={t} selected={t.id === "a1"} />
        ))}
        <ThreadRowView row={row("b4", "Rules dialog", { status: "running", masterId: "m", activity: "Editing rulesEdit.ts", provider: "claude", model: "claude-opus-5-5" })} child />
        <ProjectRowView name="Beta" open={false} mark={markOf([row("p", "Paused work", { status: "paused" })])} menu={{ rows: () => [], onPick: noop }} />
        <ProjectRowView name="Gamma" open={false} mark={null} menu={{ rows: () => [], onPick: noop }} />
      </div>
    </div>
  );
}
