// @vitest-environment jsdom
// The rail's project card and the title bar's strip read one rule for a
// project linked across a Mac and a box: the card's roots are the strip's
// chips, before and after the card's Archive dormant, wherever the master's
// batch lives and whatever became of its master.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../lib/tcserver/store";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { buildHeaderModel } from "../lib/threadHeaderModel";
import { groupWorkspaceSessions } from "../lib/workspaceSessions";
import { resetMenus } from "./menuRows";

const { archive, hosts } = vi.hoisted(() => ({
  archive: vi.fn(async (_id: string, _archived: boolean) => {}),
  hosts: {
    environments: [
      { id: "env_mac", name: "Mac", platform: "darwin" },
      { id: "env_box", name: "box", platform: "linux" },
    ],
  },
}));
vi.mock("../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/commands")>()),
  archive,
}));
vi.mock("../lib/connection/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/connection/status")>()),
  useEnvironments: () => hosts.environments,
}));
vi.mock("./hostOffline", () => ({ useHostsOffline: () => false }));
vi.mock("./HostGlyph", () => ({
  HostGlyph: ({ environmentId }: { environmentId?: string }) => <span data-host-glyph={environmentId} />,
}));
vi.mock("../stores/workspaceActions", () => ({ workspaceActions: { dropThread: vi.fn() } }));

import { ThreadHeaderStrip, type ChipThread } from "./ThreadHeaderStrip";
import { ProjectCard } from "./WorkspaceSessions";

const workspaces = [
  { environmentId: "env_mac", id: "w-mac", name: "temp-code", path: "/Users/l/IdeaProjects/temp-code", linkId: "wl_1", createdAt: 1 },
  { environmentId: "env_box", id: "w-box", name: "temp-code", path: "/srv/agents/work/temp-code", linkId: "wl_1", createdAt: 2 },
] as unknown as WorkspaceMeta[];
const projects = [
  { environmentId: "env_mac", id: "p-mac", workspaceId: "w-mac", name: "Alpha", mode: "local", branch: "master", cwd: "/Users/l/IdeaProjects/temp-code", archived: false, linkId: "pl_1", createdAt: 1 },
  { environmentId: "env_box", id: "p-box", workspaceId: "w-box", name: "Alpha", mode: "local", branch: "master", cwd: "/srv/agents/work/temp-code", archived: false, linkId: "pl_1", createdAt: 2 },
] as unknown as ProjectMeta[];

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "env_mac",
    id,
    parentId: null,
    projectId: "p-mac",
    workspaceId: "w-mac",
    threadType: "chat",
    title: id,
    cwd: "/Users/l/IdeaProjects/temp-code",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

/** The user's batch: a master on the Mac and its two implementation
 *  threads there, one done and one idle after its turn, never opened. */
const batch = (master: Partial<SessionMeta> = {}) => [
  meta("Master", { isMaster: true, ...master }),
  meta("Muse Wonder", { threadType: "implementation", masterId: "Master", startedBy: "Master", status: "done", updatedAt: 300 }),
  meta("Muse Code", { threadType: "implementation", masterId: "Master", startedBy: "Master", updatedAt: 300 }),
];
const box = (id: string, extra: Partial<SessionMeta> = {}) =>
  meta(id, { environmentId: "env_box", projectId: "p-box", workspaceId: "w-box", cwd: "/srv/agents/work/temp-code", ...extra });

const scope = ["w-mac", "w-box"];

/** Both surfaces over one store: the card's group and the strip's model. */
function surfaces(metas: SessionMeta[], lastSeen: Record<string, number>) {
  const group = groupWorkspaceSessions(metas, projects, workspaces, scope, lastSeen).projects[0];
  const model = buildHeaderModel<ChipThread>({
    threads: metas,
    tabs: [],
    scope: { project: new Set(["p-mac", "p-box"]) },
    activeTabId: null,
    lastSeen,
    planReady: {},
  });
  return { group, model };
}

