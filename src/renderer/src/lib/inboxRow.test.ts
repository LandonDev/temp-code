import { describe, expect, it } from "vitest";
import type { InboxItem } from "./githubTasks";
import { inboxRowModel, inboxStateWords } from "./inboxRow";

const pr = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    kind: "pr",
    number: 12,
    title: "Fix the gate",
    url: "https://github.com/me/app/pull/12",
    state: "open",
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    labels: [{ name: "bug", color: "ff0000" }],
    assignees: [],
    draft: false,
    repo: "me/app",
    projectPath: "/srv/app",
    provider: "github",
    author: { login: "ana" },
    ...over,
  }) as InboxItem;

const linear = (over: Partial<InboxItem> = {}): InboxItem =>
  pr({ provider: "linear", kind: "linear", identifier: "ENG-4", teamName: "Engineering", state: "In Progress", repo: "", ...over });

describe("inboxRowModel", () => {
  it("says the ref and the author, and the repo only when the list spans sources", () => {
    expect(inboxRowModel(pr(), { unseen: false, showSource: false }).line).toEqual(["#12", "ana"]);
    expect(inboxRowModel(pr(), { unseen: true, showSource: true })).toMatchObject({
      kind: "pr",
      title: "Fix the gate",
      unseen: true,
      line: ["#12", "me/app", "ana"],
      status: null,
    });
    expect(inboxRowModel(pr(), { unseen: false, showSource: false }).time).toBeTruthy();
  });

  it("names a Linear issue by its identifier and team, as an issue", () => {
    expect(inboxRowModel(linear(), { unseen: false, showSource: true })).toMatchObject({
      kind: "issue",
      line: ["ENG-4", "Engineering", "ana"],
    });
  });

  it("marks failed checks on an open pull request and nothing else", () => {
    expect(inboxRowModel(pr({ checks: "FAILURE" }), { unseen: false, showSource: false }).status).toEqual({
      state: "failed",
      detail: "checks",
    });
    expect(inboxRowModel(pr({ checks: "ERROR" }), { unseen: false, showSource: false }).status).not.toBeNull();
    for (const over of [
      { draft: true, checks: "FAILURE" as const },
      { reviewDecision: "APPROVED" },
      { reviewDecision: "CHANGES_REQUESTED" },
      { state: "closed", checks: "FAILURE" as const },
      { checks: "SUCCESS" as const },
    ]) {
      expect(inboxRowModel(pr(over), { unseen: false, showSource: false }).status).toBeNull();
    }
  });
});

describe("inboxStateWords", () => {
  it("says each state in plain words", () => {
    expect(inboxStateWords(pr({ draft: true }))).toEqual(["Draft"]);
    expect(inboxStateWords(pr())).toEqual(["Open"]);
    expect(inboxStateWords(pr({ state: "merged" }))).toEqual(["Merged"]);
    expect(inboxStateWords(pr({ state: "closed" }))).toEqual(["Closed"]);
    expect(inboxStateWords(pr({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual(["Open", "Changes requested"]);
    expect(inboxStateWords(pr({ reviewDecision: "APPROVED" }))).toEqual(["Open", "Approved"]);
    expect(inboxStateWords(pr({ state: "merged", reviewDecision: "APPROVED" }))).toEqual(["Merged"]);
    expect(inboxStateWords(pr(), "APPROVED")).toEqual(["Open", "Approved"]);
    expect(inboxStateWords(pr({ kind: "issue" }))).toEqual(["Open"]);
    expect(inboxStateWords(linear())).toEqual(["In Progress"]);
  });
});
