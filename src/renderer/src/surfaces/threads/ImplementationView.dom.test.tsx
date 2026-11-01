// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../lib/session";
import type { TodoItem } from "../../lib/tcserver/todos";

vi.mock("../../hooks/usePlanFile", () => ({ usePlanFile: () => null }));
let liveEdits: Record<string, unknown> = {};
vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/store")>()),
  useLiveEdits: () => liveEdits,
}));
vi.mock("../../lib/taskListWidth", async (original) => ({
  ...(await original<typeof import("../../lib/taskListWidth")>()),
  canvasMeasure: () => (text: string) => text.length * 6,
}));
let metaById: Record<string, unknown> = {};
vi.mock("../../lib/threads/agents", () => ({ useMetaById: (id: string | null) => (id ? (metaById[id] ?? null) : null) }));
// FileRefMenu asks the native bridge which editor opens a file; jsdom has none.
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("../../lib/threadMentions", async (original) => ({
  ...(await original<typeof import("../../lib/threadMentions")>()),
  useTitlesOf: () => (id: string) => (id === "agent-7" ? "Fit worker" : undefined),
}));
vi.mock("../../lib/models", () => ({ resolveModel: (_h: string, m: string) => ({ name: m }) }));
vi.mock("../AgentMarkdown", async () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-md>{text}</div>,
  SelectSessionContext: (await import("react")).createContext<((id: string) => void) | undefined>(undefined),
}));
vi.mock("../../chrome/FilePreview", () => ({
  FilePreview: ({ preview }: { preview: { path: string } }) => <div data-file-preview={preview.path} />,
}));
vi.mock("./fleet/AgentDetail", () => ({ AgentDetail: ({ agentId }: { agentId: string }) => <div data-agent-detail={agentId} /> }));
vi.mock("./SplitShell", () => ({
  SplitShell: (p: {
    board: React.ReactNode;
    chat: React.ReactNode;
    title?: React.ReactNode;
    actions?: React.ReactNode;
    hasBoard: boolean;
    collapsed: boolean;
    onToggleChat: (open: boolean) => void;
    fit?: number;
  }) => (
    <div data-collapsed={String(p.collapsed)} data-fit={p.fit ?? ""}>
      <header data-view-header>
        {p.title}
        {p.actions}
      </header>
      <button type="button" onClick={() => p.onToggleChat(false)}>
        fold
      </button>
      {p.hasBoard ? <div data-board>{p.board}</div> : null}
    </div>
  ),
}));

import { resetChatFolds } from "../../lib/chatFold";
import { ImplementationView } from "./ImplementationView";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  resetChatFolds();
  metaById = {};
});

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });
const edit = (id: string, path: string, todoIx: number, round = 0): Block =>
  ({
    id,
    role: "tool",
    text: "",
    round,
    todo: todoIx,
    ts: 1_000,
    doneTs: 1_010,
    tool: { kind: "edit", name: "Edit", preview: { path, additions: 4, deletions: 1, lines: [] } },
  }) as unknown as Block;

const session = (over: { blocks: Block[]; todos: TodoItem[]; rounds?: TodoItem[][]; status?: string }): Session =>
  ({
    id: "impl",
    environmentId: "local",
    harness: "claude",
    title: "Build the thing",
    cwd: "/repo",
    status: over.status ?? "idle",
    loaded: true,
    blocks: over.blocks,
    thread: { todos: over.todos, rounds: over.rounds ?? [], costs: [], usage: [], stopped: false, activeTodo: -1, round: 0 },
  }) as unknown as Session;

const view = (s: Session, extra: Record<string, unknown> = {}) => {
  const props = {
    session: s,
    renderChat: () => <div data-chat />,
    onOpenFile: vi.fn(),
    onOpenDiff: vi.fn(),
    onArmNewPass: vi.fn(),
    composing: false,
    ...extra,
  };
  render(<ImplementationView {...(props as unknown as Parameters<typeof ImplementationView>[0])} />);
  return props;
};

const first = { id: "u0", role: "user", text: "Build the thing\nmore", round: 0 } as Block;

describe("the implementation header", () => {
  it("links back to the planning thread with the plan type's tinted glyph", () => {
    metaById = { plan1: { id: "plan1", title: "The plan", archived: false } };
    const s = { ...session({ blocks: [first], todos: [] }), planThreadId: "plan1" } as Session;
    const props = view(s, { onOpenSession: vi.fn() });
    const link = screen.getByRole("button", { name: "Open the planning thread" });
    expect(link.querySelector("svg[data-type-glyph]")?.getAttribute("class")).toContain("text-type-planning");
    fireEvent.click(link);
    expect(props.onOpenSession).toHaveBeenCalledWith("plan1");
  });
});

