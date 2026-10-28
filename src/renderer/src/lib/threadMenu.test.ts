import { describe, expect, it } from "vitest";
import type { MenuRow } from "../chrome/menuRows";
import { threadMenuRows, type ThreadMenuFacts } from "./threadMenu";

const facts = (over: Partial<ThreadMenuFacts> = {}): ThreadMenuFacts => ({
  status: "idle",
  threadType: "chat",
  projectId: "p1",
  parentId: null,
  master: false,
  resources: 0,
  removable: 0,
  goal: null,
  moves: [],
  ...over,
});

const ids = (rows: MenuRow[]) => rows.map((r) => (r.kind === "item" || r.kind === "sub" ? r.id : "—"));
const row = (rows: MenuRow[], id: string) => rows.find((r) => (r.kind === "item" || r.kind === "sub") && r.id === id);

describe("threadMenuRows by status", () => {
  it("idle: Compact, no Pause or Stop", () => {
    expect(ids(threadMenuRows(facts()))).toEqual(["rename", "type", "—", "compact", "—", "resources", "master", "—", "archive", "delete"]);
  });

  it("working: Pause and Stop, no Compact", () => {
    const got = ids(threadMenuRows(facts({ status: "running" })));
    expect(got).toEqual(expect.arrayContaining(["pause", "stop"]));
    expect(got).not.toContain("compact");
    expect(ids(threadMenuRows(facts({ treeHasLiveWork: true })))).toContain("pause");
  });

  it("paused: Continue and Stop; a running root over a paused tree also continues", () => {
    const paused = threadMenuRows(facts({ status: "paused" }));
    expect(row(paused, "resume")).toMatchObject({ label: "Continue" });
    expect(ids(paused)).toContain("stop");
    const tree = ids(threadMenuRows(facts({ status: "running", treeHasPaused: true })));
    expect(tree).toContain("resume");
    expect(tree).not.toContain("pause");
  });

  it("stopped: Resume, nothing to stop", () => {
    const got = threadMenuRows(facts({ status: "stopped" }));
    expect(row(got, "resume")).toMatchObject({ label: "Resume" });
    expect(ids(got)).not.toContain("stop");
    expect(ids(got)).not.toContain("compact");
  });

  it("waiting: Stop, no Compact", () => {
    const got = ids(threadMenuRows(facts({ status: "waiting" })));
    expect(got).toContain("stop");
    expect(got).not.toContain("compact");
  });

  it("watching: Kill background tasks beside Stop, both destructive", () => {
    const got = threadMenuRows(facts({ status: "watching" }));
    expect(row(got, "killBackground")).toMatchObject({ danger: true });
    expect(row(got, "stop")).toMatchObject({ danger: true });
    expect(ids(threadMenuRows(facts({ status: "running" })))).not.toContain("killBackground");
  });

  it("queued: Remove from queue in Archive's place, no Compact", () => {
    const got = threadMenuRows(facts({ status: "queued" }));
    expect(row(got, "remove-queue")).toMatchObject({ label: "Remove from queue" });
    expect(ids(got)).not.toContain("archive");
    expect(ids(got)).not.toContain("compact");
  });
});

describe("threadMenuRows: Type", () => {
  it("lists every type with the thread's own checked, disabled while the thread is live", () => {
    const type = row(threadMenuRows(facts({ threadType: "planning" })), "type");
    if (type?.kind !== "sub") throw new Error("no Type submenu");
    expect(ids(type.items)).toEqual(["type:chat", "type:planning", "type:project-plan", "type:implementation", "type:orchestration", "type:research"]);
    expect(type.items.filter((i) => i.kind === "item" && i.checked).map((i) => i.kind === "item" && i.id)).toEqual(["type:planning"]);
    expect(type.disabled).toBe(false);
    for (const status of ["running", "waiting", "watching", "paused"] as const)
      expect(row(threadMenuRows(facts({ status })), "type")).toMatchObject({ disabled: true });
  });

  it("offers the options dialog for a tunable type only", () => {
    expect(row(threadMenuRows(facts({ threadType: "research" })), "tune")).toMatchObject({ label: "Research options…" });
    expect(ids(threadMenuRows(facts()))).not.toContain("tune");
  });
});

describe("threadMenuRows: Goal…", () => {
  it("is checked only while a goal runs, and absent with goal null", () => {
    expect(row(threadMenuRows(facts({ goal: true })), "goal")).toMatchObject({ label: "Goal…", checked: true });
    expect(row(threadMenuRows(facts({ goal: false })), "goal")).toMatchObject({ checked: false });
    expect(ids(threadMenuRows(facts({ goal: null })))).not.toContain("goal");
  });
});

describe("threadMenuRows: the master pin", () => {
  it("only on a root thread in a project, with the other word on a master", () => {
    expect(row(threadMenuRows(facts()), "master")).toMatchObject({ label: "Make master thread" });
    expect(row(threadMenuRows(facts({ master: true })), "master")).toMatchObject({ label: "Remove as master" });
    expect(ids(threadMenuRows(facts({ projectId: null })))).not.toContain("master");
    expect(ids(threadMenuRows(facts({ parentId: "root" })))).not.toContain("master");
    // A draft the host has never seen cannot be pinned yet: the row says why.
    expect(row(threadMenuRows(facts({ draft: true })), "master")).toMatchObject({
      label: "Make master thread",
      disabled: true,
      reason: "Send a message first",
    });
    expect(row(threadMenuRows(facts()), "master")).not.toHaveProperty("disabled");
  });
});

