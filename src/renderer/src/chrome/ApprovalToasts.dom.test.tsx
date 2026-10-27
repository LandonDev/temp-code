// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../lib/session";
import { ApprovalToasts } from "./ApprovalToasts";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { warning: vi.fn(), dismiss: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

const session = { id: "s1", title: "Fix the build", harness: "claude" } as Session;
const notice = { sessionId: "s1", requestId: 7, label: "Bash: bun test", block: {} as Block, session };

type Options = { id: string; description: string; duration: number; action: { onClick: () => void }; cancel: { onClick: () => void } };

// sonner loads on the first toast (chrome/toastSync.ts), so a toast lands a microtask after the render.
const flush = () => act(() => Promise.resolve());

describe("ApprovalToasts", () => {
  it("holds a sonner toast per approval: the title opens the thread, Allow and Deny answer it", async () => {
    const onFocusSession = vi.fn();
    const onApproval = vi.fn();
    const { container } = render(<ApprovalToasts notices={[notice]} onFocusSession={onFocusSession} onApproval={onApproval} />);
    await flush();
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
    await flush();
    const id = (vi.mocked(toast.warning).mock.calls[0][1] as unknown as Options).id;
    rerender(<ApprovalToasts notices={[]} {...props} />);
    await flush();
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });
});
