import { describe, expect, it } from "vitest";
import type { ProjectFile } from "./fs";
import type { SessionMeta, SlashCommand } from "./tcserver/types";
import {
  commandTextParts,
  matchCommands,
  rankFiles,
  rankThreads,
  replaceTrigger,
  triggerAt,
} from "./composerTriggers";

describe("triggerAt", () => {
  it("opens command mode on a token that starts with /", () => {
    expect(triggerAt("/rev", 4)).toEqual({ mode: "command", query: "rev", start: 0 });
    expect(triggerAt("fix this /re", 12)).toEqual({ mode: "command", query: "re", start: 9 });
    expect(triggerAt("line\n/x", 7)).toEqual({ mode: "command", query: "x", start: 5 });
  });

  it("opens file mode on a token that starts with @", () => {
    expect(triggerAt("see @App", 8)).toEqual({ mode: "file", query: "App", start: 4 });
    expect(triggerAt("@", 1)).toEqual({ mode: "file", query: "", start: 0 });
  });

  it("does not trigger on paths, emails, or text after the token", () => {
    expect(triggerAt("src/foo", 7)).toBeNull();
    expect(triggerAt("/a/b", 4)).toBeNull();
    expect(triggerAt("me@x@y", 6)).toBeNull();
    expect(triggerAt("/rev done", 9)).toBeNull();
    expect(triggerAt("hello", 5)).toBeNull();
  });

  it("only reads up to the caret", () => {
    expect(triggerAt("/rev iew", 2)).toEqual({ mode: "command", query: "r", start: 0 });
  });
});

describe("replaceTrigger", () => {
  it("swaps the trigger span for the pick plus a space", () => {
    expect(replaceTrigger("fix /re now", { start: 4 }, 7, "/review")).toEqual({
      text: "fix /review  now",
      caret: 12,
    });
    expect(replaceTrigger("@Ap", { start: 0 }, 3, "@src/App.tsx")).toEqual({
      text: "@src/App.tsx ",
      caret: 13,
    });
  });
});

const cmd = (name: string, source: SlashCommand["source"], scope: SlashCommand["scope"] = "user") => ({
  name,
  description: "",
  source,
  scope,
});

describe("matchCommands", () => {
  const all = [
    cmd("review", "command"),
    cmd("linear", "plugin"),
    cmd("deploy", "skill"),
    cmd("brew", "prompt"),
    cmd("github", "mcp"),
    cmd("arch", "skill"),
  ];

  it("matches by substring on the name, case-insensitive", () => {
    expect(matchCommands(all, "RE").map((c) => c.name)).toEqual(["review", "brew"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
  });

  it("sorts by source order then name", () => {
    expect(matchCommands(all, "").map((c) => c.name)).toEqual([
      "linear",
      "github",
      "arch",
      "deploy",
      "review",
      "brew",
    ]);
  });
});

const file = (relative: string): ProjectFile => ({
  name: relative.slice(relative.lastIndexOf("/") + 1),
  path: `/p/${relative}`,
  relative,
});

describe("rankFiles", () => {
  const files = [
    file("src/chrome/Composer.tsx"),
    file("src/App.tsx"),
    file("apps/web/src/App.tsx"),
    file("docs/composing.md"),
  ];

  it("lists the first entries without a query", () => {
    expect(rankFiles(files, "", 2).map((f) => f.relative)).toEqual([
      "src/chrome/Composer.tsx",
      "src/App.tsx",
    ]);
  });

  it("prefers basename prefix, then path prefix, then substring; shorter wins ties", () => {
    expect(rankFiles(files, "app").map((f) => f.relative)).toEqual([
      "src/App.tsx",
      "apps/web/src/App.tsx",
    ]);
    expect(rankFiles(files, "compos").map((f) => f.relative)).toEqual([
      "docs/composing.md",
      "src/chrome/Composer.tsx",
    ]);
    expect(rankFiles(files, "src/").map((f) => f.relative)).toEqual([
      "src/App.tsx",
      "src/chrome/Composer.tsx",
      "apps/web/src/App.tsx",
    ]);
  });
});

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    id: "s",
    parentId: null,
    projectId: null,
    title: "",
    status: "idle",
    archived: false,
    updatedAt: 0,
    ...over,
  }) as SessionMeta;

describe("rankThreads", () => {
  const sessions = [
    meta({ id: "me", title: "Current", projectId: "p1", updatedAt: 9 }),
    meta({ id: "a", title: "Auth rewrite", projectId: "p1", updatedAt: 5 }),
    meta({ id: "b", title: "Billing", projectId: "p2", updatedAt: 8 }),
    meta({ id: "c", title: "Child", parentId: "a", projectId: "p1", updatedAt: 7 }),
    meta({ id: "d", title: "Old auth", projectId: "p1", updatedAt: 1, archived: true }),
    meta({ id: "e", title: "Editor", projectId: "p1", updatedAt: 6 }),
    meta({ id: "f", title: "Fleet", projectId: "p1", updatedAt: 2 }),
  ];

  it("skips the current thread, children, and archived ones; current project first", () => {
    expect(rankThreads(sessions, "", "me", "p1").map((s) => s.id)).toEqual(["e", "a", "f"]);
  });

  it("filters by title and widens to five with a query", () => {
    expect(rankThreads(sessions, "auth", "me", "p1").map((s) => s.id)).toEqual(["a"]);
    expect(rankThreads(sessions, "", "me", "p2").map((s) => s.id)).toEqual(["b", "e", "a"]);
    expect(rankThreads(sessions, "i", "me", "p1").map((s) => s.id)).toEqual(["e", "a", "b"]);
  });
});

describe("commandTextParts", () => {
  const known = new Map([
    ["review", cmd("review", "command")],
    ["linear", cmd("linear", "plugin")],
  ]);

  it("splits known tokens out and leaves the rest as text", () => {
    expect(commandTextParts("run /review then /nope on /linear", known)).toEqual([
      { text: "run " },
      { text: "/review", command: known.get("review") },
      { text: " then /nope on " },
      { text: "/linear", command: known.get("linear") },
    ]);
  });

  it("ignores tokens inside a blockquote and returns plain text when nothing is known", () => {
    expect(commandTextParts("> /review", known)).toEqual([{ text: "> /review" }]);
    expect(commandTextParts("/review", new Map())).toEqual([{ text: "/review" }]);
    expect(commandTextParts("", known)).toEqual([]);
  });
});
