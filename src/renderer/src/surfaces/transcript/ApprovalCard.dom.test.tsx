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
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApproval.mock.calls).toEqual([
      [7, "allow"],
      [7, "deny"],
    ]);
    expect(screen.getByRole("button", { name: "Allow" }).getAttribute("data-slot")).toBe("button");
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
