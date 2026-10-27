// The rail's look, for `bun run ui:preview src/renderer/src/chrome/Rail.fixtures.tsx#RailSketch`.
// Presentational rows only (RailRow, the headings, the foot's shapes) fed plain props: no stores.
import { StatusMark } from "../components/ui/status";
import { ChartBar, Inbox, MessageSquare, MoreHorizontal, Plus, Search, Server, Settings, Users } from "./icons";
import { ProjectMascot } from "./ProjectMascot";
import { RailHeading, RailRow } from "./RailRow";
import { UpdateRow } from "./UpdateRow";
import { RailStatusChip, WorkspaceWorkingLine } from "./WorkspaceRowMarks";

const noop = () => {};

function Workspace({ name, color, busy = false, needsYou = false, selected = false }: { name: string; color: string; busy?: boolean; needsYou?: boolean; selected?: boolean }) {
  return (
    <>
      <RailRow
        glyph={<ProjectMascot project={name} color={needsYou ? "var(--color-warning)" : color} className="size-3" active={busy} />}
        label={name}
        selected={selected}
        trailingInteractive
        trailing={
          needsYou ? <RailStatusChip status={{ kind: "needsYou", count: 1 } as never} open={false} onToggle={noop} chipRef={{ current: null }} /> : null
        }
        hoverAction={{ label: "Workspace options", icon: MoreHorizontal, menu: true, onClick: noop }}
      />
      {busy ? <WorkspaceWorkingLine running={[{ id: "t1", title: "Typecheck the rail" } as never]} /> : null}
    </>
  );
}

export function RailSketch() {
  return (
    <nav aria-label="Workspaces" className="flex h-[720px] w-[260px] flex-col border-r border-border bg-sidebar">
      <div className="h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <div className="px-2">
          <RailRow icon={MessageSquare} label="Chats" trailing={<StatusMark state="working" word={false} />} />
        </div>
        <div className="px-2 pt-4">
          <RailHeading>Pinned</RailHeading>
          <Workspace name="temp-code" color="var(--chart-1)" selected />
        </div>
        <div className="px-2 pt-4">
          <RailHeading action={{ label: "Add workspace", icon: Plus, onClick: noop }}>Workspaces</RailHeading>
          <Workspace name="cosmic-prisons" color="var(--chart-2)" busy />
          <Workspace name="aliax" color="var(--chart-3)" needsYou />
          <Workspace name="landing-site" color="var(--chart-4)" />
        </div>
      </div>
      <div className="flex shrink-0 flex-col border-t border-border">
        <div className="flex flex-col p-2">
          <UpdateRow state={{ kind: "ready" }} onInstall={noop} onDismiss={noop} />
          <RailRow
            icon={Server}
            label="Hosts"
            trailing={
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-success" />
                <span className="size-1.5 rounded-full bg-warning" />
              </span>
            }
          />
          <RailRow icon={Inbox} label="Inbox" emphasis />
          <RailRow icon={Search} label="Search" />
          <RailRow icon={Users} label="Accounts" />
          <RailRow icon={ChartBar} label="Stats" selected />
          <RailRow icon={Settings} label="Settings" />
        </div>
      </div>
    </nav>
  );
}
