import { describe, expect, it } from "vitest";
import { chatsAriaLabel, projectCardAriaLabel, projectCardTitle, projectMenuExtraItems } from "./ProjectRail";

const stats = { files: 2, additions: 3, deletions: 1 };

describe("projectCardTitle", () => {
  it("says nothing about work when there is none", () => {
    expect(projectCardTitle("/repo", "Repo", null, false)).toBe("Repo\n/repo");
  });

  it("says Working for a turn in flight", () => {
    expect(projectCardTitle("/repo", "Repo", null, true)).toContain("Working");
  });

  it("says Needs you instead of Working, never both", () => {
    const title = projectCardTitle("/repo", "Repo", null, true, true);
    expect(title).toContain("Needs you");
    expect(title).not.toContain("Working");
  });

  it("keeps the diff line", () => {
    expect(projectCardTitle("/repo", "Repo", stats, false, true)).toBe(
      "Repo\n/repo\nNeeds you\n2 files changed +3 -1",
    );
  });
});

describe("projectCardAriaLabel", () => {
  it("reads the name alone when the project is quiet", () => {
    expect(projectCardAriaLabel("Repo", null, false)).toBe("Repo");
  });

  it("reads working, then needs you in its place", () => {
    expect(projectCardAriaLabel("Repo", null, true)).toBe("Repo, working");
    const label = projectCardAriaLabel("Repo", null, true, true);
    expect(label).toBe("Repo, needs you");
  });

  it("keeps the counts after the state", () => {
    expect(projectCardAriaLabel("Repo", stats, false, true)).toBe(
      "Repo, needs you, 2 files changed, +3, -1",
    );
  });
});

describe("chatsAriaLabel", () => {
  it("names the loose chats' state, needs-you first", () => {
    expect(chatsAriaLabel(false, false)).toBe("Chats");
    expect(chatsAriaLabel(true, false)).toBe("Chats, working");
    expect(chatsAriaLabel(true, true)).toBe("Chats, needs you");
  });
});

describe("projectMenuExtraItems", () => {
  it("puts the fleet switches after Mark all read, a row with nothing to act on disabled", () => {
    const items = projectMenuExtraItems(false, true, { pause: 2, resume: 0, stop: 2, archiveDone: 1 });
    expect(items.map((i) => i.id)).toEqual(["pin", "reveal", "read", "batch-pause", "batch-resume", "batch-stop", "batch-archiveDone", "archive", "delete"]);
    expect(items.find((i) => i.id === "batch-resume")?.disabled).toBe(true);
    expect(items.find((i) => i.id === "batch-pause")?.disabled).toBe(false);
    expect(items.find((i) => i.id === "batch-pause")?.sepBefore).toBe(true);
  });

  it("disables every switch before the counts are known", () => {
    const items = projectMenuExtraItems(true, false, null);
    expect(items.filter((i) => i.id.startsWith("batch-")).every((i) => i.disabled)).toBe(true);
    expect(items.map((i) => i.id)).not.toContain("archive");
  });
});
