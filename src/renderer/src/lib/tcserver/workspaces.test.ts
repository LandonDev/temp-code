import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Link } from "./store";
import type { ProjectMeta, ServerPush, WorkspaceMeta } from "./types";
import { projectOf, workspaceByPath, workspaceIdOf, workspaceStore } from "./workspaces";
import { createProject, createWorkspace } from "./projects";

const ws = (over: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  id: "w1",
  name: "repo",
  path: "/home/me/repo",
  git: true,
  createdAt: 1,
  ...over,
});
const project = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: "p1",
  workspaceId: "w1",
  name: "Auth rewrite",
  mode: "worktree",
  branch: "tc/auth-rewrite",
  cwd: "/home/me/.temp-code/worktrees/auth-rewrite",
  archived: false,
  createdAt: 2,
  ...over,
});

describe("pure helpers", () => {
  const workspaces = [ws(), ws({ id: "w2", path: "/home/me/other/" })];
  const projects = [project()];

  it("matches a workspace by normalized path", () => {
    expect(workspaceByPath(workspaces, "/home/me/repo/")?.id).toBe("w1");
    expect(workspaceByPath(workspaces, "/home/me/other")?.id).toBe("w2");
    expect(workspaceByPath(workspaces, "~")).toBeUndefined();
    expect(workspaceByPath(workspaces, "/elsewhere")).toBeUndefined();
  });

  it("finds a session's project", () => {
    expect(projectOf(projects, { projectId: "p1" })?.name).toBe("Auth rewrite");
    expect(projectOf(projects, { projectId: null })).toBeUndefined();
  });

  it("places a session through its project, then its workspace, then its path", () => {
    const worktree = { cwd: project().cwd, projectId: "p1", workspaceId: null };
    expect(workspaceIdOf(worktree, projects, workspaces)).toBe("w1");
    const loose = { cwd: "/home/me/other", projectId: null, workspaceId: "w2" };
    expect(workspaceIdOf(loose, projects, workspaces)).toBe("w2");
    const legacy = { cwd: "/home/me/repo" };
    expect(workspaceIdOf(legacy, projects, workspaces)).toBe("w1");
    expect(workspaceIdOf({ cwd: "/nowhere" }, projects, workspaces)).toBeNull();
  });
});

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  workspaces: WorkspaceMeta[] = [];
  projects: ProjectMeta[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "workspace.list") return Promise.resolve(this.workspaces as T);
    if (method === "project.list") return Promise.resolve(this.projects as T);
    if (method === "workspace.create") {
      const meta = ws({ id: `w${this.workspaces.length + 1}`, path: (params as { path: string }).path });
      this.workspaces = [...this.workspaces, meta];
      return Promise.resolve(meta as T);
    }
    if (method === "project.create") {
      const p = params as { workspaceId: string; name: string; mode: "worktree" | "local" };
      const meta = project({ id: `p${this.projects.length + 1}`, ...p });
      this.projects = [...this.projects, meta];
      return Promise.resolve(meta as T);
    }
    if (method === "workspace.icon") return Promise.resolve({ dataUrl: "data:x", host: "github" } as T);
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void) {
    this.pushListeners.add(l);
    return () => this.pushListeners.delete(l);
  }
  onOpen(l: () => void) {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  push(p: ServerPush) {
    for (const l of this.pushListeners) l(p);
  }
  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("workspaceStore", () => {
  let link: FakeLink;
  beforeEach(() => {
    link = new FakeLink();
    link.workspaces = [ws()];
    workspaceStore.reset();
  });
  afterEach(() => workspaceStore.reset());

  it("loads both lists on connect", async () => {
    workspaceStore.connect(link);
    await tick();
    expect(workspaceStore.getSnapshot().loaded).toBe(true);
    expect(workspaceStore.workspaces.map((w) => w.id)).toEqual(["w1"]);
    expect(link.of("project.list")).toHaveLength(1);
  });

  it("follows the list pushes", async () => {
    workspaceStore.connect(link);
    await tick();
    link.push({ push: "projects", projects: [project()] });
    expect(workspaceStore.project("p1")?.name).toBe("Auth rewrite");
    link.push({ push: "workspaces", workspaces: [] });
    expect(workspaceStore.workspaces).toEqual([]);
  });

  it("commands refresh the lists after the call", async () => {
    workspaceStore.connect(link);
    await tick();
    const created = await createWorkspace("/home/me/new", link);
    expect(created.path).toBe("/home/me/new");
    expect(workspaceStore.workspace(created.id)).toBeTruthy();
    const p = await createProject({ workspaceId: "w1", name: "X", mode: "local" }, link);
    expect(workspaceStore.project(p.id)?.workspaceId).toBe("w1");
  });

  it("fetches an icon once", async () => {
    workspaceStore.connect(link);
    await tick();
    expect(workspaceStore.icon("w1")).toBeUndefined();
    expect(workspaceStore.icon("w1")).toBeUndefined();
    await tick();
    expect(workspaceStore.icon("w1")?.host).toBe("github");
    expect(link.of("workspace.icon")).toHaveLength(1);
  });
});
