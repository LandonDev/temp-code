// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { projectDrafts } from "./projectDrafts";
import { INTERRUPT_MESSAGE } from "./inFlight";
import {
  leaf,
  splitPane,
  newFileTab,
  newReleaseNotesWorkspaceTab,
  newTab,
  newTerminalFile,
} from "./layout";
import { createProjectTerminal } from "./projectTerminal";
import { newSession, type Session } from "./session";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  isPersistedStub,
  parseWorkspaceSnapshot,
} from "./workspaceSnapshot";

function chat(id: string, cwd: string): Session {
  const session = newSession("local", "cursor", cwd);
  session.id = id;
  session.blocks = [{ id: "u1", role: "user", text: "hello" }];
  session.providerSessionId = "p1";
  return session;
}

describe("collectWorkspaceSnapshot", () => {
  it("stores tabs, stubs, and the focused tab — not transcripts", () => {
    const session = chat("s1", "/tmp/a");
    session.blocks.push({ id: "a1", role: "assistant", text: "hi" });
    const file = newFileTab("/tmp/a/README.md", "/tmp/a");
    const tab = {
      ...newTab("s1"),
      id: "t1",
      editorPanes: [{ id: "e1", files: [file], activeFileId: file.id }],
    };
    const snapshot = collectWorkspaceSnapshot([tab], [session], "t1", "/tmp/a");
    expect(snapshot.activeTabId).toBe("t1");
    expect(snapshot.tabs[0]?.editorPanes[0]?.files[0]?.path).toBe(
      "/tmp/a/README.md",
    );
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        id: "s1",
        cwd: "/tmp/a",
        providerSessionId: "p1",
      }),
    ]);
    expect("blocks" in snapshot.sessions[0]!).toBe(false);
    expect(snapshot.projectTerminals).toEqual([]);
  });

  it("round-trips a release-note descriptor", () => {
    const tab = newReleaseNotesWorkspaceTab({ version: "0.1.22" });
    const snapshot = collectWorkspaceSnapshot([tab], [], tab.id, "~");
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map());

    expect(workspace?.tabs[0]?.editorPanes[0]?.files[0]?.releaseNotes).toEqual({
      version: "0.1.22",
    });
    expect(workspace?.sessions).toEqual([]);
  });

  it("stores the project terminal dock", () => {
    const term = newTerminalFile("/tmp/a", "zsh");
    const dock = createProjectTerminal("/tmp/a", term);
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("s1"), id: "t1" }],
      [],
      "t1",
      "/tmp/a",
      [dock],
    );
    expect(snapshot.projectTerminals).toEqual([
      expect.objectContaining({
        projectPath: "/tmp/a",
        open: true,
      }),
    ]);
    expect(snapshot.projectTerminals[0]?.pane.files[0]?.id).toBe(term.id);
  });
});

describe("parseWorkspaceSnapshot", () => {
  it("returns null for empty or invalid payloads", () => {
    expect(parseWorkspaceSnapshot(null)).toBeNull();
    expect(parseWorkspaceSnapshot({ tabs: [], activeTabId: "t1" })).toBeNull();
    expect(
      parseWorkspaceSnapshot({ tabs: [{}], activeTabId: "t1" }),
    ).toBeNull();
  });

  it("drops unknown fields and repairs a missing active tab", () => {
    const tab = { ...newTab("s1"), id: "t1" };
    const parsed = parseWorkspaceSnapshot({
      tabs: [{ ...tab, extra: true }],
      sessions: [
        {
          id: "s1",
          harness: "cursor",
          runtimeMode: "supervised",
          cwd: "/tmp/a",
        },
      ],
      activeTabId: "missing",
      projectCwd: "/tmp/a",
    });
    expect(parsed?.activeTabId).toBe("t1");
    expect(parsed?.tabs[0] && "extra" in parsed.tabs[0]).toBe(false);
  });

  it.each([
    { releaseNotes: { version: "" } },
    { releaseNotes: { version: 123 } },
    { releaseNotes: { version: "0.1.22" }, review: true },
    { releaseNotes: { version: "0.1.22" }, terminal: true },
  ])("rejects a tab whose release pane is invalid: %j", (descriptor) => {
    const valid = { ...newTab("session-a"), id: "valid-tab" };
    const invalidPaneId = "invalid-release-pane";
    const invalid = {
      kind: "session",
      id: "invalid-tab",
      layout: leaf(invalidPaneId),
      focusedId: invalidPaneId,
      editorPanes: [
        {
          id: invalidPaneId,
          activeFileId: "release-file",
          files: [
            {
              id: "release-file",
              path: "release-notes:0.1.22",
              cwd: "~",
              ...descriptor,
            },
          ],
        },
      ],
      terminalPanes: [],
    };

    const parsed = parseWorkspaceSnapshot({
      tabs: [valid, invalid],
      sessions: [],
      activeTabId: "invalid-tab",
      projectCwd: "~",
    });
    expect(parsed?.tabs.map((tab) => tab.id)).toEqual(["valid-tab"]);

    const workspace = parsed && hydrateWorkspaceSnapshot(parsed, new Map());
    expect(
      workspace?.sessions.some((session) => session.id === invalidPaneId),
    ).toBe(false);
  });
});

