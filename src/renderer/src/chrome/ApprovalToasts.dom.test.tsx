import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { mountProbe, Probe } from "../test/renderProbe";
import { newSession } from "../lib/session";
import { sessionStore, type Link } from "../lib/tcserver/store";
import type { EventRow, ServerPush } from "../lib/tcserver/types";
import { focusStore } from "../stores/focus";
import { workspaceTabsStore } from "../stores/workspace";
import { newTab } from "../lib/layout";
import { loadToast } from "./toastSync";
import { ApprovalToasts, HiddenApprovalToasts } from "./ApprovalToasts";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

let probe: ReturnType<typeof mountProbe> | null = null;
let push: (push: ServerPush) => void;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({ sessionId, seq, ts: seq, event });
const request = (id: string, seq = 1) => row(id, seq, { type: "approval-request", requestId: 7, toolName: "Bash", input: { command: "pwd" } });
const flush = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};
const send = async (event: EventRow) => {
  await act(async () => {
    push({ push: "event", row: event });
    flush();
    await loadToast();
  });
};

beforeEach(async () => {
  sessionStore.reset();
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const link: Link = {
    environmentId: "local", connected: true, profile: "local",
    request: async <T,>(method: string) => (method === "session.list" ? [] : null) as T,
    onPush: (listener) => { push = listener; return () => {}; },
    onOpen: () => () => {}, onClose: () => () => {},
  };
  sessionStore.attach(link);
  await sessionStore.ready();
  sessionStore.mutate([{ ...newSession("local"), id: "approval", title: "Review" }, { ...newSession("local"), id: "stream" }]);
  focusStore.setState({ composerFocused: false });
  await loadToast();
  vi.clearAllMocks();
});

afterEach(() => {
  probe?.unmount();
  probe = null;
  sessionStore.reset();
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => {
  probe = mountProbe(<Probe id="approvals"><HiddenApprovalToasts onFocusSession={vi.fn()} onApproval={vi.fn()} /></Probe>);
};

describe("HiddenApprovalToasts", () => {
  it("makes no sonner call or approval render for 100 unrelated text deltas", async () => {
    mount();
    await send(request("approval"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const renders = probe!.renders("approvals");
    vi.clearAllMocks();
    for (let i = 1; i <= 100; i++) {
      await send(row("stream", i, { type: "assistant-text", text: "x", delta: true, msgId: "m", blockIndex: 0 }));
    }
    expect(sessionStore.get("stream")!.blocks[0].text).toHaveLength(100);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(probe!.renders("approvals")).toBe(renders);
  });

  it("shows one added approval and dismisses it when decided", async () => {
    mount();
    await send(request("approval"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][1]).toMatchObject({ id: "approval:approval:7", duration: Infinity, action: { label: "Allow" }, cancel: { label: "Deny" } });
    await send(row("approval", 2, { type: "approval-resolved", requestId: 7, allow: true }));
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("approval:approval:7");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("labels a computer step waiting for the Mac Run now and Skip", async () => {
    const onApproval = vi.fn();
    probe = mountProbe(<Probe id="approvals"><HiddenApprovalToasts onFocusSession={vi.fn()} onApproval={onApproval} /></Probe>);
    await send(row("approval", 1, { type: "approval-request", requestId: "r1", toolName: "computer_session", input: { app: "TextEdit" }, title: "Use your pointer and keyboard to click in TextEdit", choices: "run-skip" }));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const options = toast.warning.mock.calls[0][1];
    expect(options).toMatchObject({ action: { label: "Run now" }, cancel: { label: "Skip" } });
    options.action.onClick();
    expect(onApproval).toHaveBeenCalledExactlyOnceWith("approval", "r1", "allow");
  });

  it("dismisses its approvals when the owner unmounts", async () => {
    mount();
    await send(request("approval"));
    probe!.unmount();
    probe = null;
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("approval:approval:7");
  });

  it("hides the focused conversation's approval and restores it when focus leaves", async () => {
    const tab = newTab("approval");
    workspaceTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
    focusStore.setState({ composerFocused: true });
    mount();
    await send(request("approval"));
    expect(toast.warning).not.toHaveBeenCalled();
    await act(async () => { focusStore.setState({ composerFocused: false }); });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    await act(async () => { focusStore.setState({ composerFocused: true }); });
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("approval:approval:7");
  });
});

describe("ApprovalToasts", () => {
  it("updates only changed visible fields and keeps action callbacks current", async () => {
    const notice = { sessionId: "s", requestId: 9, title: "Review", label: "Run pwd", tool: "Bash" };
    const original = vi.fn();
    const current = vi.fn();
    const render = (title: string, action = original) => <ApprovalToasts notices={[{ ...notice, title }]} onFocusSession={action} onApproval={action} />;
    probe = mountProbe(render("Review"));
    await act(async () => { await loadToast(); });
    const [title, options] = toast.warning.mock.calls[0];
    probe.rerender(render("Review", current));
    await act(async () => { await loadToast(); });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    (title as ReactElement<{ onClick: () => void }>).props.onClick();
    options.action.onClick();
    options.cancel.onClick();
    expect(original).not.toHaveBeenCalled();
    expect(current.mock.calls).toEqual([["s"], ["s", 9, "allow"], ["s", 9, "deny"]]);
    probe.rerender(render("Renamed", current));
    await act(async () => { await loadToast(); });
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning.mock.calls[1][0].props.children).toBe("Renamed");
  });
});

const notice = { sessionId: "s1", requestId: 7, label: "Bash: bun test", tool: "Bash", title: "Fix the build" };

type Options = { id: string; description: string; duration: number; action: { onClick: () => void }; cancel: { onClick: () => void } };

// sonner loads on the first toast (chrome/toastSync.ts), so a toast lands a microtask after the render.
const flushToast = () => act(() => Promise.resolve());

describe("ApprovalToasts", () => {
  it("holds a sonner toast per approval: the title opens the thread, Allow and Deny answer it", async () => {
    const onFocusSession = vi.fn();
    const onApproval = vi.fn();
    const { container } = render(<ApprovalToasts notices={[notice]} onFocusSession={onFocusSession} onApproval={onApproval} />);
    await flushToast();
    expect(container.innerHTML).toBe("");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title, raw] = vi.mocked(toast.warning).mock.calls[0];
    const opts = raw as unknown as Options;
    expect(opts.description).toBe("Bash: bun test");
    expect(opts.duration).toBe(Infinity);
    opts.action.onClick();
    expect(onApproval).toHaveBeenLastCalledWith("s1", 7, "allow");
    opts.cancel.onClick();
    expect(onApproval).toHaveBeenLastCalledWith("s1", 7, "deny");

    const titleView = render(<>{title as React.ReactNode}</>);
    fireEvent.click(titleView.getByRole("button", { name: "Fix the build" }));
    expect(onFocusSession).toHaveBeenCalledWith("s1");
  });

  it("dismisses the toast once the approval is answered", async () => {
    const props = { onFocusSession: vi.fn(), onApproval: vi.fn() };
    const { rerender } = render(<ApprovalToasts notices={[notice]} {...props} />);
    await flushToast();
    const id = (vi.mocked(toast.warning).mock.calls[0][1] as unknown as Options).id;
    rerender(<ApprovalToasts notices={[]} {...props} />);
    await flushToast();
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });
});
