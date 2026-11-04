import { describe, expect, it } from "vitest";
import type { ProjectMeta, WorkspaceMeta } from "@server/shared/domain";
import { controlLabel, scopeOf, shortName, sourceLine } from "./accountScope";

const ws: WorkspaceMeta = { id: "w", name: "Site", path: "/s", git: true, accountPins: { claude: "ws@x.com" }, createdAt: 1 };
const project: ProjectMeta = { id: "p", workspaceId: "w", name: "Alpha", mode: "local", branch: null, cwd: "/s", archived: false, accountPins: { codex: "proj-codex" }, createdAt: 1 };
const profiles = [
  { name: "ws@x.com", email: "ws@x.com", createdAt: 1, active: false },
  { name: "me@x.com", email: "me@x.com", nickname: "Main", createdAt: 1, active: false },
];
const accounts = { pinned: null, owner: null, profiles, reports: [] };

describe("scopeOf", () => {
  it("reads the inherited pin per provider and the current account; the current one is shown over the pin", () => {
    expect(scopeOf({ provider: "claude", account: "b@x.com", projectId: "p" }, [project], [ws])).toEqual({
      provider: "claude",
      inherited: { name: "ws@x.com", level: "workspace", from: "Site" },
      current: "b@x.com",
      shown: "b@x.com",
    });
    expect(scopeOf({ provider: "codex", account: null, projectId: "p" }, [project], [ws])).toMatchObject({
      inherited: { name: "proj-codex", level: "project", from: "Alpha" },
      shown: "proj-codex",
    });
    expect(scopeOf({ provider: "claude", account: null, workspaceId: "w" }, [], [ws])?.shown).toBe("ws@x.com");
    expect(scopeOf({ provider: "claude", account: null }, [], [])).toEqual({ provider: "claude", inherited: null, current: null, shown: null });
    expect(scopeOf({ provider: "cursor", account: "x" }, [], [])).toBeNull();
    expect(scopeOf(null, [], [])).toBeNull();
  });

  it("a Meta row under either harness is scoped to Meta's keys and reads Meta's pin, never the harness's", () => {
    const metaWs: WorkspaceMeta = { ...ws, accountPins: { claude: "ws@x.com", meta: "Work key" } };
    expect(scopeOf({ provider: "claude", model: "muse-wonder-1.0", account: null, workspaceId: "w" }, [], [metaWs])).toEqual({
      provider: "meta",
      inherited: { name: "Work key", level: "workspace", from: "Site" },
      current: null,
      shown: "Work key",
    });
    expect(scopeOf({ provider: "codex", model: "muse-spark-1.3", account: "Spare key", projectId: "p" }, [project], [ws])).toEqual({
      provider: "meta",
      inherited: null,
      current: "Spare key",
      shown: "Spare key",
    });
    // The harness's own models keep the harness's scope.
    expect(scopeOf({ provider: "claude", model: "claude-opus-5-5", account: null, workspaceId: "w" }, [], [metaWs])?.provider).toBe("claude");
  });
});

describe("labels", () => {
  it("names the source: the scope pin, else auto", () => {
    const inherited = scopeOf({ provider: "claude", projectId: "p" }, [project], [ws])!;
    const auto = scopeOf({ provider: "claude" }, [], [])!;
    expect(sourceLine(inherited)).toBe("From workspace Site");
    expect(sourceLine(auto)).toBe("Auto, picked by model");
  });
  it("the control shows the nickname, else the email's local part, else nothing while unknown", () => {
    expect(shortName(profiles[1])).toBe("Main");
    expect(shortName(profiles[0])).toBe("ws");
    expect(shortName({ name: "plain", createdAt: 1, active: false })).toBe("plain");
    expect(controlLabel(scopeOf({ provider: "claude", account: "me@x.com" }, [], [])!, accounts)).toBe("Main");
    expect(controlLabel(scopeOf({ provider: "claude", account: "gone@x.com" }, [], [])!, accounts)).toBe("gone@x.com");
    expect(controlLabel(scopeOf({ provider: "claude" }, [], [])!, accounts)).toBeNull();
  });
});

describe("a key account's label", () => {
  it("is its name", () => {
    const key = { name: "me@work", createdAt: 1, active: false, static: true, kind: "key" as const };
    // Never cut at an @ as an email would be.
    expect(shortName(key)).toBe("me@work");
    const scope = scopeOf({ provider: "claude", model: "muse-wonder-1.0", account: "me@work" }, [], [])!;
    expect(controlLabel(scope, { pinned: null, owner: null, profiles: [key], reports: [] })).toBe("me@work");
  });
});

