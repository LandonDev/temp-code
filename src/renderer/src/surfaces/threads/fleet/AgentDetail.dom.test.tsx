// @vitest-environment jsdom
/**
 * The agent detail is a right Sheet: the transcript waits for the slide in
 * to finish, every close plays the exit and then calls the parent once, and
 * the foot sends to an idle agent and steers a running one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../../lib/tcserver/types";

const h = vi.hoisted(() => ({
  metas: new Map<string, SessionMeta>(),
  send: vi.fn(async () => {}),
  steer: vi.fn(async () => {}),
}));

vi.mock("../../../lib/threads/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/threads/agents")>()),
  useMetaById: (id: string | null) => (id ? (h.metas.get(id) ?? null) : null),
  useSessionById: (id: string | null) => (id ? { id, blocks: [], busy: false, loaded: true, environmentId: "local", thread: { cost: 0.42, todos: [] } } : undefined),
}));
vi.mock("../../../lib/contextCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/contextCache")>()),
  useContextReading: () => null,
}));
vi.mock("../../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tcserver/commands")>()),
  send: h.send,
  steer: h.steer,
}));
vi.mock("../../AgentTranscript", () => ({
  AgentTranscript: (p: { onOpenFile?: (path: string) => void }) => (
    <div data-testid="transcript">
      <button type="button" onClick={() => p.onOpenFile?.("/srv/repo/a.ts")}>
        a.ts
      </button>
    </div>
  ),
}));

import { AgentDetail } from "./AgentDetail";

const agent = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id: "a1",
    parentId: "root",
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    agentType: "worker",
    title: "Port the view",
    cwd: "/srv/repo",
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    reasoning: "high",
    archived: false,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as SessionMeta;

/** One finite animation per element whose `finished` the test releases. */
let release: () => void = () => {};
const flags = globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean };
function holdAnimations() {
  // The dom setup turns Base UI's animation wait off; this test needs it on.
  flags.BASE_UI_ANIMATIONS_DISABLED = false;
  let finished = false;
  const done = new Promise<void>((resolve) => {
    release = () => {
      finished = true;
      resolve();
    };
  });
  Element.prototype.getAnimations = function () {
    return [
      {
        finished: done,
        pending: false,
        get playState() {
          return finished ? "finished" : "running";
        },
        effect: { getTiming: () => ({ duration: 300, iterations: 1 }) },
      } as unknown as Animation,
    ];
  };
}

beforeEach(() => {
  h.metas.set("a1", agent());
});
afterEach(() => {
  cleanup();
  h.metas.clear();
  h.send.mockClear();
  h.steer.mockClear();
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  flags.BASE_UI_ANIMATIONS_DISABLED = true;
});

describe("AgentDetail", () => {
  it("mounts the transcript only once the slide in has finished", async () => {
    holdAnimations();
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={() => {}} />);
    expect(screen.getByRole("dialog").getAttribute("data-slot")).toBe("sheet-content");
    expect(screen.queryByTestId("transcript")).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("transcript")).toBeTruthy());
  });

  it("is a right sheet of 672px named for the agent, holding its content", () => {
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={() => {}} />);
    const sheet = screen.getByRole("dialog", { name: "Port the view" });
    expect(sheet.getAttribute("data-side")).toBe("right");
    expect(sheet.style.width).toBe("672px");
    expect(screen.getByRole("heading", { name: "Port the view" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("the close button and Escape each call onClose once, after the exit", async () => {
    const onClose = vi.fn();
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("transcript")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // The transcript leaves as the close starts.
    expect(screen.queryByTestId("transcript")).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    cleanup();
    const onEscape = vi.fn();
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={onEscape} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onEscape).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("a file opened from the transcript closes the sheet first, so its pane is not behind it", async () => {
    const onClose = vi.fn();
    const onOpenFile = vi.fn();
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={onClose} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByRole("button", { name: "a.ts" }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("/srv/repo/a.ts"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onOpenFile.mock.invocationCallOrder[0]);
  });

  it("Open closes first, then opens the agent beside its parent", async () => {
    const onClose = vi.fn();
    const onOpenSession = vi.fn();
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={onClose} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("a1"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends to an idle agent and steers a running one", async () => {
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={() => {}} />);
    const field = screen.getByPlaceholderText("Message this agent…");
    fireEvent.change(field, { target: { value: "carry on" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.steer).not.toHaveBeenCalled();

    cleanup();
    h.metas.set("a1", agent({ status: "running" }));
    render(<AgentDetail agentId="a1" parentCwd="/srv/repo" onClose={() => {}} />);
    const steer = screen.getByPlaceholderText("Steer this agent…");
    fireEvent.change(steer, { target: { value: "use the store" } });
    fireEvent.submit(steer.closest("form")!);
    await waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
