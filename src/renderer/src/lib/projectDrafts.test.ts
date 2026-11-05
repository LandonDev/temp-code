// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_DRAFTS_CAP,
  PROJECT_DRAFTS_TTL_MS,
  draftKeyOf,
  planProjectDraft,
  projectDrafts,
  projectDraftsStore,
  sessionFromDraft,
  draftPicks,
  type DraftRecord,
} from "./projectDrafts";

const catalog = {
  projects: [
    { id: "p-mac", environmentId: "local", linkId: "pl_1" },
    { id: "p-box", environmentId: "env_box", linkId: "pl_1" },
    { id: "plain", environmentId: "local", linkId: null },
  ],
};

const base: DraftRecord = {
  id: "d1",
  environmentId: "local",
  projectId: "p-mac",
  workspaceId: "w1",
  cwd: "/work/alpha",
  harness: "claude",
  model: "claude-opus-5-5",
  modelSettings: {},
  runtimeMode: "approval-required" as DraftRecord["runtimeMode"],
  threadType: "chat",
  threadRules: null,
  segments: [{ text: "hello" }],
  attachments: [],
  seenAt: 0,
};

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
});

describe("draftKeyOf", () => {
  it("keys a linked project's copies by their link id", () => {
    expect(draftKeyOf({ projectId: "p-mac", environmentId: "local" }, catalog)).toBe("link:pl_1");
    expect(draftKeyOf({ projectId: "p-box", environmentId: "env_box" }, catalog)).toBe("link:pl_1");
  });
  it("keys a plain project by its id and a loose chat by its workspace", () => {
    expect(draftKeyOf({ projectId: "plain", environmentId: "local" }, catalog)).toBe("plain");
    expect(draftKeyOf({ projectId: null, environmentId: "local", workspaceId: "w1" }, catalog)).toBe("loose:w1");
    expect(draftKeyOf({ projectId: null, environmentId: "local", workspaceId: null }, catalog)).toBe("loose:");
  });
});

describe("projectDrafts", () => {
  it("round-trips through localStorage without bytes or preview URLs", () => {
    projectDrafts.put("link:pl_1", {
      ...base,
      attachments: [
        { id: "a", name: "a.png", mimeType: "image/png", kind: "image", size: 3, path: "/tmp/a.png", data: "AAA", previewUrl: "blob:x" },
      ],
    });
    projectDrafts.flush();
    const raw = localStorage.getItem("monocode.projectDrafts")!;
    expect(raw).not.toContain("AAA");
    expect(raw).not.toContain("blob:x");
    projectDrafts.reload();
    const back = projectDrafts.get("link:pl_1")!;
    expect(back.segments).toEqual([{ text: "hello" }]);
    expect(back.attachments).toEqual([{ id: "a", name: "a.png", mimeType: "image/png", kind: "image", size: 3, path: "/tmp/a.png" }]);
  });

  it("keeps a pasted attachment in the run and loses it after a reload", () => {
    const pasted = { id: "p", name: "paste.png", mimeType: "image/png", kind: "image" as const, size: 3, data: "BBB" };
    projectDrafts.put("plain", { ...base, attachments: [pasted] });
    expect(projectDrafts.get("plain")!.attachments).toEqual([pasted]);
    projectDrafts.flush();
    expect(localStorage.getItem("monocode.projectDrafts")).not.toContain("paste.png");
    projectDrafts.reload();
    expect(projectDrafts.get("plain")!.attachments).toEqual([]);
  });

  it("merges a patch into an existing record and refuses one with no id to start", () => {
    projectDrafts.put("plain", { segments: [{ text: "x" }] });
    expect(projectDrafts.get("plain")).toBeUndefined();
    projectDrafts.put("plain", base);
    projectDrafts.put("plain", { model: "gpt-6.1-sol", harness: "codex" });
    expect(projectDrafts.get("plain")).toMatchObject({ id: "d1", model: "gpt-6.1-sol", segments: [{ text: "hello" }] });
    expect(projectDrafts.keyOfDraft("d1")).toBe("plain");
    projectDrafts.clear("plain");
    expect(projectDrafts.get("plain")).toBeUndefined();
    expect(projectDrafts.keyOfDraft("d1")).toBeNull();
  });

  it("keeps the newest 64 keys and drops a key unseen for 30 days on load", () => {
    for (let i = 0; i < PROJECT_DRAFTS_CAP + 3; i++) projectDrafts.put(`k${i}`, { ...base, id: `d${i}` }, 1000 + i);
    const keys = Object.keys(projectDraftsStore.getState().records);
    expect(keys).toHaveLength(PROJECT_DRAFTS_CAP);
    expect(keys).not.toContain("k0");
    expect(keys).toContain(`k${PROJECT_DRAFTS_CAP + 2}`);

    localStorage.clear();
    projectDrafts.reload();
    projectDrafts.put("old", base, 0);
    projectDrafts.put("new", { ...base, id: "d2" }, PROJECT_DRAFTS_TTL_MS);
    projectDrafts.flush();
    projectDrafts.reload(PROJECT_DRAFTS_TTL_MS + 1);
    expect(projectDrafts.get("old")).toBeUndefined();
    expect(projectDrafts.get("new")).toBeDefined();
  });
});

