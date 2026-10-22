// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BATCH_RULES, type BatchState } from "@server/shared/contract-batch";
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
 * `session.create`. The session store is real, fed through
 * one fake link that answers each thread's rows; the chat, the child's
 * transcript and the heavy pickers are stand-ins.
 */

const { startThread, batch, link } = vi.hoisted(() => {
  class FakeLink implements Link {
    environmentId = "local";
    profile = "local" as const;
    connected = true;
    metas: Omit<SessionMeta, "environmentId">[] = [];
    rows = new Map<string, EventRow[]>();
    notes = new Map<string, string>();
    calls: { method: string; params: unknown }[] = [];
    private pushListeners = new Set<(push: ServerPush) => void>();
    request<T>(method: string, params?: unknown): Promise<T> {
      this.calls.push({ method, params });
      const p = (params ?? {}) as { sessionId?: string };
      if (method === "session.list") return Promise.resolve(this.metas as T);
      if (method === "session.events") return Promise.resolve((this.rows.get(p.sessionId ?? "") ?? []) as T);
      if (method === "session.notes.get") return Promise.resolve({ text: this.notes.get(p.sessionId ?? "") ?? "", updatedAt: null, path: null } as T);
      if (method === "batch.get") return Promise.resolve(batch as T);
      if (method === "batch.setRules") return Promise.resolve({ ...batch, rules: (params as { rules: unknown }).rules } as T);
      if (method === "batch.archive") return Promise.resolve({ archived: [] } as T);
      if (method === "batch.adopt") return Promise.resolve(batch as T);
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
  startThread: vi.fn(async () => ({ id: "new" })),
  link: new FakeLink(),
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
    link: () => link,
    linkOf: () => link,
    primaryEnvironmentId: "local",
    onLink: (listener: (link: unknown, event: string) => void) => {
      listener(link, "added");
      return () => {};
    },
  },
}));
vi.mock("../../lib/connection/status", () => ({
  useEnvironments: () => [{ id: "local", name: "This Mac" }],
}));
vi.mock("../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/commands")>()),
  startThread: (...args: unknown[]) => startThread(...(args as [])),
}));
vi.mock("../../chrome/ModelPicker", () => ({ ModelPicker: () => <span data-model-picker /> }));
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
  SplitShell: ({ board, chat }: { board: React.ReactNode; chat: React.ReactNode }) => (
    <div>
      <div data-board>{board}</div>
      <div data-chat>{chat}</div>
    </div>
  ),
}));

import { sessionStore } from "../../lib/tcserver/store";
import { resetNotesStore } from "../../lib/threadNotes";
import { MasterView } from "./MasterView";

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

const flush = (): Promise<void> => act(() => new Promise((r) => setTimeout(r, 0)));

const rows = (sessionId: string, events: AgentEvent[]): EventRow[] =>
  events.map((event, i) => ({ sessionId, seq: i + 1, ts: 1_000 + i, event }));

