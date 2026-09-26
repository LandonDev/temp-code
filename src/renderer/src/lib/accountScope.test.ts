import { describe, expect, it } from "vitest";
import type { ProjectMeta, WorkspaceMeta } from "@server/shared/domain";
import { autoLine, controlLabel, scopeOf, shortName, sourceLine } from "./accountScope";

const ws: WorkspaceMeta = { id: "w", name: "Site", path: "/s", git: true, accountPins: { claude: "ws@x.com" }, createdAt: 1 };
const project: ProjectMeta = { id: "p", workspaceId: "w", name: "Alpha", mode: "local", branch: null, cwd: "/s", archived: false, accountPins: { codex: "proj-codex" }, createdAt: 1 };
const profiles = [
  { name: "ws@x.com", email: "ws@x.com", createdAt: 1, active: false },
  { name: "me@x.com", email: "me@x.com", nickname: "Main", createdAt: 1, active: false },
];
const accounts = { pinned: null, owner: null, profiles, reports: [] };

describe("scopeOf", () => {
  it("reads the thread pin, the inherited pin per provider, and the current account", () => {
    expect(scopeOf({ provider: "claude", accountPin: "me@x.com", account: "b@x.com", projectId: "p" }, [project], [ws])).toEqual({
      provider: "claude",
      pin: "me@x.com",
      inherited: { name: "ws@x.com", level: "workspace", from: "Site" },
      current: "b@x.com",
      shown: "b@x.com",
    });
    expect(scopeOf({ provider: "codex", accountPin: null, account: null, projectId: "p" }, [project], [ws])).toMatchObject({
      inherited: { name: "proj-codex", level: "project", from: "Alpha" },
      shown: "proj-codex",
    });
    expect(scopeOf({ provider: "claude", accountPin: null, account: null, workspaceId: "w" }, [], [ws])?.shown).toBe("ws@x.com");
    expect(scopeOf({ provider: "claude", accountPin: null, account: null }, [], [])).toMatchObject({ pin: null, inherited: null, current: null, shown: null });
    expect(scopeOf({ provider: "cursor", accountPin: "x" }, [], [])).toBeNull();
    expect(scopeOf(null, [], [])).toBeNull();
  });
});

describe("labels", () => {
  it("names the source and what Auto falls back to", () => {
    const pinned = scopeOf({ provider: "claude", accountPin: "me@x.com", projectId: "p" }, [project], [ws])!;
    const inherited = scopeOf({ provider: "claude", projectId: "p" }, [project], [ws])!;
    const auto = scopeOf({ provider: "claude" }, [], [])!;
    expect(sourceLine(pinned)).toBe("Pinned to this thread");
    expect(sourceLine(inherited)).toBe("From workspace Site");
    expect(sourceLine(auto)).toBe("Auto · picked by model");
    expect(autoLine(inherited, profiles)).toBe("Workspace Site · ws");
    expect(autoLine(auto, profiles)).toBe("Picked by model, moved when it runs out");
  });
  it("the control shows the nickname, else the email's local part, else Auto", () => {
    expect(shortName(profiles[1])).toBe("Main");
    expect(shortName(profiles[0])).toBe("ws");
    expect(shortName({ name: "plain", createdAt: 1, active: false })).toBe("plain");
    expect(controlLabel(scopeOf({ provider: "claude", account: "me@x.com" }, [], [])!, accounts)).toBe("Main");
    expect(controlLabel(scopeOf({ provider: "claude", accountPin: "gone@x.com" }, [], [])!, accounts)).toBe("gone@x.com");
    expect(controlLabel(scopeOf({ provider: "claude" }, [], [])!, accounts)).toBe("Auto");
  });
});