function mount(metas: SessionMeta[], lastSeen: Record<string, number>) {
  // The archive reads the store when the row is picked.
  for (const m of metas) sessionStore.injectPush({ push: "session", session: m }, m.environmentId);
  const { group, model } = surfaces(metas, lastSeen);
  const view = render(
    <>
      <ProjectCard
        group={group}
        selected
        hosts={"env_mac\nenv_box"}
        lastSeen={lastSeen}
        seenFloor={0}
        rows={{
          activeSessionId: undefined,
          onOpen: () => {},
          onRename: () => {},
          menu: { rowsFor: () => [], onPick: () => {}, onOpenChange: () => {} },
          renamingId: null,
          onStartRename: () => {},
          focusedTree: new Set<string>(),
        }}
        requested={20}
        onMore={() => {}}
        onSelect={() => {}}
        onNewChat={() => {}}
        onRename={() => {}}
        onSettings={() => {}}
        onPreamble={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
      />
      <ThreadHeaderStrip
        model={model}
        onSelect={() => {}}
        stripRef={() => {}}
        planReady={{}}
        renamingId={null}
        onStartRename={() => {}}
        onRename={() => {}}
        activeRef={() => {}}
      />
    </>,
  );
  return { group, model, view };
}

const ids = (list: readonly { id: string }[]) => list.map((t) => t.id).sort();
const chipTitles = () =>
  [...document.querySelectorAll<HTMLElement>("[data-chip-title]")].map((el) => el.getAttribute("data-text")).sort();
/** Each card line's own title: a thread line's, a master block's head. */
const lineTitles = () =>
  [...document.querySelectorAll<HTMLElement>("[data-card-line]")].map(
    (line) => line.querySelector(".flex-1.truncate")?.textContent ?? "",
  );

/** The agreement: the card's roots are the strip's chips, and every line the
 *  card draws is a chip the strip draws, on its own host. */
function expectAgreement(metas: SessionMeta[], lastSeen: Record<string, number>) {
  const { group, model, view } = mount(metas, lastSeen);
  expect(ids([...model.live, ...model.dormant])).toEqual(ids(group.threads));
  const chips = chipTitles();
  for (const title of lineTitles()) expect(chips).toContain(title);
  return { group, model, view };
}

async function archiveDormant(label: string) {
  resetMenus();
  act(() => {
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!);
  });
  const menu = await screen.findByRole("menu", { name: "Project actions" });
  await act(async () => {
    fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
  });
  // lib/archiveDormant.ts loads on the pick.
  await waitFor(() => expect(archive).toHaveBeenCalled());
}

const archivedBy = (metas: SessionMeta[]) => {
  const gone = new Set(archive.mock.calls.map(([id]) => id));
  return metas.map((m) => (gone.has(m.id) ? { ...m, archived: true } : m));
};

afterEach(() => {
  cleanup();
  archive.mockClear();
  sessionStore.reset();
});

describe("a project on two hosts: the card and the strip", () => {
  it("agree before and after Archive dormant, which takes a master's settled batch with it", async () => {
    const metas = [
      ...batch(),
      meta("Mac unread", { updatedAt: 200 }),
      box("Box settled"),
      box("Box working", { status: "running", busySince: 1 }),
    ];
    const lastSeen = { Master: 100, "Box settled": 100 };
    const before = expectAgreement(metas, lastSeen);
    // The batch lives inside its master on both: neither Muse thread is a root.
    expect(ids(before.group.threads)).toEqual(["Box settled", "Box working", "Mac unread", "Master"]);
    expect(chipTitles()).not.toContain("Muse Code");

    // The menu counts the roots, as it does a root's subagents.
    await archiveDormant("Archive 2 dormant threads");
    expect(archive.mock.calls.map(([id]) => id).sort()).toEqual(["Box settled", "Master", "Muse Code", "Muse Wonder"]);
    before.view.unmount();

    const after = archivedBy(metas);
    const { group } = expectAgreement(after, lastSeen);
    expect(ids(group.threads)).toEqual(["Box working", "Mac unread"]);
    expect(lineTitles()).not.toContain("Muse Code");
    expect(chipTitles()).not.toContain("Muse Wonder");
  });

  it("show a batch whose master is archived as roots on both, on the Mac's glyph, until they are archived in turn", async () => {
    // The state the user met: the master archived, its batch left behind.
    const metas = [...batch({ archived: true }), box("Box working", { status: "running", busySince: 1 })];
    const lastSeen = { "Muse Wonder": 300 };
    const before = expectAgreement(metas, lastSeen);
    expect(ids(before.group.threads)).toEqual(["Box working", "Muse Code", "Muse Wonder"]);
    // The unread one is a line on the card and a live chip in the strip.
    expect(lineTitles()).toContain("Muse Code");
    expect(before.model.live.map((c) => c.id)).toContain("Muse Code");
    expect(before.model.dormant.map((c) => c.id)).toEqual(["Muse Wonder"]);
    const chip = document.querySelector('[data-chip-title][data-text="Muse Code"]')!.closest('[role="tab"]')!;
    expect(chip.querySelector('[data-host-glyph="env_mac"]')).toBeTruthy();

    await archiveDormant("Archive 1 dormant thread");
    expect(archive.mock.calls.map(([id]) => id)).toEqual(["Muse Wonder"]);
    before.view.unmount();

    const { group } = expectAgreement(archivedBy(metas), lastSeen);
    expect(ids(group.threads)).toEqual(["Box working", "Muse Code"]);
  });

  it("leave a batch thread that still works as a root on both when its master is archived", async () => {
    const metas = [...batch(), meta("Builder", { threadType: "implementation", masterId: "Master", status: "running", busySince: 1 })];
    const lastSeen = { Master: 100 };
    const before = expectAgreement(metas, lastSeen);
    await archiveDormant("Archive 1 dormant thread");
    expect(archive.mock.calls.map(([id]) => id).sort()).toEqual(["Master", "Muse Code", "Muse Wonder"]);
    before.view.unmount();

    const { group, model } = expectAgreement(archivedBy(metas), lastSeen);
    expect(ids(group.threads)).toEqual(["Builder"]);
    expect(model.live.map((c) => c.id)).toEqual(["Builder"]);
    expect(lineTitles()).toEqual(["Builder"]);
  });
});
