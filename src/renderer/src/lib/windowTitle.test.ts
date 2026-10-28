import { describe, expect, it } from "vitest";
import { threadPane, windowTitle } from "./windowTitle";

describe("windowTitle", () => {
  it("names a thread and its project", () => {
    expect(windowTitle({ page: null, pane: { kind: "thread", title: "Fix the badge" }, project: "temp-code" })).toBe(
      "Fix the badge — temp-code",
    );
  });

  it("names an untitled thread New thread", () => {
    expect(windowTitle({ page: null, pane: { kind: "thread", title: "  " }, project: "temp-code" })).toBe(
      "New thread — temp-code",
    );
  });

  it("reads a draft's bare harness title as New thread, and TempCode with nothing open", () => {
    expect(windowTitle({ page: null, pane: threadPane({ title: "claude", harness: "claude" }), project: null })).toBe(
      "New thread",
    );
    expect(windowTitle({ page: null, pane: threadPane({ title: "Claude Code", harness: "claude" }), project: "alpha" })).toBe(
      "New thread — alpha",
    );
    expect(windowTitle({ page: null, pane: threadPane({ title: "claude · Fix it", harness: "claude" }), project: null })).toBe(
      "Fix it",
    );
    expect(windowTitle({ page: null, pane: null, project: null })).toBe("TempCode");
  });

  it("names a file by its basename", () => {
    expect(
      windowTitle({ page: null, pane: { kind: "file", path: "/srv/x/src/main/windows.ts" }, project: "temp-code" }),
    ).toBe("windows.ts — temp-code");
  });

  it("names a terminal Terminal", () => {
    expect(windowTitle({ page: null, pane: { kind: "terminal" }, project: "temp-code" })).toBe("Terminal — temp-code");
  });

  it("reads a page alone", () => {
    expect(windowTitle({ page: "settings", pane: null, project: null })).toBe("Settings");
    expect(windowTitle({ page: "search", pane: null, project: null })).toBe("Search");
    expect(windowTitle({ page: "inbox", pane: null, project: null })).toBe("Inbox");
    expect(windowTitle({ page: "notes", pane: null, project: null })).toBe("Notes");
    expect(windowTitle({ page: "accounts", pane: null, project: null })).toBe("Accounts");
    expect(windowTitle({ page: "stats", pane: null, project: null })).toBe("Stats");
  });

  it("lets a page open over a thread win", () => {
    expect(windowTitle({ page: "settings", pane: { kind: "thread", title: "Fix the badge" }, project: "temp-code" })).toBe(
      "Settings",
    );
  });

  it("reads TempCode with nothing open", () => {
    expect(windowTitle({ page: null, pane: null, project: null })).toBe("TempCode");
  });

  it("leaves the project off when there is none", () => {
    expect(windowTitle({ page: null, pane: { kind: "thread", title: "A chat" }, project: null })).toBe("A chat");
  });
});
