// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/session";
import { approvalDetailOf } from "../../lib/approvalDetail";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalControls } from "./Approval";

const approval = (name: string, input: unknown, decided?: "allow" | "deny", auto?: boolean): Block => ({
  id: "a",
  role: "approval",
  text: "",
  tool: { name, input, kind: name === "Bash" ? "execute" : "edit" },
  approval: { requestId: 7, decided, auto },
});

afterEach(cleanup);

describe("ApprovalCard", () => {
  it("carries its actions and the amber glyph, not the strip's word", () => {
    const { container } = render(<ApprovalCard block={approval("Bash", { command: "rm -rf build" })} />);
    expect(container.textContent).toBe("AllowDeny");
    expect(container.querySelector('[data-state="waiting"]')?.getAttribute("aria-label")).toBe("Needs you");
    expect(container.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(container.textContent).not.toContain("build");
    expect(container.querySelector("pre, code")).toBeNull();
  });

  it("Allow and Deny answer with the request id", () => {
    const onApproval = vi.fn();
    render(<ApprovalCard block={approval("Write", { file_path: "/a.ts", content: "x" })} onApproval={onApproval} />);
    expect(screen.getByRole("button", { name: "Allow" }).getAttribute("data-slot")).toBe("button");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    cleanup();
    render(<ApprovalCard block={approval("Write", { file_path: "/a.ts", content: "x" })} onApproval={onApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApproval.mock.calls).toEqual([
      [7, "allow"],
      [7, "deny"],
    ]);
  });

  it("a click draws the decision at once, before the host answers, and a second click sends nothing", () => {
    const onApproval = vi.fn(() => new Promise<void>(() => {}));
    const { container } = render(<ApprovalCard block={approval("Bash", { command: "ls" })} onApproval={onApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(container.textContent).toBe("Allowed");
    expect(screen.queryByRole("button")).toBeNull();
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  it("a decision the host never took puts the buttons back and says so", async () => {
    const toasted = vi.hoisted(() => ({ error: [] as string[] }));
    vi.doMock("../../components/ui/toaster", async (original) => ({
      ...(await original<typeof import("../../components/ui/toaster")>()),
      loadToast: () => Promise.resolve(Object.assign(() => {}, { error: (m: string) => toasted.error.push(m) })),
    }));
    vi.resetModules();
    const { ApprovalCard: Card } = await import("./ApprovalCard");
    const onApproval = vi.fn(() => Promise.reject(new Error("link down")));
    const { container } = render(<Card block={approval("Bash", { command: "ls" })} onApproval={onApproval} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(container.textContent).toBe("Denied");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy());
    await vi.waitFor(() => expect(toasted.error).toEqual(["Couldn't send the decision"]));
    vi.doUnmock("../../components/ui/toaster");
  });

  it("a decided approval is one line with no buttons", () => {
    for (const [decided, auto, line] of [
      ["allow", false, "Allowed"],
      ["deny", false, "Denied"],
      ["deny", true, "Denied automatically"],
    ] as const) {
      const { container, unmount } = render(<ApprovalCard block={approval("Bash", { command: "ls" }, decided, auto)} />);
      expect(container.textContent).toBe(line);
      expect(container.querySelector("button")).toBeNull();
      unmount();
    }
  });

  it("is a 28px line both ways: the mark in the glyph column, the buttons where the words start", () => {
    const { container, rerender } = render(<ApprovalCard block={approval("Bash", { command: "ls" })} />);
    const waiting = container.querySelector<HTMLElement>('[data-slot="approval"]')!;
    expect(waiting.className).toContain("min-h-7");
    expect(waiting.className).not.toMatch(/\b(min-h-8|pb-1|pl-5\.5)\b/);
    expect(waiting.className).toContain("gap-2");
    const mark = waiting.firstElementChild as HTMLElement;
    expect(mark.hasAttribute("data-approval-mark")).toBe(true);
    expect(mark.className).toContain("w-3.5");
    expect(mark.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(mark.nextElementSibling?.textContent).toBe("Allow");
    // Decided on screen: the verdict at the words, 13px muted, fading in.
    rerender(<ApprovalCard block={approval("Bash", { command: "ls" }, "allow")} />);
    const decided = container.querySelector<HTMLElement>('[data-slot="approval"]')!;
    for (const c of ["min-h-7", "pl-5.5", "text-[13px]", "leading-5", "text-muted-foreground", "animate-in", "fade-in-0", "duration-(--dur-fast)", "motion-reduce:animate-none"])
      expect(decided.className).toContain(c);
  });

  it("inside a data-table the mark sits under the row glyph and the verdict under its words", () => {
    const { container, rerender } = render(
      <div data-table="">
        <ApprovalCard block={approval("Bash", { command: "ls" })} />
      </div>,
    );
    // The table's rows inset their words 12px (STEP_LINE's in-data-[table]:px-3); the approval keeps that grid.
    expect(container.querySelector<HTMLElement>('[data-slot="approval"]')!.className).toContain("in-data-[table]:px-3");
    rerender(
      <div data-table="">
        <ApprovalCard block={approval("Bash", { command: "ls" }, "allow")} />
      </div>,
    );
    const decided = container.querySelector<HTMLElement>('[data-slot="approval"]')!;
    // 12px inset + the 22px the words start at.
    expect(decided.className).toContain("pl-5.5");
    expect(decided.className).toContain("in-data-[table]:pl-8.5");
  });

  it("a verdict that mounts decided just shows, with no fade to replay", () => {
    const { container } = render(<ApprovalCard block={approval("Bash", { command: "ls" }, "deny")} />);
    const decided = container.querySelector<HTMLElement>('[data-slot="approval"]')!;
    expect(decided.className).toContain("min-h-7");
    expect(decided.className).not.toContain("animate-in");
  });

  it("ApprovalControls is the same component, for A8's rows until they switch", () => {
    expect(ApprovalControls).toBe(ApprovalCard);
  });
});

describe("approvalDetailOf", () => {
  it("joins a shell call's phrases with a comma, never a dot", () => {
    const detail = approvalDetailOf(approval("Bash", { command: "bun install && bun test" }));
    expect(detail?.kind).toBe("shell");
    const doing = detail?.kind === "shell" ? detail.doing : "";
    expect(doing).toBe("Install dependencies, run the tests");
  });
});
