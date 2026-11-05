// The rail's look, for `bun run ui:preview src/renderer/src/chrome/Rail.fixtures.tsx#RailRealistic`
// (and #RailSketch, #RailWithWorking, #FirstRunRail, #SignedInRail; each takes `width`).
// Presentational rows only (RailRow, the headings, the foot's shapes) fed plain props: no stores,
// except RailRealistic, which names two hosts to the registry so the host glyphs draw.
import type { ReactNode } from "react";
import type { UsageMeter } from "@server/shared/usageMeter";
import { StatusMark } from "../components/ui/status";
import { registry, type Environment } from "../lib/connection";
import { cn } from "../lib/cn";
import type { WorkingRow } from "../lib/railWorking";
import type { GroupMark } from "../lib/sidebarRows";
import type { SessionMeta, ThreadType } from "../lib/tcserver/types";
import type { ThreadRow } from "../lib/workspaceSessions";
import { ChartBar, FolderPlus, Inbox, ListChecks, MessageSquare, MoreHorizontal, Pin, PinOff, Plus, Search, Server, Settings, StickyNote, Users } from "./icons";
import { RailHeading, RailRow } from "./RailRow";
import { RailWorkingView } from "./RailWorking";
import { SignInRowView } from "./SignInRow";
import { UpdateRow } from "./UpdateRow";
import { MeterRowView } from "./UsageMeter";
import { diffWords, WorkspaceMarkView } from "./WorkspaceRowMarks";
import { WorkspaceGlyphView } from "./WorkspaceGlyph";
import { tabGroupColor } from "../lib/tabGroups";

const noop = () => {};
/** The rail's height in a 900px window. */
const HEIGHT = 900;

/** A logo set in Customize, drawn as a data URL so the static render has it. */
const LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#2f6fde"/><path d="M4 11.5 8 4l4 7.5H9.6L8 8.4l-1.6 3.1z" fill="#fff"/></svg>',
  );

/** A workspace's glyph as WorkspaceGlyph resolves it: a logo, the repo
 *  host's mark, or the mascot (hashed from the name, else picked). */
type Look = { logo?: string; host?: "github" | "gitlab"; mascot?: string; color?: string };

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
  look = {},
}: {
  name: string;
  look?: Look;
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
      glyph={
        <WorkspaceGlyphView
          sources={look.logo ? [look.logo] : []}
          host={look.host}
          mascot={{ project: name, name: look.mascot ?? null, color: look.color ?? tabGroupColor(name) }}
        />
      }
      label={name}
      selected={selected}
      emphasis={unread}
      data-host-offline={offline || undefined}
      className={offline ? "@container/railrow opacity-50" : "@container/railrow"}
      trailingInteractive
      trailing={mark ? <WorkspaceMarkView mark={mark} /> : null}
      trailingYield={
        diff ? <span className="block pr-1 whitespace-nowrap @max-[15rem]/railrow:hidden">{diffWords(diff[0], diff[1])}</span> : null
      }
      hoverActions={[
        { label: pinned ? "Unpin workspace" : "Pin workspace", icon: pinned ? PinOff : Pin, onClick: noop },
        { label: "Workspace options", icon: MoreHorizontal, menu: true, onClick: noop },
      ]}
    />
  );
}

/** The navigation group, first in the list (`railTopRows`): no heading,
 *  Accounts and Stats in it on the desktop (`aliax`). */
function Navigation({
  inboxUnseen = false,
  chats,
  chatsSelected = false,
  aliax = true,
  page,
}: {
  inboxUnseen?: boolean;
  chats?: ReactNode;
  chatsSelected?: boolean;
  aliax?: boolean;
  page?: "accounts" | "stats";
}) {
  return (
    <div className="shrink-0 px-2">
      <RailRow icon={Search} label="Search" />
      <RailRow icon={Inbox} label="Inbox" emphasis={inboxUnseen} />
      <RailRow icon={ListChecks} label="Mark all read" />
      <RailRow icon={StickyNote} label="Notes" />
      <RailRow icon={MessageSquare} label="Chats" selected={chatsSelected} trailing={chats} />
      {aliax ? (
        <>
          <RailRow icon={Users} label="Accounts" selected={page === "accounts"} />
          <RailRow icon={ChartBar} label="Stats" selected={page === "stats"} />
        </>
      ) : null}
    </div>
  );
}

