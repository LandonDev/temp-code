import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyStore } from "../lib/historyStore";
import { newTab } from "../lib/layout";
import { newDefaultSession } from "../lib/session";
import type { SessionSummary } from "../lib/sessionStore";
import { sessionStore } from "../lib/tcserver/store";
import { bootstrapWorkspace, newBootSeed, planBoot } from "./bootstrap";
import { projectStore } from "./project";
import { workspaceTabsStore } from "./workspace";
import { shellStore } from "./shell";

const seed = newBootSeed("/seed");

function transferOf(cwd: string) {
  const session = newDefaultSession(cwd);
  const tab = newTab(session.id);
  return {
    sessions: [session],
    tabs: [tab],
    activeTabId: tab.id,
    projectCwd: cwd,
    dirtyFileIds: ["/x/a.ts"],
  };
}

function resumedOf(cwd: string) {
  const session = newDefaultSession(cwd);
  const tab = newTab(session.id);
  return { sessions: [session], tabs: [tab], activeTabId: tab.id, projectCwd: cwd };
}

const row = (id: string): SessionSummary =>
  ({ id, title: id, cwd: "/a", updatedAt: 1 }) as unknown as SessionSummary;

describe("planBoot", () => {
  it("a window transfer outranks a resume", () => {
    const transfer = transferOf("/moved");
    const plan = planBoot(
      { windowTransfer: transfer, resumed: resumedOf("/old"), history: [], historyCwd: null },
      seed,
      [],
    );
    expect(plan.projectCwd).toBe("/moved");
    expect(plan.sessions).toBe(transfer.sessions);
    expect(plan.tabs).toBe(transfer.tabs);
    expect(plan.activeTabId).toBe(transfer.activeTabId);
    expect(plan.composerFocused).toBe(true);
    expect(plan.dirtyFileIds).toEqual(["/x/a.ts"]);
  });

  it("a resume outranks the seed, and focuses the composer on a chat it knows", () => {
    const resumed = resumedOf("/old");
    const plan = planBoot(
      { windowTransfer: null, resumed, history: [], historyCwd: "/old/" },
      seed,
      [],
    );
    expect(plan.projectCwd).toBe("/old");
    expect(plan.sessions).toBe(resumed.sessions);
    expect(plan.tabs).toBe(resumed.tabs);
    expect(plan.composerFocused).toBe(true);
    expect(plan.dirtyFileIds).toEqual([]);
    expect([...plan.loadedProjects]).toEqual(["/old"]);
    const orphan = { ...resumed, sessions: [] };
    expect(
      planBoot({ windowTransfer: null, resumed: orphan, history: [], historyCwd: null }, seed, [])
        .composerFocused,
    ).toBe(false);
  });

  it("nothing to restore means the seed's blank chat", () => {
    const plan = planBoot(
      { windowTransfer: null, resumed: null, history: [], historyCwd: null },
      seed,
      [],
    );
    expect(plan.projectCwd).toBe("/seed");
    expect(plan.sessions).toEqual([seed.session]);
    expect(plan.tabs).toEqual([seed.tab]);
    expect(plan.activeTabId).toBe(seed.tab.id);
    expect(plan.composerFocused).toBe(false);
    expect(plan.loadedProjects.size).toBe(0);
  });
});

describe("bootstrapWorkspace", () => {
  beforeEach(() => {
    sessionStore.reset();
    historyStore.set([]);
    shellStore.setState({ updateNotice: null });
  });
  afterEach(() => {
    sessionStore.reset();
    historyStore.set([]);
  });

  it("fills empty stores and notes the installed update", () => {
    const transfer = transferOf("/moved");
    const update = { version: "1.2.3" };
    const boot = bootstrapWorkspace({
      windowTransfer: transfer,
      resumed: null,
      history: [row("h1")],
      historyCwd: "/moved",
      installedUpdate: update,
    });
    expect(boot.tabs).toBe(transfer.tabs);
    expect(sessionStore.getSnapshot()).toEqual(transfer.sessions);
    expect(historyStore.get()).toEqual([row("h1")]);
    expect(shellStore.getState().updateNotice).toBe(update);
    expect(projectStore.getState().projectCwd).toBe("/moved");
    expect(projectStore.getState().recents).toBe(boot.recents);
    expect(workspaceTabsStore.getState().tabs).toBe(boot.tabs);
    expect(workspaceTabsStore.getState().activeTabId).toBe(boot.activeTabId);
    expect(workspaceTabsStore.getState().visits.current).toBe(boot.activeTabId);
  });

  it("leaves stores alone that already hold something", () => {
    const held = [newDefaultSession("/held")];
    sessionStore.mutate(held);
    historyStore.set([row("kept")]);
    bootstrapWorkspace({
      windowTransfer: null,
      resumed: resumedOf("/new"),
      history: [row("h2")],
      historyCwd: null,
      installedUpdate: null,
    });
    expect(sessionStore.getSnapshot()).toEqual(held);
    expect(historyStore.get()).toEqual([row("kept")]);
  });

  it("a resumed project leads the recents", () => {
    const boot = bootstrapWorkspace({
      windowTransfer: null,
      resumed: resumedOf("/resumed/repo"),
      history: [],
      historyCwd: null,
      installedUpdate: null,
    });
    expect(boot.recents[0]?.path).toBe("/resumed/repo");
  });

  it("with nothing to restore, the store gets one blank chat", () => {
    const boot = bootstrapWorkspace({
      windowTransfer: null,
      resumed: null,
      history: [],
      historyCwd: null,
      installedUpdate: null,
    });
    const sessions = sessionStore.getSnapshot();
    expect(sessions).toHaveLength(1);
    expect(boot.tabs).toHaveLength(1);
    expect(boot.tabs[0]!.focusedId).toBe(sessions[0]!.id);
    expect(boot.activeTabId).toBe(boot.tabs[0]!.id);
  });
});