beforeEach(() => {
  sessionStore.reset();
  resetNotesStore();
  link.calls = [];
  link.rows.clear();
  link.notes.clear();
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

describe("the master view", () => {
  it("paints the chat alone until the first child", async () => {
    seed([]);
    render(<MasterView {...props} />);
    await flush();
    expect(screen.getByTestId("chat")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.queryByRole("button", { name: /Thread/ })).toBeNull();
  });

  it("groups the rows into the non-empty sections with their counts, nothing in the title bar", async () => {
    seed([
      meta({ id: "c-wait", title: "Live Activity strip", status: "waiting", createdAt: 3 }),
      meta({ id: "c-run", title: "Home screen", status: "running", createdAt: 1, activity: "Running ios:test:client" }),
      meta({ id: "c-queued", title: "Inbox swipe", status: "queued", createdAt: 4, activity: "Queued · waiting for Home", after: "c-run" }),
      meta({ id: "c-done", title: "Design foundations", status: "idle", createdAt: 2, updatedAt: new Date(2026, 9, 21, 12, 8).getTime() }),
    ]);
    render(<MasterView {...props} />);
    await flush();
    const sections = screen.getAllByRole("region").map((s) => s.getAttribute("data-group"));
    expect(sections).toEqual(["needsYou", "running", "queued", "done"]);
    expect(within(screen.getByRole("region", { name: "Running" })).getByRole("heading").textContent).toBe("Running1");
    expect(screen.queryByText(/needs you/)).toBeNull();
    // Line two: the activity for a running row, the scheduler's note for a queued one, when a landed one landed.
    expect(screen.getByText("Running ios:test:client")).toBeTruthy();
    expect(screen.getByText("Queued · waiting for Home")).toBeTruthy();
    expect(screen.getByText("Landed 12:08")).toBeTruthy();
    // The model at the right of line two: the name, then effort and context, no dots between them.
    expect(screen.getAllByText("Claude Opus 5.5")).toHaveLength(4);
    expect(screen.getAllByText("high 1M")).toHaveLength(4);
    expect(screen.getAllByText("Implementation")).toHaveLength(4);
    expect(screen.queryByText(/·/, { selector: "[data-model]" })).toBeNull();
    // No host word: every child is on the master's host.
    expect(screen.queryByText("This Mac")).toBeNull();
  });

  it("draws no section that is empty", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    expect(screen.getByRole("region", { name: "Running" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Queued" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  });

  it("an implementation row carries its tally and its task list; chat and plan rows carry only two lines", async () => {
    seed([
      meta({ id: "c-impl", title: "Home screen", status: "running" }),
      meta({ id: "c-chat", title: "A question", status: "running", threadType: "chat" }),
      meta({ id: "c-plan", title: "Search plan", status: "running", threadType: "planning" }),
    ]);
    const todos = [
      { content: "Read the brief", status: "completed" },
      { content: "Write the view", status: "in_progress" },
      { content: "Tests", status: "pending" },
    ];
    for (const id of ["c-impl", "c-chat", "c-plan"]) {
      link.rows.set(id, rows(id, [{ type: "user-text", text: "go" }, { type: "tool-call", callId: "t1", name: "TodoWrite", input: { todos } }]));
    }
    render(<MasterView {...props} />);
    await flush();
    await flush();
    const impl = screen.getByRole("button", { name: /Home screen/ });
    expect(within(impl).getByText("1/3")).toBeTruthy();
    const tasks = within(impl).getAllByRole("listitem");
    expect(tasks.map((t) => t.getAttribute("data-task-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(tasks.map((t) => t.textContent)).toEqual(["Read the brief", "Write the view", "Tests"]);
    for (const title of [/A question/, /Search plan/]) {
      const row = screen.getByRole("button", { name: title });
      expect(within(row).queryByRole("list")).toBeNull();
      expect(within(row).getByText("1/3")).toBeTruthy();
    }
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("a done implementation folds its task list behind the tally; the tally's chevron opens it without opening the thread", async () => {
    seed([meta({ id: "c-fold", title: "Home screen", status: "running" }), meta({ id: "c-folded", title: "Foundations", status: "idle" })]);
    const todos = [
      { content: "Read the brief", status: "completed" },
      { content: "Tests", status: "completed" },
    ];
    for (const id of ["c-fold", "c-folded"]) {
      link.rows.set(id, rows(id, [{ type: "user-text", text: "go" }, { type: "tool-call", callId: "t1", name: "TodoWrite", input: { todos } }]));
    }
    render(<MasterView {...props} />);
    await flush();
    await flush();
    const running = screen.getByRole("button", { name: /Home screen/ });
    expect(running.getAttribute("data-tasks-open")).toBe("true");
    expect(within(running).getAllByRole("listitem")).toHaveLength(2);
    const done = screen.getByRole("button", { name: /Foundations/ });
    expect(done.getAttribute("data-tasks-open")).toBe("false");
    expect(within(done).getByText("2/2")).toBeTruthy();
    expect(within(done).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    // Folded: the list is in the DOM but hidden from readers and the tab order.
    expect(within(done).queryAllByRole("listitem")).toHaveLength(0);
    expect(done.querySelector("[data-tasks]")?.getAttribute("aria-hidden")).toBe("true");
    const toggle = within(done).getByRole("button", { name: "Show tasks" });
    fireEvent.click(toggle);
    expect(done.getAttribute("data-tasks-open")).toBe("true");
    expect(within(done).getAllByRole("listitem")).toHaveLength(2);
    expect(within(done).getByRole("button", { name: "Hide tasks" }).getAttribute("aria-expanded")).toBe("true");
    // The toggle never opened the child's view.
    expect(document.querySelector("[data-child-pane]")).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: "Hide tasks" }));
    expect(done.getAttribute("data-tasks-open")).toBe("false");
  });

  it("research and orchestration rows carry a summary: the notes' State line, else the latest words", async () => {
    seed([
      meta({ id: "c-res", title: "Pricing survey", status: "running", threadType: "research" }),
      meta({ id: "c-orc", title: "The fleet", status: "running", threadType: "orchestration" }),
    ]);
    link.notes.set("c-res", "## Goal\n\nx\n\n## State\n\nThree sources read, two to go\n");
    link.rows.set(
      "c-orc",
      rows("c-orc", [
        { type: "user-text", text: "go" },
        { type: "assistant-text", text: "Spawned three implementers.", delta: false, msgId: "a", blockIndex: 0 },
        { type: "tool-call", callId: "t1", name: "Bash", input: { command: "bun test" } },
      ]),
    );
    render(<MasterView {...props} />);
    await flush();
    await flush();
    expect(within(screen.getByRole("button", { name: /Pricing survey/ })).getByText("Three sources read, two to go")).toBeTruthy();
    const fleet = screen.getByRole("button", { name: /The fleet/ });
    expect(fleet.querySelector("[data-summary]")?.textContent).toBe("Spawned three implementers.");
    expect(link.calls.filter((c) => c.method === "session.notes.get")).toHaveLength(2);
  });

  it("a plan and the build it started are one row, keeping the plan's title", async () => {
    seed([
      meta({ id: "c-plan", title: "Search screen", status: "idle", threadType: "planning", archived: true, implementationId: "c-build", createdAt: 1 }),
      meta({ id: "c-build", title: "Search: the results screen", status: "running", planThreadId: "c-plan", createdAt: 5 }),
      meta({ id: "c-other", title: "Inbox", status: "running", createdAt: 3 }),
    ]);
    render(<MasterView {...props} />);
    await flush();
    const titles = screen.getAllByRole("button", { name: /Search|Inbox/ }).map((b) => b.textContent?.split(/Implementation/)[0]);
    expect(titles).toEqual(["Search screen", "Inbox"]);
    expect(screen.queryByText("Search: the results screen")).toBeNull();
    const row = screen.getByRole("button", { name: /Search screen/ }).closest("[data-plan]");
    expect(row?.getAttribute("data-plan")).toBe("c-plan");
    expect(row?.getAttribute("data-type")).toBe("implementation");
  });

  it("a row opens its thread's full view in the board's place, and Back or Escape returns to the board where it was", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" }), meta({ id: "c-two", title: "Inbox", status: "running" })]);
    render(<MasterView {...props} />);
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
    expect(document.querySelector("[data-transcript='c-run']")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Back/ }).getAttribute("title")).toBe("Back to the board (Esc)");
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
    render(<MasterView {...props} />);
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
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Thread/ }));
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

  it("the child pane's line sends into the thread, and Message lands in it", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "idle" })]);
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await flush();
    const field = screen.getByLabelText("Message this thread");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Ship it" } });
    fireEvent.submit(field.closest("form")!);
    await flush();
    expect(link.calls.some((c) => c.method === "session.send" && (c.params as { text: string }).text === "Ship it")).toBe(true);
  });

  it("reads batch.get into the foot: the rules sentence first, then the console of the running step", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    expect(link.calls.some((c) => c.method === "batch.get" && (c.params as { masterId: string }).masterId === "m")).toBe(true);
    const foot = document.querySelector("[data-batch-foot]")!;
    expect(within(foot as HTMLElement).getByText("When the threads are done")).toBeTruthy();
    expect(foot.querySelector("[data-rules]")?.textContent).toBe("Branches land as they finish, then Gate and Release. Then you are notified.");
    // The gate runs, so the foot is a console: the landed step above it with its time, the release still ahead.
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
    const console_ = foot.querySelector("[data-console='gate']")!;
    expect(within(console_ as HTMLElement).getByText("Merging").closest("li")?.getAttribute("data-step-status")).toBe("passed");
    expect(within(console_ as HTMLElement).getByText("Merging").closest("li")?.querySelector("[data-step-time]")?.textContent).toBe("2m");
    expect(within(console_ as HTMLElement).getByText("Release").closest("li")?.getAttribute("data-step-status")).toBe("pending");
    expect(console_.querySelector("[data-progress]")?.textContent).toBe("3 of 7 vitest");
    expect(console_.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("43");
    expect(console_.querySelector("[data-log]")?.textContent).toBe("✓ typecheck 12s\nvitest: 3 of 7 files");
  });

  it("the running step's clock ticks every second from startedAt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(batch.steps[1].startedAt! + 65_000);
      seed([meta({ id: "c-run", title: "Home", status: "running" })]);
      render(<MasterView {...props} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const head = () => document.querySelector("[data-console-head] [data-step-time]")?.textContent;
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
    render(<MasterView {...props} />);
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
    const foot = document.querySelector("[data-batch-foot]") as HTMLElement;
    fireEvent.click(within(foot).getByRole("button", { name: "Stop" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.stopStep")?.params).toEqual({ masterId: "m", stepId: "gate" });
  });

  it("the foot grows to the console when a step starts and shrinks back to the row when every step is done", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    const foot = () => document.querySelector("[data-batch-foot]")!;
    const pushSteps = (steps: unknown[]) =>
      act(() => {
        link.push({ push: "batch", state: { ...batch, steps } } as unknown as ServerPush);
      });
    const t = batch.steps[1].startedAt!;
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "pending", detail: "", at: null, log: [] },
      { id: "release", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("idle");
    const row = foot().querySelector("[data-steps-row]")!;
    expect([...row.querySelectorAll("li")].map((li) => `${li.getAttribute("data-step")}:${li.getAttribute("data-step-status")}`)).toEqual(["land:passed", "gate:pending", "release:pending"]);
    expect(row.querySelector("[data-step='land'] [data-step-time]")?.textContent).toBe("2m");
    expect(foot().querySelector("[data-console]")).toBeNull();
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "running", detail: "", at: 2, startedAt: t, log: ["starting"] },
      { id: "release", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("console");
    expect(foot().querySelector("[data-console='gate']")).toBeTruthy();
    pushSteps([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "gate", status: "passed", detail: "", at: 3, startedAt: t, endedAt: t + 252_000, log: ["starting", "done"] },
      { id: "release", status: "passed", detail: "release-278", at: 4, startedAt: t + 252_000, endedAt: t + 260_000 },
    ]);
    expect(foot().getAttribute("data-foot-mode")).toBe("idle");
    expect(foot().querySelector("[data-console]")).toBeNull();
    expect([...foot().querySelectorAll("[data-steps-row] [data-step-time]")].map((e) => e.textContent)).toEqual(["2m", "4m 12s", "8s"]);
  });

  it("the steps are the master's list in order: a shell step reads by its name idle, and runs in the same console with its command", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    const rules = {
      land: "as-they-finish",
      then: "notify",
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
    expect(foot.querySelector("[data-rules]")?.textContent).toBe("Branches land as they finish, then Build the plugin and Deploy to dev. Then you are notified.");
    expect(within(foot as HTMLElement).getByText("Build, deploy to dev, smoke")).toBeTruthy();
    // The row names every step of the list in order, the one the host has not seen yet pending at the end.
    expect([...foot.querySelectorAll("[data-steps-row] li")].map((li) => `${li.getAttribute("data-step")}:${li.getAttribute("data-step-status")}:${li.textContent}`)).toEqual([
      "land:passed:Merging2m",
      "build:pending:Build the plugin",
      "deploy-dev:pending:Deploy to dev",
    ]);
    push([
      { id: "land", status: "passed", detail: "", at: 1, startedAt: t - 120_000, endedAt: t },
      { id: "build", status: "running", detail: "", at: 2, startedAt: t, log: ["> gradle build", "BUILD SUCCESSFUL"] },
      { id: "deploy-dev", status: "pending", detail: "", at: null, log: [] },
    ]);
    expect(foot.getAttribute("data-foot-mode")).toBe("console");
    const console_ = foot.querySelector("[data-console='build']")!;
    const head = console_.querySelector("[data-console-head]")!;
    expect(within(head as HTMLElement).getByText("Build the plugin")).toBeTruthy();
    expect(head.querySelector("[data-step-run]")?.textContent).toBe("gradle build");
    expect(console_.querySelector("[data-log]")?.textContent).toBe("> gradle build\nBUILD SUCCESSFUL");
    expect(within(console_ as HTMLElement).getByText("Deploy to dev").closest("li")?.getAttribute("data-step-status")).toBe("pending");
    fireEvent.click(within(foot as HTMLElement).getByRole("button", { name: "Stop" }));
    await flush();
    expect(link.calls.find((c) => c.method === "batch.stopStep")?.params).toEqual({ masterId: "m", stepId: "build" });
  });

  it("a failed step stays open with its last lines and the failure in red until Hide", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
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
    const head = foot.querySelector("[data-console-head]")!;
    expect(head.textContent).toContain("Gatefailed30s");
    expect(foot.querySelector("[data-log] .text-danger")?.textContent).toBe("FAILED at vitest");
    expect(within(foot as HTMLElement).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(foot.querySelector("[data-console]") as HTMLElement).getByText("Release").closest("li")?.textContent).toBe("Releaseskipped");
    expect(foot.querySelector("[data-steps-row]")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(within(foot as HTMLElement).getByRole("button", { name: "Hide" }));
    expect(foot.getAttribute("data-foot-mode")).toBe("idle");
    expect(foot.querySelector("[data-steps-row] [data-step='gate']")?.getAttribute("data-step-status")).toBe("failed");
  });

  it("Edit opens the rules: the steps reorder, a built-in and a shell step are added, one is removed, and Save writes the list", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    const ids = () => [...dialog.querySelectorAll("[data-rule-step]")].map((li) => li.getAttribute("data-rule-step"));
    expect(ids()).toEqual(["land", "gate", "release"]);
    expect(within(dialog).getByRole("button", { name: "Move Merging up" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Release up" }));
    expect(ids()).toEqual(["land", "release", "gate"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Gate" }));
    expect(ids()).toEqual(["land", "release"]);
    // A built-in kind lands at once with its name.
    fireEvent.change(within(dialog).getByLabelText("Add a step"), { target: { value: "deploy" } });
    expect(ids()).toEqual(["land", "release", "deploy"]);
    // A shell step asks for a name and a command first; Add stays off until both are there.
    fireEvent.change(within(dialog).getByLabelText("Add a step"), { target: { value: "shell" } });
    const addStep = within(dialog).getByRole("button", { name: "Add step" });
    expect(addStep.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Step name"), { target: { value: "Smoke test" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "bun run smoke" } });
    fireEvent.change(within(dialog).getByLabelText("Working directory"), { target: { value: "/srv/plugin" } });
    fireEvent.click(addStep);
    expect(ids()).toEqual(["land", "release", "deploy", "shell"]);
    expect(dialog.querySelector("[data-rule-step='shell'] [data-rule-line]")?.textContent).toBe("bun run smoke");
    fireEvent.change(within(dialog).getByLabelText("Step 3 name"), { target: { value: "Deploy to the box" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "All at once" }));
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
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Step 2 name"), { target: { value: " " } });
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("the add sheet creates the thread under the master with the brief as its first message", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Thread/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add a thread to iOS batch 2")).toBeTruthy();
    // The brief has focus; every effort of the model's own ladder is offered.
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Brief"));
    expect(within(dialog).getAllByRole("radio", { name: /Low|Medium|High|Max/ }).length).toBeGreaterThanOrEqual(3);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Plan" }));
    fireEvent.change(within(dialog).getByLabelText("After"), { target: { value: "c-run" } });
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
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("a queued row offers Start now and Remove from queue in place of the live actions", async () => {
    seed([meta({ id: "c-q", title: "Inbox", status: "queued", activity: "Queued · waiting for Home", after: "c-run" })]);
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));
    await flush();
    expect(link.calls.some((c) => c.method === "session.start" && (c.params as { sessionId: string }).sessionId === "c-q")).toBe(true);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove from queue" }));
    await flush();
    const stop = link.calls.find((c) => c.method === "session.batch");
    expect(stop?.params).toMatchObject({ action: "stop", ids: ["c-q"] });
  });
});
