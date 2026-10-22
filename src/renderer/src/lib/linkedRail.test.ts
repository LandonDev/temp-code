import { describe, expect, it } from "vitest";
import {
  aliasKeys,
  linkedWorkspaceIds,
  mergeRailItems,
  mergeRailSections,
  projectLeaders,
} from "./linkedRail";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

const ws = (id: string, path: string, environmentId: string, linkId: string | null, createdAt = 1): WorkspaceMeta =>
  ({ id, name: id, path, git: true, createdAt, environmentId, linkId }) as WorkspaceMeta;

const MAC = "/Users/me/IdeaProjects/temp-code";
const BOX = "/srv/agents/work/temp-code";
const WORKSPACES = [
  ws("w-mac", MAC, "local", "wl_tc", 5),
  ws("w-box", BOX, "env_box", "wl_tc", 2),
  ws("w-solo", "/srv/agents/work/solo", "env_box", null),
  // Same link, same host as w-box but newer: stands alone.
  ws("w-dup", "/srv/agents/work/dup", "env_box", "wl_tc", 9),
];

const item = (path: string, openedAt = 1) => ({ path, openedAt });

describe("mergeRailItems", () => {
  it("joins a link's copies into one row led by this machine's copy, where its first copy sat", () => {
    const rows = mergeRailItems([item("/srv/agents/work/solo"), item(BOX, 7), item(MAC, 3)], WORKSPACES, "local");
    expect(rows.map((r) => r.path)).toEqual(["/srv/agents/work/solo", MAC]);
    expect(rows[1]).toMatchObject({ paths: [MAC, BOX], workspaceIds: ["w-mac", "w-box"], hosts: ["local", "env_box"], openedAt: 7 });
    expect(rows[0]).toMatchObject({ paths: ["/srv/agents/work/solo"], workspaceIds: ["w-solo"], hosts: ["env_box"] });
  });

  it("leads with the oldest copy when this machine has none, and keeps a second copy on one host alone", () => {
    const rows = mergeRailItems([item("/srv/agents/work/dup"), item(MAC), item(BOX)], WORKSPACES, "env_other");
    expect(rows.map((r) => r.paths)).toEqual([["/srv/agents/work/dup"], [BOX, MAC]]);
  });

  it("leaves a copy the rail does not list out of the row", () => {
    const rows = mergeRailItems([item(BOX)], WORKSPACES, "local");
    expect(rows).toEqual([{ path: BOX, openedAt: 1, paths: [BOX], workspaceIds: ["w-box"], hosts: ["env_box"] }]);
  });

  it("knows nothing of a folder the catalog does not list", () => {
    expect(mergeRailItems([item("/tmp/x")], WORKSPACES, "local")).toEqual([
      { path: "/tmp/x", openedAt: 1, paths: ["/tmp/x"], workspaceIds: [], hosts: [] },
    ]);
  });
});

describe("mergeRailSections", () => {
  it("pins a linked row when any copy is pinned, and shows it there only", () => {
    const { pinned, projects } = mergeRailSections(
      { pinned: [item(BOX)], projects: [item(MAC), item("/srv/agents/work/solo")] },
      WORKSPACES,
      "local",
    );
    expect(pinned.map((r) => r.paths)).toEqual([[MAC, BOX]]);
    expect(projects.map((r) => r.path)).toEqual(["/srv/agents/work/solo"]);
  });
});

describe("aliasKeys", () => {
  it("maps every copy to the leader's path and id, the rest to themselves", () => {
    const alias = aliasKeys(WORKSPACES, "local");
    expect(alias.path(BOX + "/")).toBe(MAC);
    expect(alias.path(MAC)).toBe(MAC);
    expect(alias.path("/srv/agents/work/dup")).toBe("/srv/agents/work/dup");
    expect(alias.path("~")).toBe("~");
    expect(alias.workspaceId("w-box")).toBe("w-mac");
    expect(alias.workspaceId("w-solo")).toBe("w-solo");
    expect(alias.workspaceId("unknown")).toBe("unknown");
  });
});

describe("linkedWorkspaceIds", () => {
  it("names every copy leader-first from any one of them", () => {
    expect(linkedWorkspaceIds(WORKSPACES, "w-box", "local")).toEqual(["w-mac", "w-box"]);
    expect(linkedWorkspaceIds(WORKSPACES, "w-solo", "local")).toEqual(["w-solo"]);
    expect(linkedWorkspaceIds(WORKSPACES, null, "local")).toBeNull();
  });
});

describe("projectLeaders", () => {
  const p = (id: string, workspaceId: string, linkId: string | null, createdAt = 1) =>
    ({ id, workspaceId, linkId, createdAt, name: id }) as ProjectMeta;
  it("joins linked projects under the copy in the scope's first workspace", () => {
    const projects = [p("p-box", "w-box", "pl_a", 1), p("p-mac", "w-mac", "pl_a", 5), p("p-only", "w-box", null), p("p-far", "w-solo", "pl_a")];
    const leaders = projectLeaders(projects, ["w-mac", "w-box"]);
    expect(leaders.get("p-box")?.id).toBe("p-mac");
    expect(leaders.get("p-mac")?.id).toBe("p-mac");
    expect(leaders.get("p-only")?.id).toBe("p-only");
    expect(leaders.has("p-far")).toBe(false);
  });
});