describe("hydrateWorkspaceSnapshot", () => {
  it("reopens splits, file panes, and stored transcripts", () => {
    const left = chat("s1", "/tmp/a");
    const right = chat("s2", "/tmp/a");
    const file = newFileTab("/tmp/a/src/lib.rs", "/tmp/a");
    const tab = {
      ...newTab("s1"),
      id: "t1",
      layout: {
        type: "split" as const,
        id: "split1",
        dir: "right" as const,
        children: [leaf("s1"), leaf("e1")],
        sizes: [0.5, 0.5],
      },
      focusedId: "e1",
      editorPanes: [{ id: "e1", files: [file], activeFileId: file.id }],
    };
    const snapshot = collectWorkspaceSnapshot(
      [tab],
      [left, right],
      "t1",
      "/tmp/a",
    );
    const loaded = new Map([
      [
        "s1",
        {
          ...left,
          blocks: [
            ...left.blocks,
            { id: "a1", role: "assistant" as const, text: "stored" },
          ],
        },
      ],
    ]);
    const workspace = hydrateWorkspaceSnapshot(snapshot, loaded);
    expect(workspace?.tabs).toHaveLength(1);
    expect(workspace?.tabs[0]?.layout).toEqual(tab.layout);
    expect(workspace?.tabs[0]?.editorPanes[0]?.files[0]?.path).toBe(
      "/tmp/a/src/lib.rs",
    );
    expect(
      workspace?.sessions.find((session) => session.id === "s1")?.blocks,
    ).toEqual(loaded.get("s1")?.blocks);
    expect(
      workspace?.sessions.find((session) => session.id === "s2")?.blocks,
    ).toEqual([]);
  });

  it("marks in-flight chats interrupted and adds a tab if they were parked", () => {
    const open = chat("s1", "/tmp/a");
    const parked = chat("s2", "/tmp/a");
    parked.busy = true;
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("s1"), id: "t1" }],
      [open, parked],
      "t1",
      "/tmp/a",
    );
    const workspace = hydrateWorkspaceSnapshot(
      snapshot,
      new Map([
        ["s1", open],
        ["s2", parked],
      ]),
      new Set(["s2"]),
    );
    expect(workspace?.tabs).toHaveLength(2);
    const resumed = workspace?.sessions.find((session) => session.id === "s2");
    expect(resumed?.busy).toBe(false);
    expect(
      resumed?.blocks.some((block) => block.text === INTERRUPT_MESSAGE),
    ).toBe(true);
  });

  it("restores one blank tab per project, the newest, and keeps the chat tabs", () => {
    const blank = (id: string): Session => ({ ...newSession("local", "claude", "/tmp/a"), id, title: "New chat" });
    const other = { ...blank("b1"), cwd: "/tmp/b" };
    const tabs = ["s1", "a1", "a2", "b1", "a3"].map((id) => ({ ...newTab(id), id: `t-${id}` }));
    const snapshot = collectWorkspaceSnapshot(
      tabs,
      [chat("s1", "/tmp/a"), blank("a1"), blank("a2"), other, blank("a3")],
      "t-s1",
      "/tmp/a",
    );
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map([["s1", chat("s1", "/tmp/a")]]));
    expect(workspace?.tabs.map((tab) => tab.id)).toEqual(["t-s1", "t-b1", "t-a3"]);
    expect(workspace?.activeTabId).toBe("t-s1");
  });

  it("keeps terminal-only tabs", () => {
    const term = newTerminalFile("/tmp/a");
    const tab = {
      kind: "session" as const,
      id: "t1",
      layout: leaf("p1"),
      focusedId: "p1",
      editorPanes: [],
      terminalPanes: [{ id: "p1", files: [term], activeFileId: term.id }],
    };
    const snapshot = collectWorkspaceSnapshot([tab], [], "t1", "/tmp/a");
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map());
    expect(workspace?.tabs[0]?.terminalPanes[0]?.files[0]?.terminal).toBe(true);
  });

  it("restores a project terminal dock", () => {
    const term = { ...newTerminalFile("/tmp/a"), foreground: "vite" };
    const dock = {
      ...createProjectTerminal("/tmp/a", term),
      size: 300,
      open: false,
    };
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("s1"), id: "t1" }],
      [],
      "t1",
      "/tmp/a",
      [dock],
    );
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map());
    expect(workspace?.projectTerminals).toEqual([
      expect.objectContaining({
        projectPath: "/tmp/a",
        size: 300,
        open: false,
      }),
    ]);
    expect(workspace?.projectTerminals?.[0]?.pane.files[0]?.terminal).toBe(
      true,
    );
    expect(
      workspace?.projectTerminals?.[0]?.pane.files[0]?.foreground,
    ).toBeUndefined();
  });
});

