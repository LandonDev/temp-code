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
  it("says why it waits and nothing the row already says", () => {
    const { container } = render(<ApprovalCard block={approval("Bash", { command: "rm -rf build" })} />);
    expect(container.textContent).toBe("Needs youAllowDeny");
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
      ["deny", true, "Denied, timed out"],
    ] as const) {
      const { container, unmount } = render(<ApprovalCard block={approval("Bash", { command: "ls" }, decided, auto)} />);
      expect(container.textContent).toBe(line);
      expect(container.querySelector("button")).toBeNull();
      unmount();
    }
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