describe("threadMenuRows: resources, the bridge and the host moves", () => {
  it("counts resources and asks before archiving them", () => {
    expect(row(threadMenuRows(facts({ resources: 2, removable: 2 })), "resources")).toMatchObject({ hint: "2" });
    expect(row(threadMenuRows(facts({ resources: 2 })), "archive")).toMatchObject({ label: "Archive…" });
    expect(row(threadMenuRows(facts()), "archive")).toMatchObject({ label: "Archive" });
  });

  it("disables Resources… when there is nothing it could remove, a dev server alone included", () => {
    expect(row(threadMenuRows(facts()), "resources")).toMatchObject({ disabled: true });
    // A thread holding only a dev server: Archive still asks, Resources… has nothing to list.
    const onlyServer = threadMenuRows(facts({ resources: 1, removable: 0 }));
    expect(row(onlyServer, "resources")).toMatchObject({ disabled: true });
    expect(row(onlyServer, "resources")).not.toHaveProperty("hint");
    expect(row(onlyServer, "archive")).toMatchObject({ label: "Archive…" });
    expect(row(threadMenuRows(facts({ resources: 1, removable: 1 })), "resources")).not.toHaveProperty("disabled");
  });

  it("offers Dev server when a host can serve the project, checked while the pane is open", () => {
    expect(row(threadMenuRows(facts({ dev: { open: true } })), "dev")).toMatchObject({ label: "Dev server", checked: true });
    expect(row(threadMenuRows(facts({ dev: { open: false } })), "dev")).toMatchObject({ checked: false });
    expect(row(threadMenuRows(facts({ dev: null })), "dev")).toBeUndefined();
    expect(row(threadMenuRows(facts()), "dev")).toBeUndefined();
  });

  it("shows the Mac bridge on, offline and inherited", () => {
    const bridge = (b: ThreadMenuFacts["bridge"]) => row(threadMenuRows(facts({ bridge: b })), "mac-bridge");
    expect(ids(threadMenuRows(facts()))).not.toContain("mac-bridge");
    expect(bridge({ on: false, online: true, inherited: false, known: true })).toMatchObject({ label: "Mac bridge", checked: false, disabled: false });
    expect(bridge({ on: true, online: false, inherited: false, known: true })).toMatchObject({ label: "Mac bridge (offline)", checked: true });
    expect(bridge({ on: true, online: true, inherited: true, known: true })).toMatchObject({ disabled: true });
    expect(bridge({ on: false, online: false, inherited: false, known: false })).toMatchObject({ disabled: true });
    expect(ids(threadMenuRows(facts({ bridge: { on: true, online: true, inherited: false, known: true } })))).toContain("mac-bridge-rules");
    expect(ids(threadMenuRows(facts({ bridge: { on: false, online: true, inherited: false, known: true } })))).not.toContain("mac-bridge-rules");
  });

  it("puts the moves in their own group before Archive, a refused one disabled with its reason", () => {
    const moves: MenuRow[] = [{ kind: "item", id: "move:box", label: "Move to box…", disabled: true, reason: "The box is offline" }];
    const rows = threadMenuRows(facts({ moves }));
    const at = rows.findIndex((r) => r.kind === "item" && r.id === "move:box");
    expect(rows[at - 1]?.kind).toBe("sep");
    expect(rows[at + 1]?.kind).toBe("sep");
    expect(rows[at + 2]).toMatchObject({ id: "archive" });
    expect(rows[at]).toMatchObject({ disabled: true, reason: "The box is offline" });
  });
});

describe("threadMenuRows: what a surface adds", () => {
  it("Open, New pass… and Start now only when asked", () => {
    expect(ids(threadMenuRows(facts({ status: "queued" })))).not.toContain("start-now");
    expect(ids(threadMenuRows(facts()))).not.toContain("open");
    const board = ids(threadMenuRows(facts({ status: "queued" }), { open: true, newPass: true }));
    expect(board.slice(0, 4)).toEqual(["open", "new-pass", "start-now", "—"]);
    expect(ids(threadMenuRows(facts(), { open: true, newPass: true }))).not.toContain("start-now");
  });

  it("Open to the side only while another pane is focused", () => {
    expect(row(threadMenuRows(facts({ side: true })), "side")).toMatchObject({ label: "Open to the side" });
    expect(ids(threadMenuRows(facts()))).not.toContain("side");
  });

  it("Close tab after Open to the side when the thread has a tab, Close pane in a split, ⌘W only on the focused pane", () => {
    expect(ids(threadMenuRows(facts()))).not.toContain("close-tab");
    const lone = threadMenuRows(facts({ side: true, close: { split: false, shortcut: "⌘W" } }));
    expect(ids(lone).indexOf("close-tab")).toBe(ids(lone).indexOf("side") + 1);
    expect(row(lone, "close-tab")).toMatchObject({ label: "Close tab", shortcut: "⌘W" });
    expect(row(threadMenuRows(facts({ close: { split: true } })), "close-tab")).toMatchObject({ label: "Close pane" });
    expect(row(threadMenuRows(facts({ close: { split: true } })), "close-tab")).not.toHaveProperty("shortcut");
  });

  it("every row but the separators carries a glyph, and no row a shortcut but Close tab's ⌘W", () => {
    const rows = threadMenuRows(
      facts({ status: "watching", goal: false, side: true, threadType: "research", close: { split: false, shortcut: "⌘W" } }),
      { open: true, newPass: true },
    );
    for (const r of rows) {
      if (r.kind === "item" || r.kind === "sub") expect(r.icon, r.id).toBeTruthy();
      if (r.kind === "item" && r.id !== "close-tab") expect(r.shortcut, r.id).toBeUndefined();
    }
  });
});
