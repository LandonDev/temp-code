import { describe, expect, it } from "vitest";
import type { Environment } from "./connection/types";
import { groupByEnvironment, mergeRailItems, mergeRailSections } from "./environmentGroups";
import { clusterView } from "./projectMerge";
import type { WorkspaceMeta } from "./tcserver/types";

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });

describe("groupByEnvironment", () => {
  it("splits rows by host in registry order, unclaimed folders on this machine, empty hosts kept", () => {
    const items = [{ path: "/a", openedAt: 1 }, { path: "/srv/agents/work/b", openedAt: 2 }, { path: "/c", openedAt: 3 }];
    const owner = (path: string) => (path.startsWith("/srv/") ? "box" : path === "/c" ? undefined : "local");
    const groups = groupByEnvironment(items, [env("local", "This Mac"), env("box", "box"), env("mini", "mini")], owner);
    expect(groups.map((g) => [g.environment.id, g.items.map((i) => i.path)])).toEqual([
      ["local", ["/a", "/c"]],
      ["box", ["/srv/agents/work/b"]],
      ["mini", []],
    ]);
  });
  it("drops a row whose host is gone when there is no group at all", () => {
    expect(groupByEnvironment([{ path: "/a", openedAt: 1 }], [], () => "x")).toEqual([]);
  });
});

const ws = (id: string, path: string, environmentId: string, githubRepo: string | null = null): WorkspaceMeta =>
  ({ id, name: id, path, git: true, githubRepo, createdAt: 1, environmentId }) as WorkspaceMeta;

const workspaces = [
  ws("m1", "/Users/landon/IdeaProjects/temp-code", "local"),
  ws("m2", "/Users/landon/Desktop/Websites/only-mac", "local"),
  ws("b1", "/srv/agents/work/temp-code", "box"),
  ws("b2", "/srv/agents/work/only-box", "box"),
];
const owner = (path: string) => workspaces.find((w) => w.path === path)?.environmentId;
const view = clusterView(workspaces, { roots: {}, prefixes: {} }, true);

describe("mergeRailItems", () => {
  it("makes one row of a project on two hosts, led by this machine's checkout, in first-member order", () => {
    const items = [
      { path: "/srv/agents/work/only-box", openedAt: 1 },
      { path: "/srv/agents/work/temp-code", openedAt: 2 },
      { path: "/Users/landon/Desktop/Websites/only-mac", openedAt: 3 },
      { path: "/Users/landon/IdeaProjects/temp-code", openedAt: 4 },
    ];
    const rows = mergeRailItems(items, view, "local", owner);
    expect(rows.map((r) => [r.path, r.paths, r.hosts])).toEqual([
      ["/srv/agents/work/only-box", ["/srv/agents/work/only-box"], ["box"]],
      ["/Users/landon/IdeaProjects/temp-code", ["/Users/landon/IdeaProjects/temp-code", "/srv/agents/work/temp-code"], ["local", "box"]],
      ["/Users/landon/Desktop/Websites/only-mac", ["/Users/landon/Desktop/Websites/only-mac"], ["local"]],
    ]);
    expect(rows[1].openedAt).toBe(4);
    expect(rows[1].key).toBe("/srv/agents/work/temp-code");
  });
  it("leaves every row alone when the view is not merged, and when a member is not listed", () => {
    const alone = clusterView(workspaces, { roots: {}, prefixes: {} }, false);
    const items = [{ path: "/Users/landon/IdeaProjects/temp-code", openedAt: 1 }, { path: "/srv/agents/work/temp-code", openedAt: 2 }];
    expect(mergeRailItems(items, alone, "local", owner).map((r) => r.paths)).toEqual([[items[0].path], [items[1].path]]);
    expect(mergeRailItems([items[1]], view, "local", owner).map((r) => [r.path, r.hosts])).toEqual([[items[1].path, ["box"]]]);
  });
});

describe("mergeRailSections", () => {
  it("pins the project when either checkout is pinned and lists it once", () => {
    const sections = {
      pinned: [{ path: "/srv/agents/work/temp-code", openedAt: 2 }],
      projects: [{ path: "/Users/landon/IdeaProjects/temp-code", openedAt: 4 }, { path: "/srv/agents/work/only-box", openedAt: 1 }],
    };
    const out = mergeRailSections(sections, view, "local", owner);
    expect(out.pinned.map((r) => [r.path, r.paths.length])).toEqual([["/Users/landon/IdeaProjects/temp-code", 2]]);
    expect(out.projects.map((r) => r.path)).toEqual(["/srv/agents/work/only-box"]);
  });
});
