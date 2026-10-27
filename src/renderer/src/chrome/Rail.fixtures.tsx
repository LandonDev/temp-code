// The rail's look, for `bun run ui:preview src/renderer/src/chrome/Rail.fixtures.tsx#RailSketch`.
// Presentational rows only (RailRow, the headings, the foot's shapes) fed plain props: no stores.
import { StatusMark } from "../components/ui/status";
import { ChartBar, FolderPlus, Inbox, MessageSquare, MoreHorizontal, Plus, Search, Server, Settings, Users } from "./icons";
import { ProjectMascot } from "./ProjectMascot";
import { RailHeading, RailRow } from "./RailRow";
import { SignInRowView } from "./SignInRow";
import { UpdateRow } from "./UpdateRow";
import type { GroupMark } from "../lib/sidebarRows";
import type { ThreadRow } from "../lib/workspaceSessions";
import { WorkspaceLineView, WorkspaceMarkView } from "./WorkspaceRowMarks";

const noop = () => {};

const markOf = (state: GroupMark<ThreadRow>["state"], title: string, more = 0): GroupMark<ThreadRow> => ({
  state,
  about: { id: title, title } as ThreadRow,
  others: Array.from({ length: more }, (_, i) => ({ id: `o${i}`, title: `Other ${i + 1}` }) as ThreadRow),
  more,
});

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
          <Workspace name="cosmic-prisons" color="var(--chart-2)" mark={markOf("working", "Typecheck the rail", 2)} />
          <Workspace name="aliax" color="var(--chart-3)" mark={markOf("waiting", "Approve Bash on deploy")} />
          <Workspace name="landing-site" color="var(--chart-4)" unread />
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

/** A new install: Chats, the empty Workspaces list, and the foot led by the
 *  sign-in row until an account arrives (`signedIn`), with no meter yet. */
function FirstRun({ signedIn, pending = false }: { signedIn: boolean; pending?: boolean }) {
  return (
    <nav aria-label="Workspaces" className="flex h-[720px] w-[260px] flex-col border-r border-border bg-sidebar">
      <div className="h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <div className="px-2">
          <RailRow icon={MessageSquare} label="Chats" selected />
        </div>
        <div className="px-2 pt-4">
          <RailHeading>Workspaces</RailHeading>
          <RailRow icon={FolderPlus} label="Add workspace…" onClick={noop} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col border-t border-border">
        <div className="flex flex-col p-2">
          {signedIn ? null : <SignInRowView provider="claude" pending={pending} onClick={noop} />}
          <RailRow icon={Inbox} label="Inbox" />
          <RailRow icon={Search} label="Search" />
          <RailRow icon={Users} label="Accounts" />
          <RailRow icon={ChartBar} label="Stats" />
          <RailRow icon={Settings} label="Settings" />
        </div>
      </div>
    </nav>
  );
}

export function FirstRunRail({ pending = false }: { pending?: boolean }) {
  return <FirstRun signedIn={false} pending={pending} />;
}

export function SignedInRail() {
  return <FirstRun signedIn />;
}