describe("a dock saved with a side", () => {
  it("still parses: a bottom dock keeps its height, another side's width becomes the default height", () => {
    const pane = (path: string) => {
      const term = newTerminalFile(path);
      return { id: `pane-${path}`, files: [term], activeFileId: term.id };
    };
    const parsed = parseWorkspaceSnapshot({
      tabs: [{ ...newTab("s1"), id: "t1" }],
      activeTabId: "t1",
      projectTerminals: [
        { projectPath: "/tmp/a", pane: pane("/tmp/a"), side: "bottom", size: 300, open: true },
        { projectPath: "/tmp/b", pane: pane("/tmp/b"), side: "right", size: 480, open: true },
      ],
    });
    expect(parsed?.projectTerminals?.map((dock) => dock.size)).toEqual([300, 220]);
    expect(parsed?.projectTerminals?.every((dock) => !("side" in dock))).toBe(true);
  });
});

describe("dev server console tabs from before the Dev servers pane", () => {
  it("drops them on load, and a dock that held only them", () => {
    const shell = newTerminalFile("/tmp/a");
    const devLog = (id: string) => ({ ...newTerminalFile("/tmp/a"), id, path: "web :3001", devLog: { environmentId: "env_box", resourceId: id } });
    const raw = (files: unknown[], activeFileId: string, projectPath: string) => ({
      projectPath,
      pane: { id: `pane-${projectPath}`, files, activeFileId },
      side: "bottom",
      size: 220,
      open: true,
    });
    const parsed = parseWorkspaceSnapshot({
      tabs: [{ ...newTab("s1"), id: "t1" }],
      activeTabId: "t1",
      projectTerminals: [raw([devLog("r1"), shell, devLog("r2")], "r1", "/tmp/a"), raw([devLog("r3")], "r3", "/tmp/b")],
    });
    expect(parsed?.projectTerminals.map((d) => d.projectPath)).toEqual(["/tmp/a"]);
    expect(parsed?.projectTerminals[0]?.pane.files.map((f) => f.id)).toEqual([shell.id]);
    expect(parsed?.projectTerminals[0]?.pane.activeFileId).toBe(shell.id);
  });
});

describe("the host of a saved pane", () => {
  it("keeps the host a pane was on through a save and a reopen", () => {
    const remote = chat("r1", "/srv/work");
    remote.environmentId = "env_box";
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("r1"), id: "t1" }],
      [remote, chat("s1", "/tmp/a")],
      "t1",
      "/tmp/a",
    );
    const parsed = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)));
    const workspace = parsed && hydrateWorkspaceSnapshot(parsed, new Map());
    const byId = new Map(workspace?.sessions.map((s) => [s.id, s]));
    expect(byId.get("r1")?.environmentId).toBe("env_box");
    expect(byId.get("s1")?.environmentId).toBe("local");
  });

  it("treats a stub saved before environments as this machine's", () => {
    const snapshot = collectWorkspaceSnapshot([{ ...newTab("s1"), id: "t1" }], [chat("s1", "/tmp/a")], "t1", "/tmp/a");
    const raw = JSON.parse(JSON.stringify(snapshot)) as { sessions: Record<string, unknown>[] };
    delete raw.sessions[0]!.environmentId;
    const parsed = parseWorkspaceSnapshot(raw);
    expect(hydrateWorkspaceSnapshot(parsed!, new Map())?.sessions[0]?.environmentId).toBe("local");
  });
});