describe("the implementation board", () => {
  it("is one TaskList and the changes, with no Subagents section and no inline colours", () => {
    view(
      session({
        status: "running",
        blocks: [first, edit("e", "src/a.ts", 0)],
        todos: [todo("Write a", "in_progress"), todo("Write b", "pending")],
      }),
    );
    expect(document.querySelectorAll('[data-slot="task-list"]')).toHaveLength(1);
    expect(screen.queryByText("Subagents")).toBeNull();
    expect(screen.getByText("Changes")).toBeTruthy();
    expect((document.querySelector("[data-view-header]") as HTMLElement).textContent).toBe("Build the thing");
    for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
      expect(el.style.background).toBe("");
      expect(el.style.backgroundColor).toBe("");
    }
  });

  it("ends a done task's row in its time and shows the running task's label whole", () => {
    const run = (id: string, todoIx: number, ts: number, doneTs?: number) =>
      ({ id, role: "tool", text: "", round: 0, todo: todoIx, ts, doneTs, tool: { kind: "execute", name: "Bash" } }) as unknown as Block;
    const long = "Run the publish gate beside the electron-vite build so the upload starts sooner";
    view(
      session({
        status: "running",
        blocks: [first, run("a", 0, 0, 12_000), run("b", 1, 12_000)],
        todos: [todo("Read the brief", "completed"), todo(long, "in_progress")],
      }),
    );
    const rows = document.querySelectorAll('[data-slot="task-list"] li');
    expect(rows[0].querySelector(".tabular-nums")?.textContent).toBe("12s");
    const label = rows[1].querySelector<HTMLElement>(".task-label")!;
    expect(label.textContent).toBe(long);
    expect(label.className).not.toContain("truncate");
  });

  it("the chat's fold survives the view unmounting, as a tab switch does", () => {
    const running = session({ status: "running", blocks: [first], todos: [todo("Write a", "in_progress")] });
    view(running);
    fireEvent.click(screen.getByRole("button", { name: "fold" }));
    cleanup();
    view(running);
    expect(document.querySelector("[data-collapsed]")?.getAttribute("data-collapsed")).toBe("true");
  });

  it("a remembered fold still opens for a question waiting at the remount", () => {
    view(session({ status: "running", blocks: [first], todos: [todo("Clean", "in_progress")] }));
    fireEvent.click(screen.getByRole("button", { name: "fold" }));
    cleanup();
    view(
      session({
        status: "waiting",
        blocks: [first, { id: "ap", role: "tool", text: "", round: 0, tool: { title: "Bash: rm -rf dist" }, approval: { requestId: 1 } } as unknown as Block],
        todos: [todo("Clean", "in_progress")],
      }),
    );
    expect(document.querySelector("[data-collapsed]")?.getAttribute("data-collapsed")).toBe("false");
  });

  it("a needs-you line opens the chat", () => {
    view(
      session({
        status: "waiting",
        blocks: [first, { id: "ap", role: "tool", text: "", round: 0, tool: { title: "Bash: rm -rf dist" }, approval: { requestId: 1 } } as unknown as Block],
        todos: [todo("Clean", "in_progress")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "fold" }));
    expect(document.querySelector("[data-collapsed]")?.getAttribute("data-collapsed")).toBe("true");
    const line = screen.getByRole("button", { name: /Needs you.*Bash: rm -rf dist/ });
    fireEvent.click(line);
    expect(document.querySelector("[data-collapsed]")?.getAttribute("data-collapsed")).toBe("false");
  });

  it("a file row opens its preview, and Open diff opens the diff", async () => {
    const props = view(session({ blocks: [first, edit("e", "src/a.ts", 0)], todos: [todo("Write a", "in_progress")] }));
    expect(screen.getByText("Write a", { selector: "h4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
    await act(async () => {});
    expect(document.querySelector('[data-file-preview="src/a.ts"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open diff" }));
    expect(props.onOpenDiff).toHaveBeenCalledWith("src/a.ts");
  });

  it("a finished pass offers Start pass 2, which arms the new pass", () => {
    const props = view(
      session({
        blocks: [first, edit("e", "src/a.ts", 0), { id: "z", role: "assistant", text: "All done.", round: 0 } as Block],
        todos: [todo("Write a", "completed")],
      }),
    );
    expect(document.querySelector("[data-md]")?.textContent).toBe("All done.");
    fireEvent.click(screen.getByRole("button", { name: "Start pass 2" }));
    expect(props.onArmNewPass).toHaveBeenCalledWith(true);
  });

  it("an earlier pass folds into a row that opens its tasks and changes", async () => {
    view(
      session({
        status: "running",
        blocks: [
          first,
          edit("e0", "src/a.ts", 0, 0),
          { id: "u1", role: "user", text: "Now test it", round: 1 } as Block,
          edit("e1", "src/a.test.ts", 0, 1),
        ],
        rounds: [[todo("Write a", "completed")]],
        todos: [todo("Test a", "in_progress")],
      }),
    );
    const pass = screen.getByRole("button", { name: /Pass 1/ });
    expect(pass.textContent).toContain("Build the thing");
    expect(pass.textContent).toContain("1/1");
    expect(screen.getByText("Now test it")).toBeTruthy();
    expect(document.querySelector('[data-change-row="src/a.ts"]')).toBeNull();
    fireEvent.click(pass);
    await act(async () => {});
    expect(document.querySelector('[data-change-row="src/a.ts"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="task-list"]')).toHaveLength(2);
  });

  it("an earlier pass keeps the shell's changes under the task that made them", async () => {
    liveEdits = {
      "gen/out.ts": { path: "gen/out.ts", kind: "changed", adds: 3, dels: 0, diff: "@@ -1 +1 @@\n-a\n+b", state: "settled", startedTs: 1_005, ts: 1_100 },
    };
    view(
      session({
        status: "running",
        blocks: [
          first,
          { id: "sh", role: "tool", text: "", round: 0, todo: 0, ts: 1_000, doneTs: 2_000, tool: { name: "Bash" } } as unknown as Block,
          edit("e0", "src/a.ts", 0, 0),
          { id: "u1", role: "user", text: "Now test it", round: 1 } as Block,
          edit("e1", "src/a.test.ts", 0, 1),
        ],
        rounds: [[todo("Write a", "completed")]],
        todos: [todo("Test a", "in_progress")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Pass 1/ }));
    await act(async () => {});
    expect(document.querySelector('[data-change-row="gen/out.ts"]')).toBeTruthy();
    liveEdits = {};
  });
});

describe("the fitted column and the running task's steps", () => {
  const run = (id: string, todoIx: number, command: string): Block =>
    ({
      id,
      role: "tool",
      text: "Bash",
      round: 0,
      todo: todoIx,
      tool: { kind: "execute", name: "Bash", title: "Bash", status: "completed", callId: id, input: { command } },
    }) as unknown as Block;
  const read = (id: string, todoIx: number, path: string): Block =>
    ({
      id,
      role: "tool",
      text: "Read",
      round: 0,
      todo: todoIx,
      tool: { kind: "read", name: "Read", title: "Read", status: "completed", callId: id, input: { file_path: path } },
    }) as unknown as Block;
  const two = (a: TodoItem["status"], b: TodoItem["status"]) => [todo("Fit the column", a), todo("Docs", b)];
  const props = () => ({
    renderChat: () => <div data-chat />,
    onOpenFile: vi.fn(),
    onOpenDiff: vi.fn(),
    onArmNewPass: vi.fn(),
    composing: false,
  });
  // Each test its own thread: a step list closed by hand is remembered per thread.
  let thread = 0;
  const mount = (first: Session) => {
    const id = `impl-steps-${String(++thread)}`;
    const p = props();
    const el = (s: Session) => <ImplementationView {...({ ...p, session: { ...s, id } } as unknown as Parameters<typeof ImplementationView>[0])} />;
    const r = render(el(first));
    const again = (next: Session) => r.rerender(el(next));
    return { p, again };
  };
  const rowOf = (label: string) => [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(label))!;
  const stepsUnder = (label: string) => rowOf(label).querySelector("[data-task-detail][data-open] [data-task-steps]");

  it("passes the task list's reported width to the shell as the fitted column", () => {
    mount(session({ status: "running", blocks: [first], todos: two("in_progress", "pending") }));
    const fit = Number(document.querySelector("[data-fit]")!.getAttribute("data-fit"));
    expect(fit).toBeGreaterThanOrEqual(320);
  });

  it("shows the running task's last three steps as the transcript's rows, a fourth dropping the oldest", () => {
    const blocks = [first, run("a", 0, "ls alpha"), run("b", 0, "ls beta"), run("c", 0, "ls gamma")];
    const { again } = mount(session({ status: "running", blocks, todos: two("in_progress", "pending") }));
    const steps = stepsUnder("Fit the column")!;
    expect(steps.children).toHaveLength(3);
    expect(steps.textContent).toContain("alpha");
    again(session({ status: "running", blocks: [...blocks, run("d", 0, "ls delta")], todos: two("in_progress", "pending") }));
    const now = stepsUnder("Fit the column")!;
    expect(now.textContent).not.toContain("alpha");
    expect(now.textContent).toContain("delta");
    expect(rowOf("Docs").querySelector("[data-task-steps]")).toBeNull();
  });

  it("folds the finished task's steps and opens the next task's", () => {
    const blocks = [first, run("a", 0, "ls alpha")];
    const { again } = mount(session({ status: "running", blocks, todos: two("in_progress", "pending") }));
    again(session({ status: "running", blocks: [...blocks, run("b", 1, "ls omega")], todos: two("completed", "in_progress") }));
    expect(stepsUnder("Fit the column")).toBeNull();
    expect(stepsUnder("Docs")?.textContent).toContain("omega");
  });

  it("stays shut when closed by hand while the task runs, and the next task opens on its own", () => {
    const blocks = [first, run("a", 0, "ls alpha")];
    const { again } = mount(session({ status: "running", blocks, todos: two("in_progress", "pending") }));
    fireEvent.click(rowOf("Fit the column").querySelector("[data-slot='collapsible-trigger']")!);
    again(session({ status: "running", blocks: [...blocks, run("b", 0, "ls")], todos: two("in_progress", "pending") }));
    expect(stepsUnder("Fit the column")).toBeNull();
    again(session({ status: "running", blocks: [...blocks, run("b", 0, "ls"), run("c", 1, "ls omega")], todos: two("completed", "in_progress") }));
    expect(stepsUnder("Docs")?.textContent).toContain("omega");
  });

  it("opens a step's file as the chat does", () => {
    const { p } = mount(session({ status: "running", blocks: [first, read("r", 0, "/repo/src/a.ts")], todos: two("in_progress", "pending") }));
    const steps = stepsUnder("Fit the column")!;
    const target = [...steps.querySelectorAll<HTMLElement>("button, a")].find((el) => el.textContent?.includes("a.ts"));
    fireEvent.click(target ?? steps.querySelector<HTMLElement>("button")!);
    expect(p.onOpenFile).toHaveBeenCalled();
  });

  it("opens a subagent's detail from its step, as the chat does", () => {
    const check = {
      id: "k",
      role: "tool",
      text: "check_agent",
      round: 0,
      todo: 0,
      tool: { kind: "other", name: "mcp__orchestrator__check_agent", title: "check_agent", status: "completed", callId: "k", input: { agentId: "agent-7" } },
    } as unknown as Block;
    mount(session({ status: "running", blocks: [first, check], todos: two("in_progress", "pending") }));
    const steps = stepsUnder("Fit the column")!;
    fireEvent.click(within(steps as HTMLElement).getByText("Fit worker"));
    expect(document.querySelector("[data-agent-detail]")?.getAttribute("data-agent-detail")).toBe("agent-7");
  });

  it("leaves a waiting approval to the Needs you line alone", () => {
    const ask = { ...run("w", 0, "rm -rf dist"), approval: { requestId: "r1" } } as Block;
    mount(session({ status: "waiting", blocks: [first, run("a", 0, "ls alpha"), ask], todos: two("in_progress", "pending") }));
    expect(stepsUnder("Fit the column")?.textContent).not.toContain("rm -rf");
    expect(document.querySelectorAll("[data-task-steps]")).toHaveLength(1);
  });

  it("keeps the steps through a pause, and a settled pass has none", () => {
    const blocks = [first, run("a", 0, "ls alpha")];
    const { again } = mount(session({ status: "paused", blocks, todos: two("in_progress", "pending") }));
    expect(stepsUnder("Fit the column")?.textContent).toContain("alpha");
    again(session({ status: "idle", blocks, todos: two("in_progress", "pending") }));
    expect(stepsUnder("Fit the column")).toBeNull();
  });
});
