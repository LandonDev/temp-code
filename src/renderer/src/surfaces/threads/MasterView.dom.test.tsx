// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BATCH_RULES, type BatchState, type BoardDigest } from "@server/shared/contract-batch";
import type { AgentEvent, EventRow } from "@server/shared/events";
import type { Session } from "../../lib/session";
import type { Link } from "../../lib/tcserver/store";
import type { SessionMeta, ServerPush } from "../../lib/tcserver/types";

/**
 * The master view on a fixture batch: the sections, the rows' two lines
 * and per-type bodies, a plan and its build as one row, a child's full
 * view with Back, the title bar's menus (archive through `batch.archive`,
 * adopt through `batch.adopt`), the rules foot from `batch.get` and
 * `batch.setRules` with the master's step list, and the add sheet's
 * `session.create`. Then the batch across hosts: a second fake link, "The
 * box", offline then linked, whose rows carry the host's dot and name,
 * open on their host, count in the menus, and are archived through that
 * host's own `session.batch`; the add sheet's host row and the adopt
 * sheet's host names. The session store is real, fed through the fake
 * links; the board is one `batch.board` answer (the rows' digests) and the
 * `board` and `batch` pushes, never a row's transcript, context or notes.
 * The list is virtualized: the scroller is given a height, a fleet of 300
 * mounts only its window, and one child's meta re-renders its row alone.
 * The chat, the child's transcript and the heavy pickers are stand-ins.
 */

const { startThread, batch, link, boxLink, hosts, catalog, rowReads } = vi.hoisted(() => {
  class FakeLink implements Link {
    constructor(public environmentId: string) {}
    profile = "local" as const;
    connected = true;
    metas: Omit<SessionMeta, "environmentId">[] = [];
    rows = new Map<string, EventRow[]>();
    notes = new Map<string, string>();
    digests = new Map<string, unknown>();
    boardChildren: unknown[] = [];
    calls: { method: string; params: unknown }[] = [];
    private pushListeners = new Set<(push: ServerPush) => void>();
    request<T>(method: string, params?: unknown): Promise<T> {
      this.calls.push({ method, params });
      const p = (params ?? {}) as { sessionId?: string };
      if (method === "session.list") return Promise.resolve(this.metas as T);
      if (method === "session.events") return Promise.resolve((this.rows.get(p.sessionId ?? "") ?? []) as T);
      if (method === "session.notes.get") return Promise.resolve({ text: this.notes.get(p.sessionId ?? "") ?? "", updatedAt: null, path: null } as T);
      if (method === "batch.get") return Promise.resolve(batch as T);
      if (method === "batch.board") return Promise.resolve({ children: this.boardChildren, digests: Object.fromEntries(this.digests), state: batch } as T);
      if (method === "batch.setRules") return Promise.resolve({ ...batch, rules: (params as { rules: unknown }).rules } as T);
      if (method === "batch.archive") return Promise.resolve({ attempted: [], succeeded: [], failed: [] } as T);
      if (method === "batch.adopt") {
        const ids = (params as { sessionIds: string[] }).sessionIds;
        return Promise.resolve({ adopted: ids.filter((id) => !id.includes(":")), refused: ids.filter((id) => id.includes(":")).map((id) => ({ sessionId: id, why: "unknown thread" })), state: batch } as T);
      }
      if (method === "resources.listAll") return Promise.resolve({ resources: [] } as T);
      return Promise.resolve(null as T);
    }
    onPush(l: (push: ServerPush) => void): () => void {
      this.pushListeners.add(l);
      return () => this.pushListeners.delete(l);
    }
    onOpen(): () => void {
      return () => {};
    }
    onClose(): () => void {
      return () => {};
    }
    push(push: ServerPush): void {
      for (const l of this.pushListeners) l(push);
    }
  }
  return {
  rowReads: [] as (string | null | undefined)[],
  startThread: vi.fn(async () => ({ id: "new" })),
  link: new FakeLink("local"),
  boxLink: new FakeLink("box"),
  hosts: { environments: [{ id: "local", name: "This Mac" }], statuses: new Map<string, { transport: string; fresh: boolean }>() },
  catalog: { workspaces: [] as unknown[], projects: [] as unknown[] },
  batch: {
    masterId: "m",
    rules: {
      land: "as-they-finish",
      steps: [
        { id: "land", name: "Merging", kind: "land" },
        { id: "gate", name: "Gate", kind: "gate" },
        { id: "release", name: "Release", kind: "release" },
      ],
      then: "notify",
    },
    steps: [
      { id: "land", status: "passed", detail: "ios/foundations, ios/contract", at: 1, startedAt: 1_000_000, endedAt: 1_120_000 },
      { id: "gate", status: "running", detail: "", at: 2, startedAt: 1_120_000, progress: { done: 3, total: 7, label: "vitest" }, log: ["✓ typecheck 12s", "vitest: 3 of 7 files"] },
      { id: "release", status: "pending", detail: "", at: null, log: [] },
    ] as unknown as BatchState["steps"],
    landed: ["c-done"],
    pending: ["c-wait", "c-run", "c-queued"],
    held: [],
    blocked: null,
    finishedAt: null,
  } as BatchState,
  };
});



vi.mock("../../lib/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/connection")>()),
  registry: {
    link: (id: string) => (id === "box" ? boxLink : link),
    linkOf: (id: string) => (id === "box" ? boxLink : link),
    primaryEnvironmentId: "local",
    primary: () => link,
    onLink: (listener: (link: unknown, event: string) => void) => {
      listener(link, "added");
      return () => {};
    },
  },
}));
// Every row reads its own meta through useSessionMeta: counting the reads by
// id counts the rows' renders.
vi.mock("../../lib/tcserver/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tcserver/store")>();
  return {
    ...actual,
    useSessionMeta: (id: string | null | undefined) => {
      rowReads.push(id);
      return actual.useSessionMeta(id);
    },
  };
});
vi.mock("../../lib/connection/status", () => ({
  useEnvironments: () => hosts.environments,
  useEnvironmentStatuses: () => hosts.statuses,
}));
vi.mock("../../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/workspaces")>()),
  useWorkspaces: () => catalog.workspaces,
  useProjects: () => catalog.projects,
}));
vi.mock("../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/commands")>()),
  startThread: (...args: unknown[]) => startThread(...(args as [])),
}));
vi.mock("../../chrome/ModelPicker", () => ({ ModelPicker: () => <span data-model-picker /> }));
// The composer a tab has (threadChat.tsx), as a field that hands its text
// to the thread the way the real one does: the intent from busy, the
// session it was mounted for, the caret when it is focused.
vi.mock("../../chrome/Composer", () => ({
  Composer: ({
    sessionId,
    busy,
    focused,
    onSubmit,
  }: {
    sessionId?: string;
    busy?: boolean;
    focused: boolean;
    onSubmit: (text: string, attachments: unknown[], intent: string) => void;
  }) => (
    <form
      data-composer-box
      data-composer-session={sessionId}
      onSubmit={(e) => {
        e.preventDefault();
        const field = e.currentTarget.querySelector("textarea")!;
        onSubmit(field.value, [], busy ? "steer" : "send");
        field.value = "";
      }}
    >
      <textarea data-composer-input aria-label="Message" autoFocus={focused} />
    </form>
  ),
}));
vi.mock("../../chrome/AppshotFlyIn", () => ({ AppshotFlyIn: () => null }));
vi.mock("../../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ text: null, degraded: false, name: "" }), ConnectionLine: () => null }));
vi.mock("../../chrome/SessionReview", () => ({ SessionReview: () => null }));
vi.mock("../AgentTranscript", () => ({
  AgentTranscript: ({ sessionId }: { sessionId: string }) => <div data-transcript={sessionId} />,
}));
vi.mock("./ThreadView", () => ({
  ThreadView: ({ session, renderChat }: { session: Session; renderChat: () => React.ReactNode }) => (
    <div data-child-view={session.id} data-child-type={session.threadType ?? ""}>
      {renderChat()}
    </div>
  ),
}));
vi.mock("./SplitShell", () => ({
  ChatToggle: () => null,
  SplitShell: ({ board, chat, title, detail, actions }: { board: React.ReactNode; chat: React.ReactNode; title?: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <div data-board>
        {title !== undefined ? (
          <div data-view-header>
            <span data-view-title>{title}</span>
            {detail ? <span data-view-detail>{detail}</span> : null}
            {actions}
          </div>
        ) : null}
        {board}
      </div>
      <div data-chat>{chat}</div>
    </div>
  ),
}));

import * as commands from "../../lib/tcserver/commands";
import { sessionStore } from "../../lib/tcserver/store";
import { resetNotesStore } from "../../lib/threadNotes";
import { SessionActionsContext, type SessionActions } from "../threadChat";
import { MasterView } from "./MasterView";
import { BoardPreview } from "./master/board.preview";

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    environmentId: "local",
    parentId: null,
    projectId: "p1",
    workspaceId: null,
    threadType: "implementation",
    planPath: null,
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    agentType: "implementer",
    cwd: "/repo/.claude/worktrees/x",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: true,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    masterId: "m",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as SessionMeta;

const master = {
  id: "m",
  environmentId: "local",
  title: "iOS batch 2",
  cwd: "/repo",
  projectId: "p1",
  workspaceId: null,
  status: "idle",
  blocks: [],
} as unknown as Session;

const props = {
  session: master,
  renderChat: () => <div data-testid="chat">chat</div>,
  composing: false,
  onArmNewPass: () => {},
  onOpenFile: () => {},
  onOpenDiff: () => {},
  onOpenSession: vi.fn(),
};

/** App's handlers as the panes get them: a send or a steer on the thread's own link. */
const sent: { id: string; text: string; intent?: string }[] = [];
const actions = {
  onSubmit: (id: string, text: string, _attachments: unknown[], options?: { intent?: string }) => {
    sent.push({ id, text, intent: options?.intent });
    const session = sessionStore.get(id)!;
    void (options?.intent === "steer" ? commands.steer(session, text) : commands.send(session, text)).catch(() => undefined);
  },
  onStop: () => {},
  onApproval: () => {},
  onCwdChange: () => {},
  onBranchChange: () => {},
  onModelChange: () => {},
  onModelSettingsChange: () => {},
  onRuntimeModeChange: () => {},
  onThreadTypeChange: () => {},
  onNewTerminal: () => {},
} as unknown as SessionActions;

const renderView = () =>
  render(
    <SessionActionsContext.Provider value={actions}>
      <MasterView {...props} />
    </SessionActionsContext.Provider>,
  );

const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));
/** Opens a Select and chooses the option named; Base UI commits a mouse
 *  choice only when the press started on the item. */
