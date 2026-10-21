import { describe, expect, it } from "vitest";
import { clusterWorkspaces, projectKey, workRootOf, type PathMap } from "./projectIdentity";

const shipped: PathMap = {
  roots: {
    "/Users/landon/IdeaProjects/temp-code": "/srv/agents/work/temp-code",
    "/Users/landon/Desktop/Websites/cosmicweb": "/srv/agents/work/cosmicweb",
  },
  prefixes: {
    "/Users/landon/.temp-code/worktrees": "/srv/agents/home/.temp-code/worktrees",
    "/Users/landon": "/srv/agents/home",
  },
};

describe("projectKey", () => {
  it("lands a mapped root on its destination, and the destination on itself", () => {
    expect(projectKey("/Users/landon/IdeaProjects/temp-code", shipped)).toBe("/srv/agents/work/temp-code");
    expect(projectKey("/Users/landon/IdeaProjects/temp-code/", shipped)).toBe("/srv/agents/work/temp-code");
    expect(projectKey("/srv/agents/work/temp-code", shipped)).toBe("/srv/agents/work/temp-code");
  });
  it("folds IdeaProjects and Desktop/Websites children under the work root without a root of their own", () => {
    expect(projectKey("/Users/landon/IdeaProjects/monocode", shipped)).toBe("/srv/agents/work/monocode");
    expect(projectKey("/Users/landon/Desktop/Websites/HSSports", shipped)).toBe("/srv/agents/work/HSSports");
    expect(projectKey("/Users/landon/IdeaProjects/monocode")).toBe("/srv/agents/work/monocode");
  });
  it("sends anything else through the prefixes, else leaves it alone", () => {
    expect(projectKey("/Users/landon/.temp-code/worktrees/x", shipped)).toBe("/srv/agents/home/.temp-code/worktrees/x");
    expect(projectKey("/Users/landon/scratch", shipped)).toBe("/srv/agents/home/scratch");
    expect(projectKey("/opt/other", shipped)).toBe("/opt/other");
    expect(projectKey("/Users/landon/IdeaProjects", shipped)).toBe("/srv/agents/home/IdeaProjects");
  });
  it("infers the work root from the map's roots", () => {
    expect(workRootOf({ roots: { "/Users/me/IdeaProjects/a": "/work/a", "/Users/me/IdeaProjects/b": "/work/b" }, prefixes: {} })).toBe("/work");
    expect(workRootOf({ roots: {}, prefixes: {} })).toBe("/srv/agents/work");
    expect(projectKey("/Users/me/Desktop/Websites/c", { roots: { "/Users/me/IdeaProjects/a": "/work/a" }, prefixes: {} })).toBe("/work/c");
  });
});

describe("clusterWorkspaces", () => {
  const ws = (id: string, path: string, environmentId: string, githubRepo: string | null = null) => ({ id, path, environmentId, githubRepo });

  it("joins the Mac and box checkouts of one project and keeps a one-host workspace alone", () => {
    const clusters = clusterWorkspaces(
      [
        ws("m1", "/Users/landon/IdeaProjects/temp-code", "local"),
        ws("m2", "/Users/landon/Desktop/Websites/only-here", "local"),
        ws("b1", "/srv/agents/work/temp-code", "box"),
        ws("b2", "/srv/agents/work/only-there", "box"),
      ],
      shipped,
    );
    expect(clusters.map((c) => [c.key, c.members.map((m) => m.id), c.hosts])).toEqual([
      ["/srv/agents/work/temp-code", ["m1", "b1"], ["local", "box"]],
      ["/srv/agents/work/only-here", ["m2"], ["local"]],
      ["/srv/agents/work/only-there", ["b2"], ["box"]],
    ]);
  });
  it("joins on a shared git origin when the paths do not correspond", () => {
    const clusters = clusterWorkspaces([
      ws("m", "/Users/landon/code/site", "local", "landon/site"),
      ws("b", "/srv/agents/work/site-v2", "box", "landon/site"),
      ws("o", "/srv/agents/work/other", "box", "landon/other"),
    ]);
    expect(clusters.map((c) => c.members.map((m) => m.id))).toEqual([["m", "b"], ["o"]]);
    expect(clusters[0].key).toBe("/Users/landon/code/site");
  });
  it("never joins two workspaces on the same host, even with one origin", () => {
    const clusters = clusterWorkspaces([
      ws("a", "/Users/landon/IdeaProjects/x", "local", "l/x"),
      ws("b", "/Users/landon/clones/x", "local", "l/x"),
    ]);
    expect(clusters).toHaveLength(2);
  });
  it("keeps the first-member order and a stable key", () => {
    const clusters = clusterWorkspaces([
      ws("b", "/srv/agents/work/zeta", "box"),
      ws("m", "/Users/landon/IdeaProjects/alpha", "local"),
      ws("m2", "/Users/landon/IdeaProjects/zeta", "local"),
    ]);
    expect(clusters.map((c) => c.key)).toEqual(["/srv/agents/work/zeta", "/srv/agents/work/alpha"]);
    expect(clusters[0].members.map((m) => m.id)).toEqual(["b", "m2"]);
  });
  it("is empty for no workspaces", () => {
    expect(clusterWorkspaces([])).toEqual([]);
  });
});
