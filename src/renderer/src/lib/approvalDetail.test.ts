import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { approvalDetailOf, approvalOutcome, bareCommand } from "./approvalDetail";

function approval(name: string, input: unknown, kind?: string): Block {
  return {
    id: "a",
    role: "approval",
    text: name,
    tool: { name, input, kind },
    approval: { requestId: 1 },
  };
}

describe("bareCommand", () => {
  it("peels wrappers and env, and hides home dirs", () => {
    expect(bareCommand(`/bin/zsh -lc "FOO=1 env -u X ls /Users/landon/src"`)).toBe("ls ~/src");
    expect(bareCommand("git status")).toBe("git status");
  });
});

describe("approvalDetailOf", () => {
  it("summarises a shell command and shows it bare", () => {
    const d = approvalDetailOf(approval("Bash", { command: "zsh -lc 'git status'" }));
    expect(d).toEqual({ kind: "shell", doing: expect.any(String), command: "git status" });
    expect((d as { doing: string }).doing).not.toBe("");
  });

  it("shows a file edit's path and up to ten added lines", () => {
    const content = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const d = approvalDetailOf(approval("Write", { file_path: "/x/y.ts", content }));
    expect(d).toMatchObject({ kind: "file", path: "/x/y.ts", more: true });
    expect((d as { added: string[] }).added).toHaveLength(10);
    const e = approvalDetailOf(approval("Edit", { file_path: "/x/y.ts", old_string: "a", new_string: "b" }));
    expect(e).toMatchObject({ kind: "file", added: ["b"], more: false });
  });

  it("falls back to the request's string fields, four at most", () => {
    const d = approvalDetailOf(approval("WebFetch", { url: "https://x", prompt: "p", n: 3, a: "1", b: "2", c: "3" }));
    expect(d).toEqual({ kind: "fields", entries: [["url", "https://x"], ["prompt", "p"], ["a", "1"], ["b", "2"]] });
    expect(approvalDetailOf(approval("Thing", {}))).toBeNull();
    expect(approvalDetailOf(approval("Thing", "nope"))).toBeNull();
  });

  it("reads the partial input while the model still writes it", () => {
    const b = approval("Bash", undefined);
    (b.tool as { partialInput?: unknown }).partialInput = { command: "ls" };
    expect(approvalDetailOf(b)).toMatchObject({ kind: "shell", command: "ls" });
  });
});

describe("approvalOutcome", () => {
  it("names the decision and who made it", () => {
    expect(approvalOutcome(undefined)).toBeNull();
    expect(approvalOutcome({ requestId: 1 })).toBeNull();
    expect(approvalOutcome({ requestId: 1, decided: "allow" })).toBe("approved");
    expect(approvalOutcome({ requestId: 1, decided: "deny" })).toBe("denied");
    expect(approvalOutcome({ requestId: 1, decided: "deny", auto: true })).toBe("denied (timed out)");
    expect(approvalOutcome({ requestId: 1, decided: "cancelled" })).toBe("denied (timed out)");
  });
});
