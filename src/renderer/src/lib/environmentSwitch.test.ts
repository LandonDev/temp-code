import { describe, expect, it } from "vitest";
import { workspaceToLandOn } from "./environmentSwitch";

const ws = (name: string, createdAt: number, githubRepo: string | null = null) => ({
  name,
  path: `/srv/${name}`,
  githubRepo,
  createdAt,
});
const same = (a: string, b: string) => a === b;
const pool = [ws("prisons", 1, "me/prisons"), ws("app", 2, "me/app"), ws("site", 3)];

describe("workspaceToLandOn", () => {
  it("follows the same project across hosts: by repo, then by folder name", () => {
    expect(workspaceToLandOn(pool, { ...ws("app-mac", 9, "me/app") }, "/srv/prisons", same)?.name).toBe("app");
    expect(workspaceToLandOn(pool, { ...ws("site", 9) }, "/srv/prisons", same)?.name).toBe("site");
  });
  it("else the remembered workspace, else the oldest", () => {
    expect(workspaceToLandOn(pool, ws("other", 9, "me/other"), "/srv/app", same)?.name).toBe("app");
    expect(workspaceToLandOn(pool, undefined, undefined, same)?.name).toBe("prisons");
    expect(workspaceToLandOn([], undefined, undefined, same)).toBeUndefined();
  });
});
