import { describe, expect, it } from "vitest";
import type { Catalog } from "./projectContext";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { threadsToMarkRead } from "./markRead";

const catalog: Catalog = {
  workspaces: [{ id: "w1", path: "/srv/work", environmentId: "env_box" } as WorkspaceMeta],
  projects: [{ id: "p1", workspaceId: "w1", cwd: "/srv/work/app", archived: false, environmentId: "env_box" } as ProjectMeta],
};

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s",
    environmentId: "local",
    parentId: null,
    projectId: null,
    workspaceId: null,
    cwd: "/tmp/a",
    archived: false,
    updatedAt: 10,
    ...over,
  } as SessionMeta;
}

const metas = [
  meta({ id: "a", cwd: "/tmp/a", updatedAt: 10 }),
  meta({ id: "a-child", cwd: "/tmp/a", parentId: "a", updatedAt: 12 }),
  meta({ id: "b", projectId: "p1", cwd: "/srv/work/app", environmentId: "env_box", updatedAt: 500 }),
  meta({ id: "gone", cwd: "/tmp/a", archived: true, updatedAt: 900 }),
];

describe("threadsToMarkRead", () => {
  it("picks every live thread on one workspace, subagents included, by the workspace's path", () => {
    expect(threadsToMarkRead(metas, catalog, "/tmp/a/", 100)).toEqual({ ids: ["a", "a-child"], at: 100 });
    expect(threadsToMarkRead(metas, catalog, "/srv/work", 100)).toEqual({ ids: ["b"], at: 500 });
  });

  it("picks every live thread on every host for null", () => {
    expect(threadsToMarkRead(metas, catalog, null, 100)).toEqual({ ids: ["a", "a-child", "b"], at: 500 });
  });
});