describe("a saved thread versus an unsent draft", () => {
  it("stamps persisted from the store's word and keeps it through a save and a parse", () => {
    const thread = { ...chat("t", "/repo"), title: "Ship it" };
    const draft = { ...newSession("local", "claude", "/repo"), id: "d" };
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("t"), id: "t1" }, { ...newTab("d"), id: "t2" }],
      [thread, draft],
      "t1",
      "/repo",
      [],
      (id) => id === "t",
    );
    const parsed = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)))!;
    const byId = new Map(parsed.sessions.map((s) => [s.id, s]));
    expect(byId.get("t")?.persisted).toBe(true);
    expect(byId.get("d")?.persisted).toBe(false);
    expect(isPersistedStub(byId.get("t")!)).toBe(true);
    expect(isPersistedStub(byId.get("d")!)).toBe(false);
  });

  it("a stub saved before the stamp is a thread when it has a title of its own, a draft when it has none or a placeholder", () => {
    const base = { cwd: "/repo", harness: "claude" as const, model: "", modelSettings: {}, runtimeMode: "supervised" as const };
    expect(isPersistedStub({ ...base, id: "a", title: "Old build" })).toBe(true);
    expect(isPersistedStub({ ...base, id: "b", title: "  " })).toBe(false);
    // A placeholder title means no message ever went in: an unsent draft.
    expect(isPersistedStub({ ...base, id: "p", title: "claude" })).toBe(false);
    expect(isPersistedStub({ ...base, id: "n", title: "New chat" })).toBe(false);
    // The stamp wins over the title either way.
    expect(isPersistedStub({ ...base, id: "c", title: "Named draft", persisted: false })).toBe(false);
  });
});

describe("restoring unsent drafts", () => {
  beforeEach(() => {
    localStorage.clear();
    projectDrafts.reload();
  });

  const draft = (id: string, projectId: string, over: Partial<Session> = {}): Session => ({
    ...newSession("local", "claude", `/repo/${projectId}`, undefined, undefined, undefined, { projectId }),
    id,
    ...over,
  });
  const drafts = { keyOf: (s: Session) => s.projectId ?? "loose:" };

  it("keeps none of three draft tabs in two projects and a draft in a split, but the active one, and files their picks", () => {
    const thread = chat("t1", "/repo/p1");
    const d1 = draft("d1", "p1");
    const d2 = draft("d2", "p1");
    const d3 = draft("d3", "p2", { harness: "codex", model: "gpt-6.1-sol" });
    const dSplit = draft("d4", "p1");
    const split = {
      ...newTab("t1"),
      id: "tab-split",
      layout: splitPane(leaf("t1"), "t1", "right", "d4"),
      focusedId: "d4",
    };
    const tabs = [
      { ...newTab("d1"), id: "tab-d1" },
      { ...newTab("d2"), id: "tab-d2" },
      { ...newTab("d3"), id: "tab-d3" },
      split,
    ];
    const snapshot = collectWorkspaceSnapshot(tabs, [thread, d1, d2, d3, dSplit], "tab-d2", "/repo/p1");
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map([["t1", thread]]), undefined, drafts)!;

    expect(workspace.tabs.map((t) => t.id)).toEqual(["tab-d2", "tab-split"]);
    expect(workspace.tabs[1]!.layout).toEqual(leaf("t1"));
    expect(workspace.tabs[1]!.focusedId).toBe("t1");
    expect(workspace.sessions.map((s) => s.id).sort()).toEqual(["d2", "t1"]);
    // The first draft of each project files its picks; the active one is p1's draft.
    expect(projectDrafts.get("p2")).toMatchObject({ id: "d3", harness: "codex" });
    expect(projectDrafts.get("p1")?.id).toBe("d2");
    expect(workspace.activeTabId).toBe("tab-d2");
  });

  it("opens the active tab on the project's remembered draft, with its text", () => {
    projectDrafts.put("p1", {
      ...draft("remembered", "p1"),
      threadType: "chat",
      threadRules: null,
      segments: [{ text: "half a thought" }],
      attachments: [],
    });
    const stale = draft("stale", "p1");
    const snapshot = collectWorkspaceSnapshot([{ ...newTab("stale"), id: "tab" }], [stale], "tab", "/repo/p1");
    const workspace = hydrateWorkspaceSnapshot(snapshot, new Map(), undefined, drafts)!;
    expect(workspace.tabs[0]!.focusedId).toBe("remembered");
    expect(workspace.sessions.map((s) => s.id)).toEqual(["remembered"]);
    expect(projectDrafts.get("p1")!.segments).toEqual([{ text: "half a thought" }]);
  });

  it("leaves a persisted stub (a thread the host knew) and a titled one alone", () => {
    const known = draft("known", "p1", { title: "New chat" });
    const titled = draft("titled", "p2", { title: "Fix the login flow" });
    const snapshot = collectWorkspaceSnapshot(
      [{ ...newTab("known"), id: "a" }, { ...newTab("titled"), id: "b" }],
      [known, titled],
      "b",
      "/repo/p1",
    );
    snapshot.sessions[0] = { ...snapshot.sessions[0]!, persisted: true };
    const parsed = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)))!;
    expect(parsed.sessions[0]!.persisted).toBe(true);
    const workspace = hydrateWorkspaceSnapshot(parsed, new Map(), undefined, drafts)!;
    expect(workspace.tabs.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