async function pick(trigger: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(trigger);
  });
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

const rows = (sessionId: string, events: AgentEvent[]): EventRow[] =>
  events.map((event, i) => ({ sessionId, seq: i + 1, ts: 1_000 + i, event }));

/** The board's section headers, in order. */
const headers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-group-header]")];
const header = (group: string): HTMLElement => document.querySelector<HTMLElement>(`[data-group-header='${group}']`)!;
/** The rows of one section. */
const rowsIn = (group: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-group='${group}'] [role='button'][tabindex='0']`)];
/** What a board must never ask a host for. */
const PER_ROW_READS = ["session.events", "session.tail", "session.head", "session.context", "session.notes.get"];

// jsdom has no layout: the virtualizer reads the scroller's height from offsetHeight.
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-board-scroller") ? 600 : 0;
    },
  });
});
afterAll(() => {
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
});

beforeEach(() => {
  sessionStore.reset();
  resetNotesStore();
  for (const l of [link, boxLink]) {
    l.calls = [];
    l.metas = [];
    l.rows.clear();
    l.notes.clear();
    l.digests.clear();
    l.boardChildren = [];
  }
  rowReads.length = 0;
  sent.length = 0;
  hosts.environments = [{ id: "local", name: "This Mac" }];
  hosts.statuses = new Map([["local", { transport: "open", fresh: true }]]);
  catalog.workspaces = [];
  catalog.projects = [];
  startThread.mockClear();
});
afterEach(() => {
  cleanup();
  sessionStore.reset();
});

/** The store lists the fixture through the link; every row's transcript
 *  is fetched from `link.rows`, so the bodies fold from events. */
function seed(children: SessionMeta[]): void {
  const all = [meta({ id: "m", title: "iOS batch 2", cwd: "/repo", masterId: null as unknown as string, isMaster: true, status: "idle" }), ...children];
  link.metas = all.map(({ environmentId: _e, ...wire }) => wire);
  sessionStore.attach(link);
}

/** A second host, "The box": saved, with the project's paired copy, its
 *  rows listed through its own link, offline unless `linked`. */
function seedBox(children: SessionMeta[], linked = false): void {
  hosts.environments = [
    { id: "local", name: "This Mac" },
    { id: "box", name: "The box" },
  ];
  hosts.statuses = new Map([
    ["local", { transport: "open", fresh: true }],
    ["box", linked ? { transport: "open", fresh: true } : { transport: "offline", fresh: false }],
  ]);
  catalog.workspaces = [
    { id: "w1", environmentId: "local", path: "/repo", githubRepo: "me/app", name: "repo" },
    { id: "w2", environmentId: "box", path: "/srv/repo", githubRepo: "me/app", name: "repo" },
  ];
  catalog.projects = [
    { id: "p1", environmentId: "local", cwd: "/repo" },
    { id: "p1-box", environmentId: "box", cwd: "/srv/repo" },
  ];
  boxLink.metas = children.map(({ environmentId: _e, ...wire }) => wire);
  sessionStore.attach(boxLink);
}

const boxMeta = (over: Partial<SessionMeta>): SessionMeta => meta({ environmentId: "box", projectId: "p1-box", cwd: "/srv/repo/.claude/worktrees/x", ...over });

describe("the master view", () => {
  it("a master with no child yet has its board: the header, + Thread opening the add sheet, the foot's steps, and no rows or prose", async () => {
    seed([]);
    renderView();
    await flush();
    expect(screen.getByTestId("chat")).toBeTruthy();
    const head = document.querySelector("[data-view-header]") as HTMLElement;
    expect(head.querySelector("[data-view-title]")?.textContent).toBe("iOS batch 2");
    expect(within(head).getByRole("button", { name: "Batch actions" })).toBeTruthy();
    expect(headers()).toHaveLength(0);
    expect(document.querySelector("[data-board-scroller]")?.textContent).toBe("");
    const foot = document.querySelector("[data-batch-foot]") as HTMLElement;
    expect(within(foot).getByRole("heading", { name: "When done" })).toBeTruthy();
    expect([...foot.querySelectorAll("[data-step]")].map((li) => li.getAttribute("data-step"))).toEqual(["land", "gate", "release"]);
    expect(foot.querySelector("[data-then]")?.textContent).toBe("Then notify you");
    fireEvent.click(within(head).getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New thread…" }));
    expect(within(await screen.findByRole("dialog")).getByText("Add a thread to iOS batch 2")).toBeTruthy();
  });

  it("a reloaded master with no child keeps the foot's skeleton until batch.board answers, then draws the empty board", async () => {
    seed([]);
    let answer: (v: unknown) => void = () => {};
    const request = link.request.bind(link);
    const spy = vi.spyOn(link, "request").mockImplementation(((method: string, params?: unknown) =>
      method === "batch.board" ? new Promise((r) => (answer = r)) : request(method, params)) as typeof link.request);
    try {
      renderView();
      await flush();
      expect(document.querySelector("[data-view-header]")).toBeTruthy();
      expect(document.querySelector("[data-batch-foot]")?.getAttribute("data-foot-mode")).toBe("loading");
      await act(async () => answer({ children: [], digests: {}, state: batch }));
      await flush();
      expect(document.querySelector("[data-batch-foot]")?.getAttribute("data-foot-mode")).toBe("console");
      expect(document.querySelectorAll("[data-batch-foot] [data-step]")).toHaveLength(3);
      expect(headers()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a master woken only by its batch's reports (no user-text in its log) loads as a thread with rows and draws its board", async () => {
    seed([meta({ id: "c-run", title: "Home screen", status: "running" })]);
    link.rows.set(
      "m",
      rows("m", [
        { type: "agent-report", agentId: "c-run", title: "Home screen", status: "idle" },
        { type: "assistant-text", text: "Home landed; waiting on the rest.", delta: false, msgId: "a1", blockIndex: 0 },
        { type: "turn-complete" },
      ] as AgentEvent[]),
    );
    await sessionStore.ready();
    await sessionStore.ensureLoaded("m");
    const loaded = sessionStore.get("m")!;
    expect(loaded.blocks.length).toBeGreaterThan(0);
    expect(loaded.load).toMatchObject({ phase: "loaded", empty: false });
    render(
      <SessionActionsContext.Provider value={actions}>
        <MasterView {...props} session={loaded} />
      </SessionActionsContext.Provider>,
    );
    await flush();
    expect(document.querySelector("[data-board]")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Home screen/ })).toBeTruthy();
  });

  it("groups the rows under the vocabulary's headings with no counts, nothing in the title bar", async () => {
    seed([
      meta({ id: "c-wait", title: "Live Activity strip", status: "waiting", createdAt: 3 }),
      meta({ id: "c-run", title: "Home screen", status: "running", createdAt: 1, activity: "Running ios:test:client" }),
      meta({ id: "c-queued", title: "Inbox swipe", status: "queued", createdAt: 4, activity: "Queued · waiting for Home", after: "c-run" }),
      meta({ id: "c-done", title: "Design foundations", status: "idle", createdAt: 2, updatedAt: new Date(2026, 9, 21, 12, 8).getTime() }),
    ]);
    renderView();
    await flush();
    expect(headers().map((h) => h.getAttribute("data-group-header"))).toEqual(["needsYou", "running", "queued", "done"]);
    expect(headers().map((h) => h.textContent)).toEqual(["Needs you", "Working", "Queued", "Done"]);
    expect(header("running").tagName).toBe("H3");
    // Line two: the activity for a running row, the scheduler's note without its lead for a queued one, when a landed one landed.
    expect(screen.getByText("Running ios:test:client")).toBeTruthy();
    expect(screen.getByText("waiting for Home")).toBeTruthy();
    expect(screen.getByText("Landed 12:08")).toBeTruthy();
    // The model at the end of line one: the name, then effort and context, no dots between them.
    expect(screen.getAllByText("Claude Opus 5.5")).toHaveLength(4);
    expect(screen.getAllByText("high 1M")).toHaveLength(4);
    // The type is the glyph's name, never a word beside the title.
    expect(screen.queryByText("Implementation")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Implementation" })).toHaveLength(4);
    // No host word: every child is on the master's host.
    expect(screen.queryByText("This Mac")).toBeNull();
  });

  it("every row but a settled one draws the status vocabulary's mark", async () => {
    seed([
      meta({ id: "c-wait", title: "A", status: "waiting", createdAt: 1 }),
      meta({ id: "c-run", title: "B", status: "running", createdAt: 2 }),
      meta({ id: "c-err", title: "C", status: "error", createdAt: 3 }),
      meta({ id: "c-pause", title: "D", status: "paused", createdAt: 4 }),
      meta({ id: "c-q", title: "E", status: "queued", createdAt: 5 }),
      meta({ id: "c-idle", title: "F", status: "idle", createdAt: 6 }),
    ]);
    renderView();
    await flush();
    const states = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-status]")].map((row) => [
        row.getAttribute("data-status"),
        row.querySelector("[data-row-status] [data-slot=status-mark]")?.getAttribute("data-state"),
      ]),
    );
    expect(states).toEqual({ waiting: "waiting", running: "working", error: "failed", paused: "paused", queued: "queued", idle: undefined });
  });

  it("a done row says its detail alone, no glyph, and keeps the state word for readers", async () => {
    seed([meta({ id: "c-done", title: "Design foundations", status: "idle", createdAt: 2, updatedAt: new Date(2026, 9, 21, 12, 8).getTime() })]);
    renderView();
    await flush();
    const status = screen.getByRole("button", { name: /Design foundations/ }).querySelector("[data-row-status]")!;
    expect(status.querySelector("[data-slot=status-mark]")).toBeNull();
    const detail = status.querySelector("[data-row-detail]")!;
    expect(detail.textContent).toBe("Landed 12:08");
    expect(detail.getAttribute("aria-label")).toBe("Done, Landed 12:08");
  });

  it("draws no section that is empty", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    expect(headers().map((h) => h.getAttribute("data-group-header"))).toEqual(["running"]);
  });

  it("an implementation row says the task in hand and 3/7 at the line's end, with no task list on the board", async () => {
    seed([
      meta({ id: "c-impl", title: "Home screen", status: "running", activity: "Running bun" }),
      meta({ id: "c-chat", title: "A question", status: "running", threadType: "chat", activity: "Reading" }),
    ]);
    const todos = [
      { content: "Read the brief", status: "completed" },
      { content: "Write the view", status: "in_progress" },
      { content: "Tests", status: "pending" },
    ];
    for (const id of ["c-impl", "c-chat"]) link.digests.set(id, { todos });
    renderView();
    await flush();
    await flush();
    const impl = screen.getByRole("button", { name: /Home screen/ });
    expect(impl.querySelector("[data-row-status]")?.textContent).toBe("Write the view1/3");
    expect(impl.querySelector("[data-tally]")?.textContent).toBe("1/3");
    // A reader hears the state and its detail, not the state alone.
    expect(screen.getByRole("button", { name: /Working, Write the view/ })).toBe(impl);
    expect(within(impl).queryByRole("list")).toBeNull();
    expect(within(impl).queryByRole("progressbar")).toBeNull();
    // A chat keeps its activity; the tally still ends its line.
    const chat = screen.getByRole("button", { name: /A question/ });
    expect(chat.querySelector("[data-row-status]")?.textContent).toBe("Reading1/3");
  });

  it("research and orchestration rows say their summary once settled and their activity while working, from the one answer", async () => {
    seed([
      meta({ id: "c-res", title: "Pricing survey", status: "idle", threadType: "research" }),
      meta({ id: "c-orc", title: "The fleet", status: "running", threadType: "orchestration", activity: "Running bun" }),
    ]);
    link.digests.set("c-res", { state: "Three sources read, two to go", last: "Reading the fourth." });
    link.digests.set("c-orc", { last: "Spawned three implementers." });
    renderView();
    await flush();
    await flush();
    expect(screen.getByRole("button", { name: /Pricing survey/ }).querySelector("[data-row-status]")?.textContent).toBe("Three sources read, two to go");
    const fleet = screen.getByRole("button", { name: /The fleet/ });
    expect(fleet.querySelector("[data-row-status]")?.textContent).toBe("Running bun");
    expect(within(fleet).queryByText("Spawned three implementers.")).toBeNull();
    // One batch.board, and nothing per row: no transcript, context or notes.
    expect(link.calls.filter((c) => c.method === "batch.board")).toHaveLength(1);
    expect(link.calls.filter((c) => PER_ROW_READS.includes(c.method))).toEqual([]);
  });

  it("a waiting row reads its question and an errored one its failure, with no lead before them", async () => {
    seed([
      meta({ id: "c-ask", title: "Live Activity", status: "waiting", createdAt: 1 }),
      meta({ id: "c-err", title: "Inbox", status: "error", createdAt: 2 }),
      meta({ id: "c-ok", title: "Tabs", status: "waiting", createdAt: 3, activity: "Bash" }),
    ]);
    link.digests.set("c-ask", { question: "Ad Hoc or Debug?" });
    link.digests.set("c-err", { failure: "Rate limited until 14:00" });
    renderView();
    await flush();
    const ask = screen.getByRole("button", { name: /Live Activity/ }).querySelector("[data-row-status]")!;
    expect(ask.textContent).toBe("Ad Hoc or Debug?");
    expect(ask.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("waiting");
    const err = screen.getByRole("button", { name: /Inbox/ }).querySelector("[data-row-status]")!;
    expect(err.textContent).toBe("Rate limited until 14:00");
    expect(err.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("button", { name: /Tabs/ }).querySelector("[data-row-status]")?.textContent).toBe("approve Bash");
  });

  it("hover shows Message, the state's one verb and ⋯, and ⋯ opens the row's menu", async () => {
    seed([
      meta({ id: "c-run", title: "Home", status: "running", busySince: 1, createdAt: 1 }),
      meta({ id: "c-pause", title: "Paused one", status: "paused", createdAt: 2 }),
      meta({ id: "c-idle", title: "Idle one", status: "idle", createdAt: 3 }),
    ]);
    renderView();
    await flush();
    const actionsOf = (name: RegExp) =>
      [...screen.getByRole("button", { name }).querySelectorAll<HTMLElement>("[data-actions] button")].map((b) => b.getAttribute("aria-label"));
    expect(actionsOf(/Home/)).toEqual(["Message", "Pause", "Thread actions"]);
    expect(actionsOf(/Paused one/)).toEqual(["Message", "Resume", "Thread actions"]);
    expect(actionsOf(/Idle one/)).toEqual(["Message", "Thread actions"]);
    const pause = vi.spyOn(commands, "pause").mockResolvedValue(undefined as never);
    fireEvent.click(within(screen.getByRole("button", { name: /Home/ })).getByRole("button", { name: "Pause" }));
    expect(pause).toHaveBeenCalledWith("c-run");
    pause.mockRestore();
    fireEvent.click(within(screen.getByRole("button", { name: /Idle one/ })).getByRole("button", { name: "Thread actions" }));
    expect(await screen.findByRole("menu", { name: "Thread actions" })).toBeTruthy();
    // Neither click opened the thread.
    expect(document.querySelector("[data-child-pane]")).toBeNull();
  });

  it("the board's text has no middle dot or bullet", async () => {
    seed([
      meta({ id: "c-run", title: "Home", status: "running", activity: "Running ios:test", createdAt: 1 }),
      meta({ id: "c-q", title: "Queued one", status: "queued", activity: "Queued · waiting for Home", createdAt: 2 }),
      meta({ id: "a1", title: "Agent", status: "running", parentId: "c-run", masterId: null as unknown as string, createdAt: 3 }),
      ...["a2", "a3", "a4"].map((id, i) => meta({ id, title: id, status: "running", parentId: "c-run", masterId: null as unknown as string, createdAt: 4 + i })),
      meta({ id: "a5", title: "a5", status: "idle", parentId: "c-run", masterId: null as unknown as string, createdAt: 9 }),
    ]);
    renderView();
    await flush();
    const board = document.querySelector("[data-board-scroller]")!.textContent ?? "";
    expect(board).toContain("and 1 more, 1 done");
    expect(board).not.toMatch(/[·•—]/);
  });

  it("a child the answer names before the store has it is a row, and leaves when its host removes it", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running", createdAt: 1 })]);
    const { environmentId: _e, ...wire } = meta({ id: "c-new", title: "Just started", status: "starting", createdAt: 2 });
    link.boardChildren = [wire];
    renderView();
    await flush();
    expect(screen.getByRole("button", { name: /Just started/ })).toBeTruthy();
    act(() => link.push({ push: "session-removed", sessionIds: ["c-new"] } as ServerPush));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("button", { name: /Just started/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Home/ })).toBeTruthy();
  });

  it("a board push changes that one row's digest", async () => {
    seed([meta({ id: "c-impl", title: "Home screen", status: "running", createdAt: 1 }), meta({ id: "c-two", title: "Inbox", status: "running", createdAt: 2 })]);
    link.digests.set("c-impl", { todos: [{ content: "Write the view", status: "in_progress" }] });
    renderView();
    await flush();
    const impl = () => screen.getByRole("button", { name: /Home screen/ });
    expect(within(impl()).getByText("0/1")).toBeTruthy();
    rowReads.length = 0;
    const digest: BoardDigest = { todos: [{ content: "Write the view", status: "completed" }, { content: "Tests", status: "in_progress" }] };
    act(() => link.push({ push: "board", masterId: "m", sessionId: "c-impl", digest } as ServerPush));
    expect(within(impl()).getByText("1/2")).toBeTruthy();
    expect(within(impl()).getByText("Tests")).toBeTruthy();
    // Only that row rendered again; another master's push changes nothing.
    expect(new Set(rowReads.filter(Boolean))).toEqual(new Set(["c-impl"]));
    act(() => link.push({ push: "board", masterId: "other", sessionId: "c-impl", digest: {} } as ServerPush));
    expect(within(impl()).getByText("1/2")).toBeTruthy();
  });

  it("a plan and the build it started are one row, keeping the plan's title", async () => {
    seed([
      meta({ id: "c-plan", title: "Search screen", status: "idle", threadType: "planning", archived: true, implementationId: "c-build", createdAt: 1 }),
      meta({ id: "c-build", title: "Search: the results screen", status: "running", planThreadId: "c-plan", createdAt: 5 }),
      meta({ id: "c-other", title: "Inbox", status: "running", createdAt: 3 }),
    ]);
    renderView();
    await flush();
    const titles = screen.getAllByRole("button", { name: /Search|Inbox/ }).map((b) => b.querySelector("[data-row-title]")?.textContent);
    expect(titles).toEqual(["Search screen", "Inbox"]);
    expect(screen.queryByText("Search: the results screen")).toBeNull();
    const row = screen.getByRole("button", { name: /Search screen/ }).closest("[data-plan]");
    expect(row?.getAttribute("data-plan")).toBe("c-plan");
    expect(row?.getAttribute("data-type")).toBe("implementation");
  });

  it("a row opens its thread's full view in the board's place, and Back or Escape returns to the board where it was", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" }), meta({ id: "c-two", title: "Inbox", status: "running" })]);
    renderView();
    await flush();
    expect(screen.getByTestId("chat")).toBeTruthy();
    const scroller = document.querySelector("[data-board-scroller]") as HTMLElement;
    scroller.scrollTop = 140;
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await flush();
    const pane = document.querySelector("[data-child-pane='c-run']");
    expect(pane).toBeTruthy();
    // The whole view: no board, no master chat beside it.
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(document.querySelector("[data-board]")).toBeNull();
    expect(document.querySelector("[data-child-view='c-run']")).toBeTruthy();
    // The transcript mounts in the pane's deferred pass, a frame after the header.
    await waitFor(() => expect(document.querySelector("[data-transcript='c-run']")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Back" }).closest("[data-child-pane]")?.textContent).not.toContain("Implementation");
    // Nothing opened a tab.
    expect(props.onOpenSession).not.toHaveBeenCalled();
    fireEvent.keyDown(pane!, { key: "Escape" });
    expect(screen.getByTestId("chat")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inbox/ })).toBeTruthy();
    expect((document.querySelector("[data-board-scroller]") as HTMLElement).scrollTop).toBe(140);
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await flush();
    fireEvent.keyDown(document.querySelector("[data-child-pane='c-run']")!, { key: "Enter", metaKey: true });
    expect(screen.getByTestId("chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("the title bar's menu archives the done threads or every one through batch.archive, with the live count", async () => {
    seed([
      meta({ id: "c-run", title: "Home", status: "running" }),
      meta({ id: "c-done", title: "Done one", status: "idle" }),
      meta({ id: "c-done2", title: "Done two", status: "done" }),
      meta({ id: "c-stop", title: "Stopped", status: "stopped" }),
    ]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Batch actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive done…" }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive 2 done threads?")).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.archive")?.params).toEqual({ masterId: "m", which: "done", removeResources: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Batch actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive all…" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive all 4 threads?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 4" }));
    await flush();
    expect(link.calls.filter((c) => c.method === "batch.archive").at(-1)?.params).toEqual({ masterId: "m", which: "all", removeResources: false });
  });

  it("Add existing thread… lists the project's roots in no batch and adopts the picked ones through batch.adopt", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    link.metas.push(
      ...[
        meta({ id: "free", title: "A stray chat", threadType: "chat", masterId: null as unknown as string, createdAt: 9 }),
        meta({ id: "free2", title: "Another", masterId: null as unknown as string, createdAt: 10 }),
        meta({ id: "taken", title: "In another batch", masterId: "m2", createdAt: 11 }),
      ].map(({ environmentId: _e, ...wire }) => wire),
    );
    sessionStore.attach(link);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add existing thread…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual(["A stray chatChat", "AnotherImplementation"]);
    expect(within(dialog).queryByText("In another batch")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /A stray chat/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.adopt")?.params).toEqual({ masterId: "m", sessionIds: ["free"] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the child pane has the thread's own composer: Message lands in it, a send goes to the thread, and ⌘↩ in it is the composer's", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "idle" })]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await flush();
    const pane = document.querySelector("[data-child-pane='c-run']")!;
    const box = pane.querySelector("[data-composer-box]")!;
    expect(box.getAttribute("data-composer-session")).toBe("c-run");
    const field = within(pane as HTMLElement).getByLabelText("Message") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    // ⌘↩ inside the composer never leaves the pane.
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(document.querySelector("[data-child-pane='c-run']")).toBeTruthy();
    field.value = "Ship it";
    fireEvent.submit(box);
    await flush();
    expect(sent).toEqual([{ id: "c-run", text: "Ship it", intent: "send" }]);
    expect(link.calls.some((c) => c.method === "session.send" && (c.params as { text: string }).text === "Ship it")).toBe(true);
  });

  it("a row's right-click menu leads with Open and New pass…, and its dialog sends into that thread on its own host and closes", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([boxMeta({ id: "c-box", title: "Inbox", status: "idle" })], true);
    renderView();
    await flush();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Inbox/ }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(labels.slice(0, 2)).toEqual(["Open", "New pass…"]);
    expect(labels).toContain("Rename");
    expect(labels).toContain("Archive");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New pass…" }));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Inbox")).toBeTruthy();
    const pass = dialog.querySelector("[data-new-pass='c-box']")!;
    expect(pass.getAttribute("data-new-pass-host")).toBe("box");
    expect(pass.querySelector("[data-composer-box]")?.getAttribute("data-composer-session")).toBe("c-box");
    const field = within(dialog).getByLabelText("Message") as HTMLTextAreaElement;
    field.value = "Second pass: the empty state";
    fireEvent.submit(field.closest("form")!);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent).toEqual([{ id: "c-box", text: "Second pass: the empty state", intent: "send" }]);
    // The turn went to the box, never to the master's host.
    expect(boxLink.calls.some((c) => c.method === "session.send" && (c.params as { sessionId: string }).sessionId === "c-box")).toBe(true);
    expect(link.calls.some((c) => c.method === "session.send")).toBe(false);
  });

  it("New pass on a running thread steers it, and Escape closes the dialog", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    sessionStore.patch("c-run", { busy: true });
    renderView();
    await flush();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Home/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New pass…" }));
    await flush();
    let field = within(screen.getByRole("dialog")).getByLabelText("Message") as HTMLTextAreaElement;
    field.value = "Also the footer";
    fireEvent.submit(field.closest("form")!);
    await flush();
    expect(sent.at(-1)).toEqual({ id: "c-run", text: "Also the footer", intent: "steer" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Home/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New pass…" }));
    await flush();
    field = within(screen.getByRole("dialog")).getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toHaveLength(1);
  });

  it("reads batch.board into the foot: the heading, a row per step in the master's order, the running step's console under its row", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    expect(link.calls.some((c) => c.method === "batch.board" && (c.params as { masterId: string }).masterId === "m")).toBe(true);
    expect(link.calls.some((c) => c.method === "batch.get")).toBe(false);
    const foot = document.querySelector("[data-batch-foot]")!;
    expect(within(foot as HTMLElement).getByRole("heading", { name: "When done" })).toBeTruthy();
    expect(foot.querySelector("[data-rules]")).toBeNull();
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
    const rows = [...foot.querySelectorAll<HTMLElement>("[data-step]")];
    expect(rows.map((li) => `${li.getAttribute("data-step")}:${li.getAttribute("data-step-status")}`)).toEqual(["land:passed", "gate:running", "release:pending"]);
    expect(rows.map((li) => li.querySelector("[data-slot=status-mark]")?.getAttribute("data-state"))).toEqual(["done", "working", "queued"]);
    expect(rows[0]!.querySelector("[data-step-time]")?.textContent).toBe("2m");
    // The running step says its progress on its row, its console under it, no bar.
    expect(rows[1]!.querySelector("[data-step-detail]")?.textContent).toBe("3 of 7vitest");
    expect(rows[1]!.querySelector("[data-console='gate']")?.textContent).toBe("✓ typecheck 12s\nvitest: 3 of 7 files");
    expect(foot.querySelector("[role='progressbar']")).toBeNull();
    expect(foot.querySelectorAll("[data-console]")).toHaveLength(1);
    expect(foot.querySelector("[data-then]")?.textContent).toBe("Then notify you");
  });

  it("the foot is a skeleton until batch.board answers", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    let answer: (v: unknown) => void = () => {};
    const request = link.request.bind(link);
    const spy = vi.spyOn(link, "request").mockImplementation(((method: string, params?: unknown) =>
      method === "batch.board" ? new Promise((r) => (answer = r)) : request(method, params)) as typeof link.request);
    try {
      renderView();
      await flush();
      expect(document.querySelector("[data-batch-foot]")?.getAttribute("data-foot-mode")).toBe("loading");
      expect(document.querySelectorAll("[data-batch-foot] [data-slot=skeleton]").length).toBeGreaterThan(1);
      await act(async () => answer({ children: [], digests: {}, state: batch }));
      await flush();
      expect(document.querySelector("[data-batch-foot]")?.getAttribute("data-foot-mode")).toBe("console");
    } finally {
      spy.mockRestore();
    }
  });

  it("the land row says how branches land before it runs", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    const push = (land: string, steps: unknown[]) =>
      act(() => {
        link.push({ push: "batch", state: { ...batch, rules: { ...batch.rules, land }, steps } } as unknown as ServerPush);
      });
    const detail = () => document.querySelector("[data-step='land'] [data-step-detail]")?.textContent;
    push("as-they-finish", [{ id: "land", status: "pending", detail: "", at: null, log: [] }]);
    expect(detail()).toBe("as they finish");
    push("all-at-once", [{ id: "land", status: "pending", detail: "", at: null, log: [] }]);
    expect(detail()).toBe("all at once");
    push("as-they-finish", [{ id: "land", status: "running", detail: "", at: 1, startedAt: 1, log: [] }]);
    expect(detail()).toBe("1 of 4 landed");
  });

  it("the running step's clock ticks every second from startedAt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(batch.steps[1].startedAt! + 65_000);
      seed([meta({ id: "c-run", title: "Home", status: "running" })]);
      renderView();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const head = () => document.querySelector("[data-step='gate'] [data-step-time]")?.textContent;
      expect(head()).toBe("1m 5s");
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(head()).toBe("1m 6s");
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(head()).toBe("1m 8s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the console follows new lines until the person scrolls up, and Stop writes batch.stopStep with the step's id", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    const log = document.querySelector("[data-log]") as HTMLPreElement;
    // jsdom has no layout: give the scroller a size and watch where it lands.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 100 });
    const push = (lines: string[]) =>
      act(() => {
        link.push({ push: "batch", state: { ...batch, steps: batch.steps.map((s) => (s.id === "gate" ? { ...s, log: lines } : s)) } } as unknown as ServerPush);
      });
    push(["a", "b", "c"]);
    expect(log.scrollTop).toBe(400);
    // The person scrolls up: the next lines leave the view where it is.
    log.scrollTop = 120;
    fireEvent.scroll(log);
    push(["a", "b", "c", "d"]);
    expect(log.scrollTop).toBe(120);
    // Back at the bottom, it follows again.
    log.scrollTop = 300;
    fireEvent.scroll(log);
    push(["a", "b", "c", "d", "e"]);
    expect(log.scrollTop).toBe(400);
    // A host's push carries only the new lines, numbered from the step's start.
    act(() => {
      link.push({ push: "batch", state: { ...batch, steps: batch.steps.map((s) => (s.id === "gate" ? { ...s, log: { from: 5, lines: ["f"] } } : s)) } } as unknown as ServerPush);
    });
    expect(log.textContent).toBe("a\nb\nc\nd\ne\nf");
    // One that starts past what is held asks batch.get for the whole state.
    act(() => {
      link.push({ push: "batch", state: { ...batch, steps: batch.steps.map((s) => (s.id === "gate" ? { ...s, log: { from: 40, lines: ["z"] } } : s)) } } as unknown as ServerPush);
    });
    await flush();
    expect(link.calls.some((c) => c.method === "batch.get")).toBe(true);
    const foot = document.querySelector("[data-batch-foot]") as HTMLElement;
    fireEvent.click(within(foot).getByRole("button", { name: "Stop" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.stopStep")?.params).toEqual({ masterId: "m", stepId: "gate" });
  });

  it("the console opens under the step's row when it starts and closes when it passes; the rows stay", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    const foot = () => document.querySelector("[data-batch-foot]")!;
    const pushSteps = (steps: unknown[]) =>
      act(() => {
        link.push({ push: "batch", state: { ...batch, steps } } as unknown as ServerPush);
      });
    const rowsOf = () => [...foot().querySelectorAll("[data-step]")].map((li) => `${li.getAttribute("data-step")}:${li.getAttribute("data-step-status")}`);
    const t = batch.steps[1].startedAt!;
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "pending", detail: "", at: null, log: [] },
      { id: "release", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("idle");
    expect(rowsOf()).toEqual(["land:passed", "gate:pending", "release:pending"]);
    expect(foot().querySelector("[data-step='land'] [data-step-time]")?.textContent).toBe("2m");
    expect(foot().querySelector("[data-console]")).toBeNull();
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "running", detail: "", at: 2, startedAt: t, log: ["starting"] },
      { id: "release", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("console");
    expect(foot().querySelector("[data-step='gate'] [data-console='gate']")).toBeTruthy();
    expect(rowsOf()).toEqual(["land:passed", "gate:running", "release:pending"]);
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "passed", detail: "", at: 3, startedAt: t, endedAt: t + 252_000, log: ["starting", "done"] },
      { id: "release", status: "passed", detail: "release-278", at: 4, startedAt: t + 252_000, endedAt: t + 260_000 },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("idle");
    expect(foot().querySelector("[data-console]")).toBeNull();
    expect([...foot().querySelectorAll("[data-step-time]")].map((e) => e.textContent)).toEqual(["2m", "4m 12s", "8s"]);
  });

  it("the steps are the master's list in order: a shell step reads by its name idle, and its command shows once, as its console's first line", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    const rules = {
      land: "as-they-finish",
      then: "archive-children",
      summary: "Build, deploy to dev, smoke",
      steps: [
        { id: "land", name: "Merging", kind: "land" },
        { id: "build", name: "Build the plugin", kind: "shell", run: "gradle build" },
        { id: "deploy-dev", name: "Deploy to dev", kind: "shell", run: "./deploy dev" },
      ],
    };
    const t = batch.steps[1].startedAt!;
    const push = (steps: unknown[]) =>
      act(() => {
        link.push({ push: "batch", state: { ...batch, rules, steps } } as unknown as ServerPush);
      });
    push([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "build", status: "pending", detail: "", at: null, log: [] },
    ]);
    const foot = document.querySelector("[data-batch-foot]")!;
    expect(foot.getAttribute("data-foot-mode")).toBe("idle");
    // The row names every step of the list in order, the one the host has not seen yet pending at the end.
    expect([...foot.querySelectorAll("[data-step]")].map((li) => `${li.getAttribute("data-step")}:${li.getAttribute("data-step-status")}:${li.textContent}`)).toEqual([
      "land:passed:Merging1 of 4 landed2m",
      "build:pending:Build the plugin",
      "deploy-dev:pending:Deploy to dev",
    ]);
    expect(foot.querySelector("[data-then]")?.textContent).toBe("Then archive the threads");
    push([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "build", status: "running", detail: "", at: 2, startedAt: t, log: ["$ gradle build", "BUILD SUCCESSFUL"] },
      { id: "deploy-dev", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
    const build = foot.querySelector("[data-step='build']") as HTMLElement;
    expect(build.querySelector("[data-console='build']")?.textContent).toBe("$ gradle build\nBUILD SUCCESSFUL");
    expect((foot.textContent ?? "").split("gradle build")).toHaveLength(2);
    expect(foot.querySelector("[data-step='deploy-dev']")?.getAttribute("data-step-status")).toBe("pending");
    fireEvent.click(within(build).getByRole("button", { name: "Stop" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.stopStep")?.params).toEqual({ masterId: "m", stepId: "build" });
  });

  it("a failed step stays open with its last lines and the failure in red until Hide, and Show opens it again", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    const t = batch.steps[1].startedAt!;
    act(() => {
      link.push({
        push: "batch",
        state: {
          ...batch,
          steps: [
            { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
            { id: "gate", status: "failed", detail: "FAILED at vitest", at: 3, startedAt: t, endedAt: t + 30_000, log: ["✓ typecheck 12s", "✗ vitest: 2 failed"] },
            { id: "release", status: "skipped", detail: "", at: 4 },
          ],
        },
      } as unknown as ServerPush);
    });
    const foot = document.querySelector("[data-batch-foot]")!;
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
    const gate = foot.querySelector("[data-step='gate']") as HTMLElement;
    expect(gate.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")).toBe("failed");
    expect(gate.querySelector("[data-step-detail]")?.className).toContain("text-destructive");
    expect(gate.querySelector("[data-step-time]")?.textContent).toBe("30s");
    expect(gate.querySelector("[data-log] .text-destructive")?.textContent).toBe("FAILED at vitest");
    expect(within(foot as HTMLElement).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(foot.querySelector("[data-step='release']")?.textContent).toBe("Releaseskipped");
    fireEvent.click(within(gate).getByRole("button", { name: /Hide/ }));
    expect(foot.getAttribute("data-foot-mode")).toBe("idle");
    expect(gate.getAttribute("data-step-status")).toBe("failed");
    fireEvent.click(within(gate).getByRole("button", { name: /Show/ }));
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
  });

  it("Edit opens the rules: the steps reorder, a built-in and a shell step are added, one is removed, and Save writes the list", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    const ids = () => [...dialog.querySelectorAll("[data-rule-step]")].map((li) => li.getAttribute("data-rule-step"));
    expect(ids()).toEqual(["land", "gate", "release"]);
    // Land is pinned first: no controls of its own, and the row under it cannot pass it.
    expect(within(dialog).queryByRole("button", { name: "Move Merging up" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Move Gate up" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Release up" }));
    expect(ids()).toEqual(["land", "release", "gate"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Gate" }));
    expect(ids()).toEqual(["land", "release"]);
    // A built-in kind lands at once with its name.
    await pick(await within(dialog).findByRole("combobox", { name: "Add a step" }), "Deploy to the box");
    expect(ids()).toEqual(["land", "release", "deploy"]);
    // A shell step asks for a name and a command first; Add stays off until both are there.
    await pick(await within(dialog).findByRole("combobox", { name: "Add a step" }), "Shell command");
    const addStep = within(dialog).getByRole("button", { name: "Add step" });
    expect(addStep.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Step name"), { target: { value: "Smoke test" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "bun run smoke" } });
    fireEvent.change(within(dialog).getByLabelText("Working directory"), { target: { value: "/srv/plugin" } });
    fireEvent.click(addStep);
    expect(ids()).toEqual(["land", "release", "deploy", "shell"]);
    expect(dialog.querySelector("[data-rule-step='shell'] [data-rule-line]")?.textContent).toBe("bun run smoke");
    fireEvent.change(within(dialog).getByLabelText("Step 3 name"), { target: { value: "Deploy to the box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "All at once" }));
    fireEvent.change(within(dialog).getByPlaceholderText(/One line/), { target: { value: "Land all seven" } });
    expect(dialog.querySelector("[data-rules-preview]")?.textContent).toBe(
      "Branches land together once every thread is done, then Release, Deploy to the box and Smoke test. Then you are notified.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await flush();
    const call = link.calls.find((c) => c.method === "batch.setRules");
    expect(call?.params).toEqual({
      masterId: "m",
      rules: {
        land: "all-at-once",
        then: "notify",
        summary: "Land all seven",
        steps: [
          { id: "land", name: "Merging", kind: "land" },
          { id: "release", name: "Release", kind: "release" },
          { id: "deploy", name: "Deploy to the box", kind: "deploy" },
          { id: "shell", name: "Smoke test", kind: "shell", run: "bun run smoke", cwd: "/srv/plugin" },
        ],
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Save stays off while a step has no name", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Step 2 name"), { target: { value: " " } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("the add sheet creates the thread under the master with the brief as its first message", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add a thread to iOS batch 2")).toBeTruthy();
    // The brief has focus; every effort of the model's own ladder is offered.
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Brief"));
    expect(within(within(dialog).getByRole("group", { name: "Effort" })).getAllByRole("button", { name: /Low|Medium|High|Max/ }).length).toBeGreaterThanOrEqual(3);
    fireEvent.click(within(dialog).getByRole("button", { name: "Plan" }));
    await pick(within(dialog).getByRole("combobox", { name: "After" }), "Home");
    fireEvent.change(within(dialog).getByLabelText("Brief"), { target: { value: "Search: the results screen." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await flush();
    expect(startThread).toHaveBeenCalledTimes(1);
    const [params, brief] = startThread.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(brief).toBe("Search: the results screen.");
    expect(params).toMatchObject({
      environmentId: "local",
      threadType: "planning",
      provider: "claude",
      projectId: "p1",
      masterId: "m",
      after: "c-run",
      queue: true,
    });
    expect(params).not.toHaveProperty("parentId");
    // Nothing optimistic: the row arrives from the host's push.
    expect(screen.queryByRole("button", { name: /Search: the results screen/ })).toBeNull();
    expect(headers()).toHaveLength(1);
  });

  it("a queued row offers Start now on hover and Remove from queue in its menu", async () => {
    seed([meta({ id: "c-q", title: "Inbox", status: "queued", activity: "Queued · waiting for Home", after: "c-run" })]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));
    await flush();
    expect(link.calls.some((c) => c.method === "session.start" && (c.params as { sessionId: string }).sessionId === "c-q")).toBe(true);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(within(screen.getByRole("button", { name: /Inbox/ })).getByRole("button", { name: "Thread actions" }));
    await flush();
    fireEvent.click(within(screen.getByRole("menu", { name: "Thread actions" })).getByText("Remove from queue"));
    await flush();
    expect(link.calls.find((c) => c.method === "session.batch")?.params).toMatchObject({ action: "stop", ids: ["c-q"] });
  });

  it("a queued row the board's answer names before the store has it still opens its menu and leaves the queue on its host", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running", createdAt: 1 })]);
    const { environmentId: _e, ...wire } = meta({ id: "c-new", title: "Just queued", status: "queued", activity: "Queued · waiting for Home", createdAt: 2 });
    link.boardChildren = [wire];
    renderView();
    await flush();
    fireEvent.click(within(screen.getByRole("button", { name: /Just queued/ })).getByRole("button", { name: "Thread actions" }));
    fireEvent.click(within(await screen.findByRole("menu", { name: "Thread actions" })).getByText("Remove from queue"));
    await flush();
    expect(link.calls.find((c) => c.method === "session.batch")?.params).toMatchObject({ action: "stop", ids: ["c-new"] });
  });

  it("the header carries the master's title, its summary and the two actions", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    renderView();
    await flush();
    act(() => {
      link.push({ push: "batch", state: { ...batch, rules: { ...batch.rules, summary: "Gate, release, publish" } } } as unknown as ServerPush);
    });
    const head = document.querySelector("[data-view-header]") as HTMLElement;
    expect(head.querySelector("[data-view-title]")?.textContent).toBe("iOS batch 2");
    expect(head.querySelector("[data-view-detail]")?.textContent).toBe("Gate, release, publish");
    expect(within(head).getByRole("button", { name: "Batch actions" })).toBeTruthy();
    expect(within(head).getByRole("button", { name: /^Thread$/ })).toBeTruthy();
    // The foot no longer repeats the summary.
    expect(document.querySelector("[data-batch-foot]")?.textContent).not.toContain("Gate, release, publish");
  });
});

describe("the board's static preview", () => {
  it("draws the fixture's five rows in the four sections and the shell step's console, all in the vocabulary", () => {
    render(<BoardPreview />);
    expect(headers().map((h) => h.textContent)).toEqual(["Needs you", "Working", "Queued", "Done"]);
    const states = [...document.querySelectorAll("[data-row-status] > [data-slot=status-mark]")].map((m) => m.getAttribute("data-state"));
    // The done row says its detail alone.
    expect(states).toEqual(["waiting", "working", "paused", "queued"]);
    expect(document.querySelectorAll("[data-row-status] > [data-row-detail]")).toHaveLength(1);
    expect(document.querySelector("[data-agents-tail]")?.textContent).toBe("1 done");
    expect(document.querySelector("[data-step='smoke'] [data-console='smoke']")?.textContent?.split("\n")).toHaveLength(8);
    expect(document.body.textContent).not.toMatch(/[·•—]/);
  });
});

describe("the board's first paint", () => {
  it("is reported once per open as board-paint with the row count, a trip into a child and back not counting", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running", createdAt: 1 }), meta({ id: "c-two", title: "Inbox", status: "running", createdAt: 2 })]);
    renderView();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const reports = () => link.calls.filter((c) => c.method === "stall.report").map((c) => (c.params as { line: string }).line);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatch(/^board-paint master=m n=2 ms=\d+$/);
    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(reports()).toHaveLength(1);
  });
});

describe("a fleet of 300", () => {
  const fleet = () =>
    Array.from({ length: 300 }, (_, i) => meta({ id: `f${i}`, title: `Thread ${i}`, status: "running", createdAt: i + 1 }));

  it("mounts only the rows on screen, from one answer and nothing per row", async () => {
    seed(fleet());
    renderView();
    await flush();
    const mounted = document.querySelectorAll("[data-status]");
    expect(mounted.length).toBeGreaterThan(5);
    expect(mounted.length).toBeLessThan(30);
    expect(header("running").textContent).toBe("Working");
    // The list is as tall as every row, though most are not in the DOM.
    const sized = document.querySelector("[data-board-scroller] > div") as HTMLElement;
    expect(parseInt(sized.style.height, 10)).toBeGreaterThan(300 * 50);
    expect(link.calls.filter((c) => PER_ROW_READS.includes(c.method))).toEqual([]);
    expect(link.calls.filter((c) => c.method === "batch.board")).toHaveLength(1);
  });

  it("one child's meta change renders that row again and no other", async () => {
    seed(fleet());
    renderView();
    await flush();
    rowReads.length = 0;
    const { environmentId: _e, ...wire } = meta({ id: "f2", title: "Thread 2", status: "running", createdAt: 3, activity: "Running lint" });
    act(() => link.push({ push: "session", session: wire } as unknown as ServerPush));
    // The store tells meta listeners once per frame.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByText("Running lint")).toBeTruthy();
    expect(rowReads.filter((id) => id && id !== "f2")).toEqual([]);
    expect(rowReads.filter((id) => id === "f2").length).toBeGreaterThan(0);
  });
});

describe("a row's subagents", () => {
  const agent = (id: string, parentId: string, status: SessionMeta["status"], over: Partial<SessionMeta> = {}) =>
    meta({ id, parentId, masterId: null as unknown as string, status, threadType: null as unknown as SessionMeta["threadType"], ...over });
  const rowOf = (title: RegExp): HTMLElement => screen.getAllByRole("button", { name: title })[0]!.closest("[data-status]") as HTMLElement;
  const linesOf = (title: RegExp): string[] =>
    [...rowOf(title).querySelectorAll("[data-agent]")].map((l) => `${l.querySelector("[data-slot=status-mark]")?.getAttribute("data-state")} ${l.textContent}`);
  const tailOf = (title: RegExp): string | null => rowOf(title).querySelector("[data-agents-tail]")?.textContent ?? null;

  it("lists the whole tree's live agents under the row, the person's first, archived ones out and settled ones counted; a row with none shows nothing", async () => {
    seed([
      meta({ id: "c-impl", title: "Home screen", status: "running" }),
      meta({ id: "c-chat", title: "A question", status: "running", threadType: "chat", createdAt: 2 }),
      agent("a1", "c-impl", "running", { title: "Rail rows", activity: "Editing Rail.tsx", createdAt: 3 }),
      agent("a11", "a1", "waiting", { title: "Tests", activity: "Bash", createdAt: 4 }),
      agent("a111", "a11", "error", { title: "Lint", failure: { summary: "Usage cap" } as SessionMeta["failure"], createdAt: 5 }),
      agent("a2", "c-impl", "idle", { title: "Old" }),
      agent("a3", "c-impl", "running", { archived: true, title: "Gone" }),
    ]);
    renderView();
    await flush();
    expect(linesOf(/Home screen/)).toEqual([
      "waiting Testsapprove Bash",
      "failed LintUsage cap",
      "working Rail rowsEditing Rail.tsx",
    ]);
    const waiting = rowOf(/Home screen/).querySelector("[data-agent='a11'] [data-agent-what]")!;
    expect(waiting.className).toContain("text-warning");
    expect(rowOf(/Home screen/).querySelector("[data-agent='a111'] [data-agent-what]")!.className).toContain("text-destructive");
    expect(tailOf(/Home screen/)).toBe("1 done");
    expect(rowOf(/A question/).querySelector("[data-agents]")).toBeNull();
    // Agents are not rows of the board.
    expect(document.querySelectorAll("[data-status]")).toHaveLength(2);
  });

  it("caps the lines at three and counts the rest", async () => {
    seed([
      meta({ id: "c-impl", title: "Home screen", status: "running" }),
      ...[1, 2, 3, 4, 5].map((i) => agent(`a${i}`, "c-impl", "running", { title: `Agent ${i}`, createdAt: i })),
    ]);
    renderView();
    await flush();
    expect(linesOf(/Home screen/)).toHaveLength(3);
    expect(tailOf(/Home screen/)).toBe("and 2 more");
  });

  it("a line opens its agent in the board's place, never the row", async () => {
    seed([meta({ id: "c-impl", title: "Home screen", status: "running" }), agent("a1", "c-impl", "waiting", { title: "Tests" })]);
    renderView();
    await flush();
    fireEvent.click(document.querySelector("[data-agent='a1']")!);
    await flush();
    expect(document.querySelector("[data-child-pane='a1']")).toBeTruthy();
    expect(document.querySelector("[data-child-pane='c-impl']")).toBeNull();
    expect(props.onOpenSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByTestId("chat")).toBeTruthy();
  });

  it("follows the agents live and renders only the row whose agents changed", async () => {
    seed([
      meta({ id: "c-impl", title: "Home screen", status: "running" }),
      meta({ id: "c-other", title: "Search", status: "running", createdAt: 2 }),
      agent("a1", "c-impl", "running", { title: "Rail", activity: "Reading a.ts" }),
    ]);
    renderView();
    await flush();
    expect(linesOf(/Home screen/)).toEqual(["working RailReading a.ts"]);
    rowReads.length = 0;
    const { environmentId: _e, ...wire } = agent("a1", "c-impl", "running", { title: "Rail", activity: "Editing a.ts" });
    act(() => link.push({ push: "session", session: wire } as unknown as ServerPush));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(linesOf(/Home screen/)).toEqual(["working RailEditing a.ts"]);
    expect(rowReads.filter((id) => id === "c-other")).toEqual([]);
    const { environmentId: _g, ...settled } = agent("a1", "c-impl", "idle", { title: "Rail" });
    act(() => link.push({ push: "session", session: settled } as unknown as ServerPush));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(rowOf(/Home screen/).querySelector("[data-agents]")).toBeNull();
    const { environmentId: _f, ...spawned } = agent("a2", "c-other", "starting", { createdAt: 9 });
    act(() => link.push({ push: "session", session: spawned } as unknown as ServerPush));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(linesOf(/Search/)).toEqual(["working Subagent"]);
  });
});

describe("the batch across hosts", () => {
  it("a child on another host carries that host's glyph, under the offline tint while the host is out of reach", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([boxMeta({ id: "c-box", title: "Inbox", status: "running", model: "gpt-6.1-sol", provider: "codex" })]);
    const { rerender } = renderView();
    await flush();
    expect(rowsIn("running").map((r) => r.querySelector("[data-row-title]")?.textContent)).toEqual(["Home", "Inbox"]);
    const home = screen.getByRole("button", { name: /Home/ }).closest("[data-status]")!;
    const box = screen.getByRole("button", { name: /Inbox/ }).closest("[data-status]")!;
    expect(home.getAttribute("data-host")).toBeNull();
    expect(home.textContent).not.toContain("The box");
    expect(box.getAttribute("data-host")).toBe("box");
    expect(box.getAttribute("data-host-offline")).toBe("true");
    expect(box.className).toContain("opacity-50");
    // Every row draws its host's glyph, the name on hover; the offline row says so instead.
    expect(home.querySelector("[data-row-title] + [data-host-glyph]")?.getAttribute("aria-label")).toBe("This Mac");
    const glyph = box.querySelector("[data-row-title] + [data-host-glyph]")!;
    expect(glyph.getAttribute("data-host-glyph")).toBe("box");
    expect(glyph.getAttribute("aria-label")).toBe("The box is offline");
    expect(box.querySelector("[data-model]")!.textContent).not.toContain("The box");
    // The host comes back: the tint lifts and the glyph names it.
    hosts.statuses = new Map([
      ["local", { transport: "open", fresh: true }],
      ["box", { transport: "open", fresh: true }],
    ]);
    rerender(
      <SessionActionsContext.Provider value={actions}>
        <MasterView {...props} />
      </SessionActionsContext.Provider>,
    );
    const again = screen.getByRole("button", { name: /Inbox/ }).closest("[data-status]")!;
    expect(again.getAttribute("data-host-offline")).toBeNull();
    expect(again.className).not.toContain("opacity-50");
    expect(again.querySelector("[data-row-title] + [data-host-glyph]")?.getAttribute("aria-label")).toBe("The box");
  });

  it("a child on another host lists its subagents from that host's rows, with the host's glyph", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox(
      [
        boxMeta({ id: "c-box", title: "Inbox", status: "running" }),
        boxMeta({ id: "b1", parentId: "c-box", masterId: null as unknown as string, status: "running" }),
        boxMeta({ id: "b11", parentId: "b1", masterId: null as unknown as string, status: "waiting" }),
      ],
      true,
    );
    renderView();
    await flush();
    const inbox = screen.getByRole("button", { name: /Inbox/ });
    expect([...inbox.querySelectorAll("[data-agent]")].map((l) => l.getAttribute("data-agent"))).toEqual(["b11", "b1"]);
    expect(inbox.querySelector("[data-agent='b1'] [data-host-glyph]")?.getAttribute("data-host-glyph")).toBe("box");
    expect(screen.getByRole("button", { name: /Home/ }).querySelector("[data-agents]")).toBeNull();
  });

  it("a row of another host reads its digest from that host's batch.board, and an offline host is not asked", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([boxMeta({ id: "c-box", title: "Inbox", status: "running" })], true);
    boxLink.digests.set("c-box", { todos: [{ content: "Swipe", status: "in_progress" }, { content: "Tests", status: "pending" }] });
    renderView();
    await flush();
    const box = screen.getByRole("button", { name: /Inbox/ });
    expect(within(box).getByText("0/2")).toBeTruthy();
    expect(box.querySelector("[data-row-status]")?.textContent).toBe("Swipe0/2");
    expect(boxLink.calls.filter((c) => c.method === "batch.board").map((c) => c.params)).toEqual([{ masterId: "m" }]);
    // Its board push moves the row; nothing is read per row on either host.
    act(() => boxLink.push({ push: "board", masterId: "m", sessionId: "c-box", digest: { todos: [{ content: "Swipe", status: "completed" }] } } as ServerPush));
    expect(within(screen.getByRole("button", { name: /Inbox/ })).getByText("1/1")).toBeTruthy();
    expect([...link.calls, ...boxLink.calls].filter((c) => PER_ROW_READS.includes(c.method))).toEqual([]);
    cleanup();
    boxLink.calls = [];
    hosts.statuses = new Map([
      ["local", { transport: "open", fresh: true }],
      ["box", { transport: "offline", fresh: false }],
    ]);
    renderView();
    await flush();
    expect(boxLink.calls.some((c) => c.method === "batch.board")).toBe(false);
  });

  it("a row of another host opens its view on that host", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([boxMeta({ id: "c-box", title: "Inbox", status: "running" })], true);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
    await flush();
    const pane = document.querySelector("[data-child-pane='c-box']")!;
    expect(pane.getAttribute("data-child-host")).toBe("box");
    // The transcript mounts in the pane's deferred pass, a frame after the header.
    await waitFor(() => expect(document.querySelector("[data-transcript='c-box']")).toBeTruthy());
    // Its transcript was asked of the box, not the master's host.
    expect(boxLink.calls.some((c) => c.method === "session.events" && (c.params as { sessionId: string }).sessionId === "c-box")).toBe(true);
    expect(link.calls.some((c) => c.method === "session.events" && (c.params as { sessionId: string }).sessionId === "c-box")).toBe(false);
  });

  it("the add sheet offers the linked hosts, the master's first, and starts the thread on the chosen one with the master as its starter", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([], true);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread…" }));
    const dialog = screen.getByRole("dialog");
    const hostRow = within(dialog).getByRole("group", { name: "Host" });
    expect(within(hostRow).getAllByRole("button").map((r) => r.textContent)).toEqual(["This Mac", "The box"]);
    expect(within(hostRow).getByRole("button", { name: "This Mac" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(hostRow).getByRole("button", { name: "The box" }));
    fireEvent.change(within(dialog).getByLabelText("Brief"), { target: { value: "Search: the results screen." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await flush();
    expect(startThread).toHaveBeenCalledTimes(1);
    const [params] = startThread.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params).toMatchObject({ environmentId: "box", projectId: "p1-box", masterId: "m", startedBy: "m", queue: true });
  });

  it("the add sheet hides the host row while the other host is offline", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    seedBox([]);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread…" }));
    expect(within(screen.getByRole("dialog")).queryByRole("group", { name: "Host" })).toBeNull();
  });

  it("Add existing thread… names each candidate's host across hosts, adopts a remote one in the cross-host id form, and reads the refusal", async () => {
    seed([meta({ id: "c-home", title: "Home", status: "running" })]);
    link.metas.push(...[meta({ id: "free", title: "A stray chat", threadType: "chat", masterId: null as unknown as string, createdAt: 9 })].map(({ environmentId: _e, ...wire }) => wire));
    sessionStore.attach(link);
    seedBox([boxMeta({ id: "free-box", title: "Box stray", masterId: null as unknown as string, createdAt: 10 })], true);
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Thread$/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add existing thread…" }));
    const dialog = screen.getByRole("dialog");
    const labels = within(dialog).getAllByRole("checkbox").map((c) => c.closest("label")!);
    expect(labels.map((l) => l.textContent)).toEqual(["A stray chatChatThis Mac", "Box strayImplementationThe box"]);
    expect(labels[1].querySelector("[data-host]")?.getAttribute("data-host")).toBe("box");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Box stray/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.adopt")?.params).toEqual({ masterId: "m", sessionIds: ["box:free-box"] });
    expect(boxLink.calls.some((c) => c.method === "batch.adopt")).toBe(false);
    // The host's refusal, by the thread's title, keeps the sheet open.
    expect(within(screen.getByRole("dialog")).getByText(/Box stray: unknown thread/)).toBeTruthy();
  });

  it("the menu counts rows of every host: Pause all pauses on each host, Archive done and all reach the box through its own session.batch for what batch.archive left", async () => {
    seed([
      meta({ id: "c-run", title: "Home", status: "running" }),
      meta({ id: "c-done", title: "Done one", status: "idle" }),
    ]);
    seedBox(
      [
        boxMeta({ id: "b-run", title: "Box running", status: "running" }),
        boxMeta({ id: "b-done", title: "Box done", status: "done" }),
      ],
      true,
    );
    renderView();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Batch actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    let dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Pause 2 running threads?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause all" }));
    await flush();
    expect(link.calls.find((c) => c.method === "session.batch")?.params).toEqual({ action: "pause", ids: ["c-run"] });
    expect(boxLink.calls.find((c) => c.method === "session.batch")?.params).toEqual({ action: "pause", ids: ["b-run"] });

    fireEvent.click(screen.getByRole("button", { name: "Batch actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive done…" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive 2 done threads?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.archive")?.params).toEqual({ masterId: "m", which: "done", removeResources: false });
    expect(boxLink.calls.filter((c) => c.method === "session.batch").at(-1)?.params).toEqual({ action: "archive", ids: ["b-done"] });
    expect(boxLink.calls.some((c) => c.method === "batch.archive")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Batch actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive all…" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive all 4 threads?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 4" }));
    await flush();
    const boxCalls = boxLink.calls.filter((c) => c.method === "session.batch").slice(-2).map((c) => c.params);
    expect(boxCalls).toEqual([
      { action: "stop", ids: ["b-run"] },
      { action: "archive", ids: ["b-run", "b-done"] },
    ]);
  });
});
