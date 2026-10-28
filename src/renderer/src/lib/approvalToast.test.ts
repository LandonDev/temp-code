import { describe, expect, it } from "vitest";
import { newTab, splitPane } from "./layout";
import {
  hiddenApprovalNotices,
  isSessionConversationFocused,
  pendingApprovalForSession,
} from "./approvalToast";
import { newSession, type Block } from "./session";

function block(
  role: Block["role"],
  approval?: Block["approval"],
): Block {
  return {
    id: crypto.randomUUID(),
    role,
    text: role === "tool" ? "Run command" : "Approve?",
    ...(role === "tool"
      ? { tool: { title: "Run command", kind: "execute" } }
      : {}),
    ...(approval ? { approval } : {}),
  };
}

describe("pendingApprovalForSession", () => {
  it("returns the latest undecided approval", () => {
    const session = newSession("local");
    session.blocks = [
      block("tool", { requestId: 1, decided: "allow" }),
      block("tool", { requestId: 2 }),
    ];
    const pending = pendingApprovalForSession(session);
    expect(pending?.requestId).toBe(2);
    expect(pending?.label).toBe("Running a command");
    expect(pending?.tool).toBe("a tool");
  });

  it("names the tool for a state's detail and keeps the long words for the toast", () => {
    const session = newSession("local");
    session.blocks = [
      {
        id: "b1",
        role: "tool",
        text: "",
        tool: { name: "Bash", kind: "execute", title: "Bash", input: { command: "touch notes.txt", description: "Create an empty notes file" } },
        approval: { requestId: 7 },
      } as Block,
    ];
    const pending = pendingApprovalForSession(session)!;
    expect(pending.tool).toBe("Bash");
    expect(pending.label).not.toBe("Bash");
  });
});

describe("isSessionConversationFocused", () => {
  it("is true only when the session pane is focused on the active tab", () => {
    const session = newSession("local");
    const tab = newTab(session.id);
    expect(
      isSessionConversationFocused(session.id, tab.id, [tab], true),
    ).toBe(true);
    expect(
      isSessionConversationFocused(session.id, tab.id, [tab], false),
    ).toBe(false);
    expect(
      isSessionConversationFocused("other", tab.id, [tab], true),
    ).toBe(false);
  });
});

describe("hiddenApprovalNotices", () => {
  it("omits approvals that are already in the focused conversation", () => {
    const visible = newSession("local");
    visible.blocks = [block("tool", { requestId: 1 })];
    const hidden = newSession("local");
    hidden.blocks = [block("tool", { requestId: 2 })];

    const visibleTab = newTab(visible.id);
    const hiddenTab = newTab(hidden.id);

    expect(
      hiddenApprovalNotices(
        [visible, hidden],
        visibleTab.id,
        [visibleTab, hiddenTab],
        true,
      ).map((notice) => notice.sessionId),
    ).toEqual([hidden.id]);
  });

  it("shows approvals in another pane on the same tab", () => {
    const left = newSession("local");
    left.blocks = [block("tool", { requestId: 1 })];
    const right = newSession("local");
    const tab = {
      ...newTab(left.id),
      layout: splitPane(newTab(left.id).layout, left.id, "right", right.id),
      focusedId: right.id,
    };

    expect(
      hiddenApprovalNotices([left, right], tab.id, [tab], true).map(
        (notice) => notice.sessionId,
      ),
    ).toEqual([left.id]);
  });
});
