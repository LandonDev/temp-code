import { describe, expect, it } from "vitest";
import {
  composeInboxMessage,
  dedupeInboxItems,
  filterInboxItems,
  formatRelativeTime,
  githubAvatarUrl,
  githubReviewDecisionLabel,
  githubReviewStateLabel,
  inboxComposerCard,
  inboxItemKey,
  inboxPersonAvatarUrl,
  inboxStartDraft,
  sortInboxItems,
  type InboxItem,
} from "./githubTasks";

function item(
  overrides: Partial<InboxItem> & Pick<InboxItem, "number" | "updatedAt">,
): InboxItem {
  return {
    kind: "issue",
    title: "Item",
    url: "https://github.com/acme/web/issues/1",
    state: "open",
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/web",
    projectPath: "/tmp/web",
    provider: "github",
    ...overrides,
  };
}

describe("githubAvatarUrl", () => {
  it("builds the GitHub avatar URL", () => {
    expect(githubAvatarUrl("maya")).toBe(
      "https://avatars.githubusercontent.com/maya?s=64",
    );
  });

  it("encodes bot logins", () => {
    expect(githubAvatarUrl("dependabot[bot]")).toBe(
      "https://avatars.githubusercontent.com/dependabot%5Bbot%5D?s=64",
    );
  });

  it("returns empty for a blank login", () => {
    expect(githubAvatarUrl("  ")).toBe("");
  });
});

describe("inboxPersonAvatarUrl", () => {
  it("prefers an explicit avatar", () => {
    expect(
      inboxPersonAvatarUrl(
        "linear",
        "Ada",
        "https://uploads.linear.app/ada.png",
      ),
    ).toBe("https://uploads.linear.app/ada.png");
  });

  it("falls back to GitHub avatars for GitHub people", () => {
    expect(inboxPersonAvatarUrl("github", "maya")).toBe(
      "https://avatars.githubusercontent.com/maya?s=64",
    );
  });

  it("does not invent a GitHub avatar for Linear names", () => {
    expect(inboxPersonAvatarUrl("linear", "Ada")).toBe("");
  });
});

