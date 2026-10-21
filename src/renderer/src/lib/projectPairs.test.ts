import { describe, expect, it } from "vitest";
import { pairKey, pairOf, pairWorkspaces, partnersOf, relativeInPair } from "./projectPairs";
import type { WorkspaceMeta } from "./tcserver/types";

const ws = (environmentId: string, path: string, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta =>
  ({
    id: `${environmentId}:${path}`,
    name: path.split("/").pop() ?? path,
    path,
    git: true,
    createdAt: 1,
    environmentId,
    ...extra,
  }) as WorkspaceMeta;

describe("pairWorkspaces", () => {
  it("pairs two hosts' copies by GitHub repo, else by folder name, one member per host", () => {
    const pairs = pairWorkspaces([
      ws("local", "/Users/me/IdeaProjects/temp-code", { githubRepo: "LandonDev/temp-code" }),
      ws("box", "/srv/agents/work/temp-code/", { githubRepo: "landondev/TEMP-CODE" }),
      ws("local", "/Users/me/shop"),
      ws("box", "/srv/agents/work/shop"),
      ws("box", "/srv/agents/work/other/shop"),
      ws("local", "/Users/me/solo"),
    ]);
    expect(pairs.map((p) => [p.id, p.members.map((m) => `${m.environmentId}:${m.cwd}`)])).toEqual([
      ["repo:landondev/temp-code", ["local:/Users/me/IdeaProjects/temp-code", "box:/srv/agents/work/temp-code"]],
      ["name:shop", ["local:/Users/me/shop", "box:/srv/agents/work/shop"]],
      ["name:solo", ["local:/Users/me/solo"]],
    ]);
    expect(pairs[0].name).toBe("temp-code");
  });

  it("keys on the repo when known, the folder name otherwise", () => {
    expect(pairKey({ path: "/a/B", githubRepo: "O/R" })).toBe("repo:o/r");
    expect(pairKey({ path: "/a/B/", githubRepo: null })).toBe("name:b");
    expect(pairKey({ path: "/a/B" })).toBe("name:b");
  });
});

describe("pairOf, relativeInPair, partnersOf", () => {
  const pairs = pairWorkspaces([
    ws("local", "/Users/me/app"),
    ws("box", "/work/app"),
    ws("box", "/work/app/vendor/lib", { name: "lib" }),
  ]);

  it("finds the deepest member folder holding a path on that host", () => {
    expect(pairOf(pairs, "box", "/work/app/src/x.ts")?.pair.id).toBe("name:app");
    expect(pairOf(pairs, "box", "/work/app/vendor/lib/y.ts")?.pair.id).toBe("name:lib");
    expect(pairOf(pairs, "box", "/work/application/z.ts")).toBeUndefined();
    expect(pairOf(pairs, "local", "/work/app/src/x.ts")).toBeUndefined();
  });

  it("gives the path relative to its member's folder", () => {
    expect(relativeInPair(pairs, "local", "/Users/me/app/src/x.ts")).toEqual({ pair: pairs[0], relative: "src/x.ts" });
    expect(relativeInPair(pairs, "box", "/work/app")).toEqual({ pair: pairs[0], relative: "" });
    expect(relativeInPair(pairs, "box", "/elsewhere")).toBeUndefined();
  });

  it("names the other hosts' copies", () => {
    expect(partnersOf(pairs, "local", "/Users/me/app/README.md")).toEqual([{ environmentId: "box", cwd: "/work/app", name: "app" }]);
    expect(partnersOf(pairs, "box", "/work/app/vendor/lib/y.ts")).toEqual([]);
  });
});
