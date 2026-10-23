// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { mountProbe } from "../test/renderProbe";
import { threadRow, type WorkspaceSessionGroups } from "../lib/workspaceSessions";
import type { ProjectMeta, SessionMeta } from "../lib/tcserver/types";
import { WorkspaceThreadsList, workspaceThreadSections } from "./WorkspaceThreadsPopover";

// Every mount leaves with its test: a row's clock (useClock) stays subscribed
// while it is mounted, and a tick after the environment is gone would reach React.
afterEach(cleanup);

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/wt/p1",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

const project = (id: string, over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  environmentId: "local",
  id,
  workspaceId: "w1",
  name: id,
  mode: "local",
  branch: null,
  cwd: "/wt/p1",
  archived: false,
  createdAt: 1,
  ...over,
});

describe("workspaceThreadSections", () => {
  it("drops a project with no live threads", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [
        { project: project("p1"), threads: [], latest: 0, archivedCount: 0 },
        {
          project: project("p2"),
          threads: [threadRow(meta("t1", { status: "running" }), {})],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const sections = workspaceThreadSections(groups);
    expect(sections.map((s) => s.key)).toEqual(["p2"]);
  });

  it("adds a trailing Chats section only when there are loose chats", () => {
    const empty: WorkspaceSessionGroups = { projects: [], archived: [], chats: [] };
    expect(workspaceThreadSections(empty)).toEqual([]);

    const withChats: WorkspaceSessionGroups = {
      projects: [],
      archived: [],
      chats: [threadRow(meta("t1"), {})],
    };
    const sections = workspaceThreadSections(withChats);
    expect(sections).toEqual([{ key: "chats", label: "Chats", threads: withChats.chats, roots: withChats.chats }]);
  });

  it("labels a project section with the project's name", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [threadRow(meta("t1", { status: "running" }), {})],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    expect(workspaceThreadSections(groups)).toEqual([
      { key: "p1", label: "Alpha", threads: groups.projects[0]!.threads, roots: groups.projects[0]!.threads },
    ]);
  });
});

describe("WorkspaceThreadsList", () => {
  it("renders a running thread under its project's label", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [threadRow(meta("t1", { title: "Fix the bug", status: "running" }), {})],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    expect(probe.container.textContent).toContain("Alpha");
    expect(probe.container.textContent).toContain("Fix the bug");
  });

  it("a failed thread's row prints the host's verdict under its title", () => {
    const failure = {
      kind: "account_unknown" as const,
      account: "work@example.com",
      summary: "Account work@example.com is no longer on file",
      cause: "The account was removed or cancelled.",
    };
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [
            threadRow(meta("t1", { title: "Ship it", status: "error", failure }), {}),
            threadRow(meta("t2", { title: "Older one", status: "error" }), {}),
          ],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    const text = probe.container.textContent ?? "";
    expect(text).toContain("Ship it");
    expect(text).toContain("Account work@example.com is no longer on file");
    // A row written before the verdict existed keeps the bare word.
    expect(text.match(/Failed/g)).toHaveLength(2);
  });

  it("renders a loose chat under Chats, not a project label", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [],
      archived: [],
      chats: [threadRow(meta("t1", { title: "One-off question", status: "running" }), {})],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    expect(probe.container.textContent).toContain("Chats");
    expect(probe.container.textContent).toContain("One-off question");
  });

  it("jumps to a thread when its row is clicked", () => {
    const onSelectThread = vi.fn();
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [threadRow(meta("t1", { title: "Fix the bug", status: "running" }), {})],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={onSelectThread}
      />,
    );
    const row = probe.container.querySelector("button[type=button]");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("shows a settled, unseen thread as done (unread), not silently", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [],
      archived: [],
      chats: [threadRow(meta("t1", { title: "Wrapped up", status: "done", updatedAt: 500 }), { t1: 50 })],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{ t1: 50 }}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    expect(probe.container.textContent).toContain("Wrapped up");
  });

  it("shows a waiting thread as its own row, not just a count (LiveLines drops it)", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [],
      archived: [],
      chats: [threadRow(meta("t1", { title: "Approve this diff", status: "waiting" }), {})],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    expect(probe.container.textContent).toContain("Approve this diff");
    expect(probe.container.textContent).toContain("Needs you");
  });

  it("a master prints its batch under it: a waiting batch thread once, inside the block, with the done tally", () => {
    const b = (id: string, extra: Parameters<typeof meta>[1]) =>
      threadRow(meta(id, { masterId: "m", ...extra }), {}, 0, true);
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [
            {
              ...threadRow(meta("m", { title: "Batch", isMaster: true, status: "watching" }), {}),
              batch: [
                b("w", { title: "Approve this diff", status: "waiting" }),
                b("d1", { title: "Finished one" }),
                b("q", { title: "Later", status: "queued" }),
              ],
            },
          ],
          latest: 100,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList groups={groups} activeSessionId={null} lastSeen={{}} seenFloor={0} onSelectThread={() => {}} />,
    );
    const text = probe.container.textContent ?? "";
    expect(text.split("Approve this diff").length - 1).toBe(1);
    expect(text).toContain("Needs you");
    expect(text).toContain("1/3");
    expect(text).toContain("1 queued");
    // A settled batch thread is the tally, not a line, and never unread.
    expect(text).not.toContain("Finished one");
  });

  it("shows a failed thread as its own row and jumps to it on click", () => {
    const onSelectThread = vi.fn();
    const groups: WorkspaceSessionGroups = {
      projects: [],
      archived: [],
      chats: [threadRow(meta("t1", { title: "Crashed mid-turn", status: "error" }), {})],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{}}
        seenFloor={0}
        onSelectThread={onSelectThread}
      />,
    );
    expect(probe.container.textContent).toContain("Crashed mid-turn");
    expect(probe.container.textContent).toContain("Failed");
    const row = probe.container.querySelector("button[type=button]");
    fireEvent.click(row!);
    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("skips a project whose threads are all dormant instead of an empty section", () => {
    const groups: WorkspaceSessionGroups = {
      projects: [
        {
          project: project("p1", { name: "Alpha" }),
          threads: [threadRow(meta("t1", { title: "Old and settled", status: "idle" }), { t1: 999 })],
          latest: 1,
          archivedCount: 0,
        },
      ],
      archived: [],
      chats: [],
    };
    const probe = mountProbe(
      <WorkspaceThreadsList
        groups={groups}
        activeSessionId={null}
        lastSeen={{ t1: 999 }}
        seenFloor={0}
        onSelectThread={() => {}}
      />,
    );
    expect(probe.container.textContent).not.toContain("Alpha");
    expect(probe.container.textContent).not.toContain("Old and settled");
  });
});