/** A heading and its workspace rows, 4px apart (ProjectSection). */
function Section({ label, add = false, children }: { label: string; add?: boolean; children: ReactNode }) {
  return (
    <div className="shrink-0 px-2 pt-4">
      <RailHeading action={add ? { label: "Add workspace", icon: Plus, onClick: noop } : undefined}>{label}</RailHeading>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

/** The hosts row's dots, as `toneOf` colours them. */
function HostsRow({ tones }: { tones: string[] }) {
  return (
    <RailRow
      icon={Server}
      label="Hosts"
      trailing={
        <span className="flex items-center gap-1">
          {tones.map((tone, i) => (
            <span key={i} className={cn("size-1.5 rounded-full", tone)} />
          ))}
        </span>
      }
    />
  );
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const pooled: UsageMeter = { share: 0.62, resetsAt: NOW + 130 * MIN, limited: null, withRoom: 3, windows: [] };
const limited: UsageMeter = { share: 0.34, resetsAt: NOW + 50 * MIN, limited: { until: NOW + 3 * MIN }, withRoom: 0, windows: [] };

/** The foot under its one hairline: Working (when it has rows), the rows
 *  16px under it, then the meters. */
function Foot({ working, rows, meters = true }: { working?: readonly WorkingRow[]; rows: ReactNode; meters?: boolean }) {
  return (
    <div className="flex shrink-0 flex-col border-t border-border">
      {working ? <RailWorkingView rows={working} now={NOW} activeSessionId="w2" projectOf={() => "temp-code"} /> : null}
      <div className="flex flex-col p-2">{rows}</div>
      {meters ? (
        <div role="group" aria-label="Usage" className="flex shrink-0 flex-col px-2 pb-2">
          <MeterRowView provider="claude" meter={pooled} now={NOW} />
          <MeterRowView provider="codex" meter={limited} now={NOW} />
        </div>
      ) : null}
    </div>
  );
}

function Rail({ width, children, foot }: { width: number; children: ReactNode; foot: ReactNode }) {
  return (
    <nav aria-label="Workspaces" className="flex flex-col border-r border-border bg-sidebar" style={{ width, height: HEIGHT }}>
      <div className="h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">{children}</div>
      {foot}
    </nav>
  );
}

const working = (
  id: string,
  title: string,
  state: WorkingRow["state"],
  extra: Partial<SessionMeta> & { minutes?: number; type?: ThreadType } = {},
): WorkingRow => {
  const { minutes = 0, type = "chat", ...meta } = extra;
  return {
    id,
    state,
    meta: {
      id,
      title,
      environmentId: "local",
      threadType: type,
      status: state === "working" ? "running" : state === "waiting" ? "waiting" : "idle",
      busySince: minutes ? NOW - minutes * MIN : null,
      ...meta,
    } as SessionMeta,
  };
};

const WORKING: WorkingRow[] = [
  working("w1", "Approve Bash on deploy", "waiting", { type: "implementation" }),
  working("w2", "Restore the cards", "working", { minutes: 2.2 }),
  working("w3", "Probe the gateway", "working", { minutes: 14, type: "research" }),
  working("w4", "Docs pass", "done"),
  working("w5", "Typecheck the rail", "working", { minutes: 31, type: "implementation" }),
  working("w6", "Fix login", "done", { type: "planning" }),
];

/** `width` is the rail's: 200 by default in the app, 180 to 360 by drag.
 *  `working` puts the Working section in the foot. */
export function RailSketch({ width = 260, working = false }: { width?: number; working?: boolean }) {
  return (
    <Rail
      width={width}
      foot={
        <Foot
          working={working ? WORKING : undefined}
          rows={
            <>
              <UpdateRow state={{ kind: "ready" }} onInstall={noop} onDismiss={noop} />
              <HostsRow tones={["bg-muted-foreground", "bg-warning"]} />
              <RailRow icon={Settings} label="Settings" />
            </>
          }
        />
      }
    >
      <Navigation inboxUnseen chats={<StatusMark state="working" word={false} />} page="stats" />
      <Section label="Pinned">
        <Workspace name="temp-code" look={{ logo: LOGO }} selected pinned diff={[12, 4]} mark={markOf("working", "Restore the cards")} />
      </Section>
      <Section label="Workspaces" add>
        <Workspace name="cosmic-prisons" look={{ host: "github" }} mark={markOf("working", "Typecheck the rail", 2)} />
        <Workspace name="aliax" mark={markOf("waiting", "Approve Bash on deploy")} />
        <Workspace name="landing-site" unread />
      </Section>
    </Rail>
  );
}

/** The rail with the Working section: four rows and "2 more". */
export function RailWithWorking({ width = 260 }: { width?: number }) {
  return <RailSketch width={width} working />;
}

const HOSTS: Environment[] = [
  { id: "local", name: "This Mac", routes: [], credentialRef: null },
  { id: "env_box", name: "box", routes: [], credentialRef: null },
];

/** A realistic day: two hosts with the box offline; a pinned workspace,
 *  selected, that needs you, with a diff; a linked workspace (one row); a
 *  paused, unread one; a working one on the offline box; a quiet one; Working
 *  with a master watching its batch, a waiting build, two working threads
 *  (one on the box) and two finished unseen; both meters, one limited. */
export function RailRealistic({ width = 200 }: { width?: number }) {
  // Two hosts, so the host glyphs draw on the Working rows (fixture only).
  registry.environmentsSnapshot = () => HOSTS;
  const rows: WorkingRow[] = [
    working("r1", "Approve Bash on deploy", "waiting", { type: "implementation" }),
    working("r2", "iOS batch 2", "working", { minutes: 48, type: "orchestration", status: "watching", isMaster: true }),
    working("r3", "Restore the cards", "working", { minutes: 2.2, type: "implementation" }),
    working("r4", "Probe the gateway", "working", { minutes: 14, type: "research", environmentId: "env_box" }),
    working("r5", "Docs pass", "done"),
    working("r6", "Plan the Duo shell", "done", { type: "planning" }),
  ];
  return (
    <Rail
      width={width}
      foot={
        <Foot
          working={rows}
          rows={
            <>
              <UpdateRow state={{ kind: "check", version: "v1.0.308" }} onCheck={noop} />
              <HostsRow tones={["bg-muted-foreground", "bg-muted-foreground/30"]} />
              <RailRow icon={Settings} label="Settings" />
            </>
          }
        />
      }
    >
      <Navigation inboxUnseen chats={<StatusMark state="working" word={false} />} />
      <Section label="Pinned">
        <Workspace name="temp-code" look={{ logo: LOGO }} selected pinned diff={[212, 48]} mark={markOf("waiting", "Approve Bash on deploy", 3)} />
      </Section>
      <Section label="Workspaces" add>
        <Workspace name="aliax" mark={markOf("working", "iOS batch 2")} />
        <Workspace name="cosmic-prisons" look={{ host: "github" }} unread mark={markOf("paused", "Retry the deploy")} />
        <Workspace name="landing-site" offline mark={markOf("working", "Probe the gateway")} />
        <Workspace name="notes-site" look={{ mascot: "ghost", color: "#e5a50a" }} />
      </Section>
    </Rail>
  );
}

/** A new install: the navigation group, the empty Workspaces list, and the
 *  foot led by the sign-in row until an account arrives (`signedIn`), with
 *  no meter yet. */
function FirstRun({ signedIn, pending = false, width = 260 }: { signedIn: boolean; pending?: boolean; width?: number }) {
  return (
    <Rail
      width={width}
      foot={
        <Foot
          meters={false}
          rows={
            <>
              {signedIn ? null : <SignInRowView provider="claude" pending={pending} onClick={noop} />}
              <UpdateRow state={{ kind: "check", version: "v1.0.307" }} onCheck={noop} />
              <RailRow icon={Settings} label="Settings" />
            </>
          }
        />
      }
    >
      <Navigation chatsSelected />
      <Section label="Workspaces">
        <RailRow icon={FolderPlus} label="Add workspace…" onClick={noop} />
      </Section>
    </Rail>
  );
}

export function FirstRunRail({ pending = false, width = 260 }: { pending?: boolean; width?: number }) {
  return <FirstRun signedIn={false} pending={pending} width={width} />;
}

export function SignedInRail({ width = 260 }: { width?: number }) {
  return <FirstRun signedIn width={width} />;
}
