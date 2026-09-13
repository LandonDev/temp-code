import { describe, expect, it } from "vitest";
import { projectCardAriaLabel, projectCardTitle } from "./ProjectRail";

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