describe("formatRelativeTime", () => {
  it("formats hours ago", () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    expect(formatRelativeTime("2026-08-27T10:00:00Z", now, "en")).toBe(
      "2 hours ago",
    );
  });

  it("returns empty for an unreadable timestamp", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("githubReviewDecisionLabel", () => {
  it("labels GitHub review rollups", () => {
    expect(githubReviewDecisionLabel("APPROVED")).toBe("Approved");
    expect(githubReviewDecisionLabel("changes_requested")).toBe(
      "Changes requested",
    );
    expect(githubReviewDecisionLabel("REVIEW_REQUIRED")).toBe("Review required");
    expect(githubReviewDecisionLabel("")).toBe("");
  });
});

describe("githubReviewStateLabel", () => {
  it("labels a submitted review", () => {
    expect(githubReviewStateLabel("APPROVED")).toBe("Approved");
    expect(githubReviewStateLabel("COMMENTED")).toBe("Commented");
    expect(githubReviewStateLabel("PENDING")).toBe("");
  });
});

describe("sortInboxItems", () => {
  it("orders by newest update, mixing issues and pull requests", () => {
    const sorted = sortInboxItems([
      item({
        number: 1,
        kind: "issue",
        updatedAt: "2026-08-27T08:00:00Z",
        title: "older issue",
      }),
      item({
        number: 2,
        kind: "pr",
        updatedAt: "2026-08-27T10:00:00Z",
        title: "newer pr",
      }),
    ]);
    expect(sorted.map((row) => row.number)).toEqual([2, 1]);
  });
});

describe("dedupeInboxItems", () => {
  it("keeps one card per GitHub issue across local checkouts", () => {
    const rows = [
      item({
        number: 10,
        updatedAt: "2026-08-27T10:00:00Z",
        projectPath: "/tmp/agent-terminal",
        repo: "hardbeat920/monocode",
      }),
      item({
        number: 10,
        updatedAt: "2026-08-27T10:00:00Z",
        projectPath: "/tmp/monocode",
        repo: "HardBeat920/monocode",
      }),
    ];
    const deduped = dedupeInboxItems(rows, ["/tmp/monocode", "/tmp/agent-terminal"]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.projectPath).toBe("/tmp/monocode");
    expect(inboxItemKey(deduped[0]!)).toBe(
      "github:hardbeat920/monocode:issue:10",
    );
  });
});

describe("filterInboxItems", () => {
  const items = [
    item({
      number: 12,
      kind: "pr",
      title: "Fix checkout",
      repo: "acme/web",
      updatedAt: "2026-08-27T10:00:00Z",
      labels: [{ name: "bug", color: "d73a4a" }],
    }),
    item({
      number: 4,
      kind: "issue",
      title: "Add dark mode",
      repo: "acme/docs",
      projectPath: "/tmp/docs",
      updatedAt: "2026-08-27T09:00:00Z",
    }),
  ];

  it("keeps every item when the query is empty", () => {
    expect(filterInboxItems(items, "  ")).toHaveLength(2);
  });

  it("matches title, number, kind, repo, and labels", () => {
    expect(filterInboxItems(items, "checkout").map((row) => row.number)).toEqual(
      [12],
    );
    expect(filterInboxItems(items, "#4").map((row) => row.number)).toEqual([4]);
    expect(filterInboxItems(items, "pull").map((row) => row.number)).toEqual([
      12,
    ]);
    expect(filterInboxItems(items, "docs").map((row) => row.number)).toEqual([
      4,
    ]);
    expect(filterInboxItems(items, "bug").map((row) => row.number)).toEqual([
      12,
    ]);
  });
});

describe("inboxStartDraft", () => {
  it("seeds the composer with the kind, title, and URL", () => {
    expect(
      inboxStartDraft(
        item({
          number: 10,
          kind: "issue",
          title: "Normalize streamed plan",
          url: "https://github.com/acme/web/issues/10",
          updatedAt: "2026-08-27T10:00:00Z",
        }),
      ),
    ).toBe(
      "Work on this GitHub issue:\n\n#10 Normalize streamed plan\nhttps://github.com/acme/web/issues/10\n",
    );
  });

  it("labels pull requests", () => {
    expect(
      inboxStartDraft(
        item({
          number: 12,
          kind: "pr",
          title: "Fix checkout",
          url: "https://github.com/acme/web/pull/12",
          updatedAt: "2026-08-27T10:00:00Z",
        }),
      ),
    ).toContain("Work on this GitHub pull request:");
  });

  it("seeds Linear issues with the identifier", () => {
    expect(
      inboxStartDraft(
        item({
          number: 9,
          kind: "linear",
          provider: "linear",
          identifier: "ENG-9",
          title: "Fix auth",
          url: "https://linear.app/acme/issue/ENG-9",
          updatedAt: "2026-08-27T10:00:00Z",
        }),
      ),
    ).toBe(
      "Work on this Linear issue:\n\nENG-9 Fix auth\nhttps://linear.app/acme/issue/ENG-9\n",
    );
  });

  it("includes a Linear description when provided", () => {
    expect(
      inboxStartDraft(
        item({
          number: 9,
          kind: "linear",
          provider: "linear",
          identifier: "ENG-9",
          title: "Fix auth",
          url: "https://linear.app/acme/issue/ENG-9",
          updatedAt: "2026-08-27T10:00:00Z",
        }),
        "Steps to reproduce the login failure.",
      ),
    ).toContain("Steps to reproduce the login failure.");
  });
});

describe("inboxItemKey", () => {
  it("keys Linear issues by identifier", () => {
    expect(
      inboxItemKey(
        item({
          number: 9,
          kind: "linear",
          provider: "linear",
          identifier: "ENG-9",
          updatedAt: "2026-08-27T10:00:00Z",
        }),
      ),
    ).toBe("linear:eng-9");
  });
});

describe("inboxComposerCard", () => {
  it("builds a Linear chip without putting the draft in the title", () => {
    const card = inboxComposerCard(
      item({
        number: 9,
        kind: "linear",
        provider: "linear",
        identifier: "ENG-9",
        title: "Fix auth",
        url: "https://linear.app/acme/issue/ENG-9",
        teamName: "Engineering",
        updatedAt: "2026-08-27T10:00:00Z",
      }),
      "Reset the session cookie.",
    );
    expect(card).toMatchObject({
      provider: "linear",
      kind: "linear",
      identifier: "ENG-9",
      title: "Fix auth",
      source: "Engineering",
      url: "https://linear.app/acme/issue/ENG-9",
    });
    expect(card.prompt).toContain("Work on this Linear issue:");
    expect(card.prompt).toContain("Reset the session cookie.");
  });

  it("builds a GitHub chip from the repo and issue number", () => {
    const card = inboxComposerCard(
      item({
        number: 10,
        kind: "issue",
        title: "Normalize streamed plan",
        url: "https://github.com/acme/web/issues/10",
        updatedAt: "2026-08-27T10:00:00Z",
      }),
    );
    expect(card).toMatchObject({
      provider: "github",
      kind: "issue",
      identifier: "#10",
      title: "Normalize streamed plan",
      source: "acme/web",
    });
  });
});

describe("composeInboxMessage", () => {
  it("sends the hidden prompt when the textarea is empty", () => {
    expect(
      composeInboxMessage(
        inboxComposerCard(
          item({
            number: 10,
            title: "Normalize streamed plan",
            url: "https://github.com/acme/web/issues/10",
            updatedAt: "2026-08-27T10:00:00Z",
          }),
        ),
        "  ",
      ),
    ).toBe(
      "Work on this GitHub issue:\n\n#10 Normalize streamed plan\nhttps://github.com/acme/web/issues/10",
    );
  });

  it("appends a user note after the hidden prompt", () => {
    expect(
      composeInboxMessage(
        inboxComposerCard(
          item({
            number: 10,
            title: "Normalize streamed plan",
            url: "https://github.com/acme/web/issues/10",
            updatedAt: "2026-08-27T10:00:00Z",
          }),
        ),
        "Start with the parser.",
      ),
    ).toContain("\n\nStart with the parser.");
  });

  it("returns the typed text when there is no card", () => {
    expect(composeInboxMessage(undefined, " hello ")).toBe("hello");
  });
});
