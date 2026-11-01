// The rail's look, for `bun run ui:preview src/renderer/src/chrome/Rail.fixtures.tsx#RailSketch`.
// Presentational rows only (RailRow, the headings, the foot's shapes) fed plain props: no stores.
import type { ReactNode } from "react";
import { StatusMark } from "../components/ui/status";
import { ChartBar, FolderPlus, Inbox, ListChecks, MessageSquare, MoreHorizontal, Plus, Search, Server, Settings, StickyNote, Users } from "./icons";
import { RAIL_YIELD, RailHeading, RailRow } from "./RailRow";
import { SignInRowView } from "./SignInRow";
import { UpdateRow } from "./UpdateRow";
import type { GroupMark } from "../lib/sidebarRows";
import type { ThreadRow } from "../lib/workspaceSessions";
import { diffWords, WorkspaceMarkView } from "./WorkspaceRowMarks";
import { cn } from "../lib/cn";
import { RailWorkingView } from "./RailWorking";
import { Pin, PinOff } from "./icons";
import type { WorkingRow } from "../lib/railWorking";
import type { SessionMeta } from "../lib/tcserver/types";

const noop = () => {};

const markOf = (state: GroupMark<ThreadRow>["state"], title: string, more = 0): GroupMark<ThreadRow> => ({
  state,
  about: { id: title, title } as ThreadRow,
  others: Array.from({ length: more }, (_, i) => ({ id: `o${i}`, title: `Other ${i + 1}` }) as ThreadRow),
  more,
});

function Workspace({
  name,
  mark,
  unread = false,
  selected = false,
  pinned = false,
  offline = false,
  diff,
}: {
  name: string;
  mark?: GroupMark<ThreadRow>;
  unread?: boolean;
  selected?: boolean;
  pinned?: boolean;
  /** Its host is offline: the row dims whole. */
  offline?: boolean;
  /** The selected row's uncommitted +/−. */
  diff?: [number, number];
}) {
  return (
    <RailRow
      surface="group"
      label={name}
      selected={selected}
      emphasis={unread}
      data-host-offline={offline || undefined}
      className={offline ? "@container/railrow opacity-50" : "@container/railrow"}
      trailingInteractive
      trailing={
        diff || mark ? (
          <>
            {diff ? (
              <span data-rail-yield="" className={cn("pr-1 whitespace-nowrap @max-[15rem]/railrow:hidden", RAIL_YIELD.className)}>
                {diffWords(diff[0], diff[1])}
              </span>
            ) : null}
            {mark ? <WorkspaceMarkView mark={mark} /> : null}
          </>
        ) : null
      }
      hoverActions={[
        { label: pinned ? "Unpin workspace" : "Pin workspace", icon: pinned ? PinOff : Pin, onClick: noop },
        { label: "Workspace options", icon: MoreHorizontal, menu: true, onClick: noop },
      ]}
    />
  );
}

/** The navigation group, first in the list (`railTopRows`). */
function Navigation({ inboxUnseen = false, chats, chatsSelected = false }: { inboxUnseen?: boolean; chats?: ReactNode; chatsSelected?: boolean }) {
  return (
    <div className="px-2">
      <RailRow icon={Search} label="Search" />
      <RailRow icon={Inbox} label="Inbox" emphasis={inboxUnseen} />
      <RailRow icon={ListChecks} label="Mark all read" />
      <RailRow icon={StickyNote} label="Notes" />
      <RailRow icon={MessageSquare} label="Chats" selected={chatsSelected} trailing={chats} />
    </div>
  );
}

/** The Accounts group (`railAccountRows`), desktop only. */
function AccountsGroup({ selected }: { selected?: "accounts" | "stats" }) {
  return (
    <div className="px-2 pt-4">
      <RailHeading>Accounts</RailHeading>
      <RailRow icon={Users} label="Accounts" selected={selected === "accounts"} />
      <RailRow icon={ChartBar} label="Stats" selected={selected === "stats"} />
    </div>
  );
}

/** `width` is the rail's: 200 by default in the app, 180 to 360 by drag.
 *  `working` stands the Working section between the list and the foot. */
export function RailSketch({ width = 260, working = false }: { width?: number; working?: boolean }) {
  return (
    <nav aria-label="Workspaces" className="flex h-[720px] flex-col border-r border-border bg-sidebar" style={{ width }}>
      <div className="h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <Navigation inboxUnseen chats={<StatusMark state="working" word={false} />} />
        <AccountsGroup selected="stats" />
        <div className="px-2 pt-4">
          <RailHeading>Pinned</RailHeading>
          <Workspace name="temp-code" selected pinned diff={[12, 4]} mark={markOf("working", "Restore the cards")} />
        </div>
        <div className="px-2 pt-4">
          <RailHeading action={{ label: "Add workspace", icon: Plus, onClick: noop }}>Workspaces</RailHeading>
          <Workspace name="cosmic-prisons" mark={markOf("working", "Typecheck the rail", 2)} />
          <Workspace name="aliax" mark={markOf("waiting", "Approve Bash on deploy")} />
          <Workspace name="landing-site" unread />
        </div>
      </div>
      {working ? <RailWorkingView rows={WORKING} now={NOW} projectOf={() => "temp-code"} /> : null}
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
          <RailRow icon={Settings} label="Settings" />
        </div>
      </div>
    </nav>
  );
}

const NOW = Date.now();

const working = (id: string, title: string, state: WorkingRow["state"], minutes = 0): WorkingRow => ({
  id,
  state,
  meta: { id, title, environmentId: "local", status: state === "working" ? "running" : state === "waiting" ? "waiting" : "idle", busySince: minutes ? NOW - minutes * 60_000 : null } as SessionMeta,
});

const WORKING: WorkingRow[] = [
  working("w1", "Approve Bash on deploy", "waiting"),
  working("w2", "Restore the cards", "working", 2.2),
  working("w3", "Probe the gateway", "working", 14),
  working("w4", "Docs pass", "done"),
  working("w5", "Typecheck the rail", "working", 31),
  working("w6", "Fix login", "done"),
];

/** The rail with the Working section: four rows and "2 more". */
export function RailWithWorking({ width = 260 }: { width?: number }) {
  return <RailSketch width={width} working />;
}

/** A new install: the navigation and Accounts groups, the empty Workspaces
 *  list, and the foot led by the sign-in row until an account arrives
 *  (`signedIn`), with no meter yet. */
function FirstRun({ signedIn, pending = false, width = 260 }: { signedIn: boolean; pending?: boolean; width?: number }) {
  return (
    <nav aria-label="Workspaces" className="flex h-[720px] flex-col border-r border-border bg-sidebar" style={{ width }}>
      <div className="h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <Navigation chatsSelected />
        <AccountsGroup />
        <div className="px-2 pt-4">
          <RailHeading>Workspaces</RailHeading>
          <RailRow icon={FolderPlus} label="Add workspace…" onClick={noop} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col border-t border-border">
        <div className="flex flex-col p-2">
          {signedIn ? null : <SignInRowView provider="claude" pending={pending} onClick={noop} />}
          <UpdateRow state={{ kind: "check", version: "v1.0.307" }} onCheck={noop} />
          <RailRow icon={Settings} label="Settings" />
        </div>
      </div>
    </nav>
  );
}

export function FirstRunRail({ pending = false, width = 260 }: { pending?: boolean; width?: number }) {
  return <FirstRun signedIn={false} pending={pending} width={width} />;
}

export function SignedInRail({ width = 260 }: { width?: number }) {
  return <FirstRun signedIn width={width} />;
}
