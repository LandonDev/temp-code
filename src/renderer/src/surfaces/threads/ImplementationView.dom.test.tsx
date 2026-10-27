// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../../lib/session";
import type { TodoItem } from "../../lib/tcserver/todos";

vi.mock("../../hooks/usePlanFile", () => ({ usePlanFile: () => null }));
vi.mock("../../lib/tcserver/store", () => ({ useLiveEdits: () => ({}) }));
vi.mock("../../lib/threads/agents", () => ({ useMetaById: () => null }));
vi.mock("../../lib/models", () => ({ resolveModel: (_h: string, m: string) => ({ name: m }) }));
vi.mock("../AgentMarkdown", () => ({ AgentMarkdown: ({ text }: { text: string }) => <div data-md>{text}</div> }));
vi.mock("../../chrome/FilePreview", () => ({
  FilePreview: ({ preview }: { preview: { path: string } }) => <div data-file-preview={preview.path} />,
}));
vi.mock("./fleet/AgentDetail", () => ({ AgentDetail: () => null }));
vi.mock("./SplitShell", () => ({
  SplitShell: (p: {
    board: React.ReactNode;
    chat: React.ReactNode;
    title?: React.ReactNode;
    hasBoard: boolean;
    collapsed: boolean;
    onToggleChat: (open: boolean) => void;
  }) => (
    <div data-collapsed={String(p.collapsed)}>
      <header data-view-header>{p.title}</header>
      <button type="button" onClick={() => p.onToggleChat(false)}>
        fold
      </button>
      {p.hasBoard ? <div data-board>{p.board}</div> : null}
    </div>
  ),
}));

import { ImplementationView } from "./ImplementationView";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

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
});
