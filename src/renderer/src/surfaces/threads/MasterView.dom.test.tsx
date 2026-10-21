// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";
import type { Link } from "../../lib/tcserver/store";
import type { SessionMeta, ServerPush } from "../../lib/tcserver/types";

/**
 * The master view on a fixture batch: the sections, the foot from
 * `batch.get`, and the add sheet's `session.create`. The session store is
 * real, fed through one fake link; the chat and the heavy pickers are
 * stand-ins.
 */

const { startThread, batch } = vi.hoisted(() => ({
  startThread: vi.fn(async () => ({ id: "new" })),
  batch: {
    masterId: "m",
    steps: [
      { id: "land", status: "done", detail: "ios/foundations, ios/contract", at: 1 },
      { id: "gate", status: "running", detail: "typecheck · vitest · build", at: 2 },
      { id: "release", status: "pending", detail: "", at: null },
    ],
    landed: ["c-done"],
    pending: ["c-wait", "c-run", "c-queued"],
  },
}));

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  metas: Omit<SessionMeta, "environmentId">[] = [];
  calls: { method: string; params: unknown }[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") return Promise.resolve(this.metas as T);
    if (method === "session.events") return Promise.resolve([] as T);
    if (method === "batch.get") return Promise.resolve(batch as T);
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
const link = new FakeLink();

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
vi.mock("../../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: undefined, catalog: null }) }));
vi.mock("../../chrome/ModelPicker", () => ({ ModelPicker: () => <span data-model-picker /> }));
vi.mock("./SplitShell", () => ({
  SplitShell: ({ board, chat }: { board: React.ReactNode; chat: React.ReactNode }) => (
    <div>
      <div data-board>{board}</div>
      <div data-chat>{chat}</div>
    </div>
  ),
}));

import { sessionStore } from "../../lib/tcserver/store";
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

beforeEach(() => {
  sessionStore.reset();
  link.calls = [];
  startThread.mockClear();
});
afterEach(() => {
  cleanup();
  sessionStore.reset();
});

function seed(children: SessionMeta[]): void {
  const all = [meta({ id: "m", title: "iOS batch 2", cwd: "/repo", masterId: null as unknown as string, status: "idle" }), ...children];
  // The store's link for every row's commands (session.start, session.send).
  link.metas = all.map(({ environmentId: _e, ...wire }) => wire);
  sessionStore.attach(link);
  for (const c of all) sessionStore.adopt(c);
}

describe("the master view", () => {
  it("paints the chat alone until the first child", () => {
    seed([]);
    render(<MasterView {...props} />);
    expect(screen.getByTestId("chat")).toBeTruthy();
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.queryByRole("button", { name: /Thread/ })).toBeNull();
  });

  it("groups the children into the non-empty sections and counts them in the title bar", async () => {
    seed([
      meta({ id: "c-wait", title: "Live Activity strip", status: "waiting", createdAt: 3 }),
      meta({ id: "c-run", title: "Home screen", status: "running", createdAt: 1, activity: "Running ios:test:client" }),
      meta({ id: "c-queued", title: "Inbox swipe", status: "queued", createdAt: 4, activity: "Queued · waiting for Home", after: "c-run" }),
      meta({ id: "c-queued-2", title: "Settings row", status: "queued", createdAt: 5 }),
      meta({ id: "c-done", title: "Design foundations", status: "idle", createdAt: 2, updatedAt: new Date(2026, 9, 21, 12, 8).getTime() }),
    ]);
    render(<MasterView {...props} />);
    await flush();
    expect(screen.getByText("1 running · 1 needs you · 2 queued · 1 done")).toBeTruthy();
    const sections = screen.getAllByRole("region").map((s) => s.getAttribute("data-group"));
    expect(sections).toEqual(["needsYou", "running", "queued", "done"]);
    // The what line is the activity for a running row and the scheduler's note for a queued one.
    expect(screen.getByText("Running ios:test:client")).toBeTruthy();
    expect(screen.getByText("Queued · waiting for Home")).toBeTruthy();
    // The Queued label hints only because one row waits on the cap, not a sibling.
    expect(within(screen.getByRole("region", { name: "Queued" })).getByText("· starts as a slot frees")).toBeTruthy();
    // Type word and the model line.
    expect(screen.getAllByText("impl").length).toBe(5);
    expect(screen.getAllByText(/Opus 5.5 · high · 1M/).length).toBe(5);
    // A landed child's stats line says so.
    expect(screen.getByText("landed 12:08")).toBeTruthy();
    // No host word: every child is on the master's host.
    expect(screen.queryByText(/· This Mac/)).toBeNull();
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

  it("reads batch.get into the foot: the merged count and the three steps", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    expect(link.calls.some((c) => c.method === "batch.get" && (c.params as { masterId: string }).masterId === "m")).toBe(true);
    expect(screen.getByText("When the batch lands")).toBeTruthy();
    expect(screen.getByText("1 of 4 merged")).toBeTruthy();
    expect(screen.getByText("Merge queue").closest("li")?.getAttribute("data-step-status")).toBe("done");
    expect(screen.getByText("Gate once").closest("li")?.getAttribute("data-step-status")).toBe("running");
    expect(screen.getByText("typecheck · vitest · build")).toBeTruthy();
    expect(screen.getByText("Release").closest("li")?.getAttribute("data-step-status")).toBe("pending");
  });

  it("follows a batch push without another read", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    act(() => {
      link.push({
        push: "batch",
        state: { ...batch, landed: ["c-run", "x"], pending: [], steps: batch.steps.map((s) => ({ ...s, status: "done" })) },
      } as unknown as ServerPush);
    });
    expect(screen.getByText("2 of 2 merged")).toBeTruthy();
    expect(screen.getByText("Release").closest("li")?.getAttribute("data-step-status")).toBe("done");
  });

  it("the add sheet creates the thread under the master with the brief as its first message", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "running" })]);
    render(<MasterView {...props} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Thread/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add a thread to iOS batch 2")).toBeTruthy();
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
    // Nothing optimistic: the row arrives from the host's push (the closing
    // dialog's fading ghost still holds the text for 120 ms).
    expect(screen.queryByRole("button", { name: /Search: the results screen/ })).toBeNull();
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("a queued row offers Start now and Remove from queue in place of the live actions", async () => {
    seed([meta({ id: "c-q", title: "Inbox", status: "queued", activity: "Queued · 2nd in line" })]);
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

  it("a row unfolds in place with its message field, and the field sends into the child", async () => {
    seed([meta({ id: "c-run", title: "Home", status: "idle" })]);
    render(<MasterView {...props} />);
    await flush();
    const row = screen.getByRole("button", { name: /Home/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const field = screen.getByLabelText("Message this thread");
    fireEvent.change(field, { target: { value: "Ship it" } });
    fireEvent.submit(field.closest("form")!);
    await flush();
    expect(link.calls.some((c) => c.method === "session.send" && (c.params as { text: string }).text === "Ship it")).toBe(true);
    fireEvent.keyDown(row, { key: "Enter", metaKey: true });
    expect(props.onOpenSession).toHaveBeenCalledWith("c-run");
  });
});