describe("planProjectDraft", () => {
  const copies = [
    { id: "p-mac", environmentId: "local", workspaceId: "w1", cwd: "/work/alpha" },
    { id: "p-box", environmentId: "env_box", workspaceId: "wb", cwd: "/srv/agents/work/alpha" },
  ];
  const args = {
    inPane: () => false,
    hasMeta: () => false,
    copies,
    connected: () => true,
    primary: "local",
  };

  it("focuses the draft when a pane shows it", () => {
    expect(planProjectDraft({ ...args, record: base, inPane: (id) => id === "d1" })).toEqual({ kind: "focus", id: "d1", retype: null });
  });
  it("rebuilds a record in place when its host is connected", () => {
    expect(planProjectDraft({ ...args, record: { ...base, environmentId: "env_box", projectId: "p-box" } })).toEqual({
      kind: "rebuild",
      record: { ...base, environmentId: "env_box", projectId: "p-box" },
      place: null,
      retype: null,
    });
  });
  it("moves a record whose host is offline to a connected copy", () => {
    const record = { ...base, environmentId: "env_box", projectId: "p-box" };
    const plan = planProjectDraft({ ...args, record, connected: (env) => env === "local" });
    expect(plan).toEqual({
      kind: "rebuild",
      record,
      place: { environmentId: "local", projectId: "p-mac", workspaceId: "w1", cwd: "/work/alpha" },
      retype: null,
    });
  });
  it("seeds with no record, or when the record's id is now a thread", () => {
    expect(planProjectDraft({ ...args, record: undefined })).toEqual({ kind: "seed" });
    expect(planProjectDraft({ ...args, record: base, hasMeta: () => true })).toEqual({ kind: "seed" });
  });
  it("retypes the draft when New thread asks for another type, and only then", () => {
    const rules = { maxAgents: 3 } as never;
    expect(planProjectDraft({ ...args, record: base, threadType: "planning" })).toMatchObject({
      kind: "rebuild",
      retype: { threadType: "planning", threadRules: null },
    });
    expect(planProjectDraft({ ...args, record: base, threadType: "chat" })).toMatchObject({ retype: null });
    expect(
      planProjectDraft({ ...args, record: base, inPane: () => true, threadType: "chat", threadRules: rules }),
    ).toEqual({ kind: "focus", id: "d1", retype: { threadType: "chat", threadRules: rules } });
  });
  it("keeps a chat draft's Master thread pick both ways", () => {
    expect(sessionFromDraft({ ...base, master: true }, null, 5).draftMaster).toBe(true);
    expect(sessionFromDraft(base, null, 5)).not.toHaveProperty("draftMaster");
    const session = sessionFromDraft(base, null, 5);
    expect(draftPicks({ ...session, draftMaster: true }).master).toBe(true);
    expect(draftPicks(session).master).toBe(false);
  });
  it("keeps the record's text and picks in the rebuilt session", () => {
    const session = sessionFromDraft({ ...base, threadType: "planning" }, null, 5);
    expect(session).toMatchObject({ id: "d1", cwd: "/work/alpha", threadType: "planning", blocks: [], createdAt: 5 });
  });
});
