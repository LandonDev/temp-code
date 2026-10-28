import { describe, expect, it } from "vitest";
import { chatsAriaLabel, projectMenuExtraItems, railAccountRows, railFootRows, railTopRows, workspaceRowAriaLabel } from "./ProjectRail";

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
    const rows = projectMenuExtraItems(false, true, { pause: 2, resume: 0, stop: 2, archiveDone: 1 });
    // Separators are rows of their own: one after reveal, one before archive.
    expect(rows.map((r) => (r.kind === "item" ? r.id : "-"))).toEqual(["pin", "reveal", "-", "read", "batch-pause", "batch-resume", "batch-stop", "batch-archiveDone", "-", "archive", "delete"]);
    const items = rows.flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.find((i) => i.id === "batch-resume")?.disabled).toBe(true);
    expect(items.find((i) => i.id === "batch-pause")?.disabled).toBe(false);
  });

  it("has no reveal in a browser, which has no file manager", () => {
    const rows = projectMenuExtraItems(false, true, null, false);
    expect(rows.some((r) => r.kind === "item" && r.id === "reveal")).toBe(false);
    expect(projectMenuExtraItems(false, true, null, true).some((r) => r.kind === "item" && r.id === "reveal")).toBe(true);
  });

  it("names the root workspace's removal Remove…, as its dialog does", () => {
    const items = projectMenuExtraItems(false, true, null).flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.find((i) => i.id === "delete")?.label).toBe("Remove…");
  });

  it("disables every switch before the counts are known", () => {
    const items = projectMenuExtraItems(true, false, null).flatMap((r) => (r.kind === "item" ? [r] : []));
    expect(items.filter((i) => i.id.startsWith("batch-")).every((i) => i.disabled)).toBe(true);
    expect(items.map((i) => i.id)).not.toContain("archive");
  });
});

describe("railTopRows", () => {
  it("puts navigation first: Search, Inbox, Mark all read, Notes, Chats", () => {
    expect(railTopRows({ chats: true, notes: true })).toEqual(["search", "inbox", "read", "notes", "chats"]);
  });

  it("leaves Notes and Chats out where they cannot open", () => {
    expect(railTopRows({ chats: false, notes: false })).toEqual(["search", "inbox", "read"]);
  });
});

describe("railAccountRows", () => {
  it("is Accounts and Stats on the desktop, nothing at /ui", () => {
    expect(railAccountRows({ aliax: true })).toEqual(["accounts", "stats"]);
    expect(railAccountRows({ aliax: false })).toEqual([]);
  });
});

describe("railFootRows", () => {
  it("is Settings alone with one host and nothing to update", () => {
    expect(railFootRows({ signIn: false, update: false, hosts: 1 })).toEqual(["settings"]);
  });

  it("puts the update first and the hosts after it, the hosts only with two or more", () => {
    expect(railFootRows({ signIn: false, update: true, hosts: 2 })).toEqual(["update", "hosts", "settings"]);
    expect(railFootRows({ signIn: false, update: true, hosts: 1 })[0]).toBe("update");
    expect(railFootRows({ signIn: false, update: false, hosts: 3 })[0]).toBe("hosts");
  });

  it("leads with the sign-in on first run, before the update, and leaves it out when there is an account", () => {
    expect(railFootRows({ signIn: true, update: true, hosts: 1 })).toEqual(["signIn", "update", "settings"]);
    expect(railFootRows({ signIn: false, update: true, hosts: 1 })).not.toContain("signIn");
  });
});
