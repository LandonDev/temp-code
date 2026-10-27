import { describe, expect, it } from "vitest";
import { chatsAriaLabel, projectMenuExtraItems, railFootRows, workspaceRowAriaLabel } from "./ProjectRail";

describe("workspaceRowAriaLabel", () => {
  it("reads the name alone when the workspace is quiet", () => {
    expect(workspaceRowAriaLabel("Repo", false)).toBe("Repo");
  });

  it("reads working, then needs you in its place, never both", () => {
    expect(workspaceRowAriaLabel("Repo", true)).toBe("Repo, working");
    expect(workspaceRowAriaLabel("Repo", true, true)).toBe("Repo, needs you");
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

describe("railFootRows", () => {
  it("is Inbox, Search, Accounts, Stats, Settings with one host and nothing to update", () => {
    expect(railFootRows({ update: false, hosts: 1 })).toEqual(["inbox", "search", "accounts", "stats", "settings"]);
  });

  it("puts the update first and the hosts after it, the hosts only with two or more", () => {
    expect(railFootRows({ update: true, hosts: 2 })).toEqual(["update", "hosts", "inbox", "search", "accounts", "stats", "settings"]);
    expect(railFootRows({ update: true, hosts: 1 })[0]).toBe("update");
    expect(railFootRows({ update: false, hosts: 3 })[0]).toBe("hosts");
  });
});
