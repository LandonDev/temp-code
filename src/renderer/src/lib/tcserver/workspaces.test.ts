import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Link } from "./store";
import type { ProjectMeta, ServerPush, ThreadDefaults, WorkspaceMeta } from "./types";
import { projectIndex, projectOf, workspaceByPath, workspaceIdOf, workspaceIndex, workspaceStore } from "./workspaces";
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

  it("indexes a catalog array once and again only for a new array", () => {
    expect(projectIndex(projects)).toBe(projectIndex(projects));
    expect(projectIndex([...projects])).not.toBe(projectIndex(projects));
    expect(projectIndex(projects).get("p1")?.name).toBe("Auth rewrite");
    const index = workspaceIndex(workspaces);
    expect(workspaceIndex(workspaces)).toBe(index);
    expect(index.byId.get("w2")?.path).toBe("/home/me/other/");
    expect(index.byKey.get("/home/me/repo")?.id).toBe("w1");
    // Two workspaces at one path: the first listed wins, as find() did.
    const twice = [...workspaces, { ...workspaces[0], id: "w1-dup" }];
    expect(workspaceByPath(twice, "/home/me/repo")?.id).toBe("w1");
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

describe("thread defaults", () => {
  const set = (over: Partial<ThreadDefaults> = {}): ThreadDefaults => ({
    provider: "claude",
    model: "",
    reasoning: "medium",
    permission: "edits",
    ...over,
  });

  class DefaultsLink extends FakeLink {
    stored = new Map<string, ThreadDefaults>();
    request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "defaults.get") {
        const { workspaceId } = params as { workspaceId: string | null };
        const own = this.stored.get(workspaceId ?? "");
        const result = {
          defaults: own ?? (workspaceId ? this.stored.get("") : undefined) ?? set(),
          overridden: own !== undefined,
        };
        this.calls.push({ method, params });
        return Promise.resolve(result as T);
      }
      if (method === "defaults.set") {
        const { workspaceId, defaults } = params as { workspaceId: string | null; defaults: ThreadDefaults | null };
        if (defaults) this.stored.set(workspaceId ?? "", defaults);
        else this.stored.delete(workspaceId ?? "");
        this.calls.push({ method, params });
        return Promise.resolve(null as T);
      }
      return super.request(method, params);
    }
  }

  let link: DefaultsLink;
  beforeEach(() => {
    link = new DefaultsLink();
    link.workspaces = [ws(), ws({ id: "w2", path: "/home/me/other" })];
    workspaceStore.reset();
  });
  afterEach(() => workspaceStore.reset());

  it("parses the wrapper: an inherited scope carries the global set without the override bit", async () => {
    link.stored.set("", set({ reasoning: "high" }));
    link.stored.set("w2", set({ provider: "codex", model: "gpt-6-astra" }));
    workspaceStore.connect(link);
    await tick();
    await tick();
    expect(workspaceStore.defaultsAt(null)).toEqual({ defaults: set({ reasoning: "high" }), overridden: true });
    expect(workspaceStore.defaultsAt("w1")).toEqual({ defaults: set({ reasoning: "high" }), overridden: false });
    expect(workspaceStore.defaultsAt("w2")?.overridden).toBe(true);
    expect(workspaceStore.defaultsFor("w1")?.reasoning).toBe("high");
    expect(workspaceStore.defaultsFor("w2")?.provider).toBe("codex");
    expect(workspaceStore.defaultsFor(null)?.reasoning).toBe("high");
  });

  it("is undefined before anything loads, then the built-in set when nothing is stored", async () => {
    expect(workspaceStore.defaultsFor("w1")).toBeUndefined();
    workspaceStore.connect(link);
    await tick();
    await tick();
    expect(workspaceStore.defaultsAt(null)).toEqual({ defaults: set(), overridden: false });
    expect(workspaceStore.defaultsFor("w1")).toEqual(set());
  });

  it("a workspace override marks the scope and leaves the global set alone", async () => {
    workspaceStore.connect(link);
    await tick();
    await tick();
    await workspaceStore.saveDefaults("w1", set({ permission: "auto" }));
    expect(workspaceStore.defaultsAt("w1")).toEqual({ defaults: set({ permission: "auto" }), overridden: true });
    expect(workspaceStore.defaultsAt(null)?.overridden).toBe(false);
    expect(workspaceStore.defaultsFor("w2")).toEqual(set());
  });

  it("a global change reaches every workspace without its own override", async () => {
    link.stored.set("w2", set({ provider: "cursor" }));
    workspaceStore.connect(link);
    await tick();
    await tick();
    await workspaceStore.saveDefaults(null, set({ reasoning: "max" }));
    expect(workspaceStore.defaultsAt(null)).toEqual({ defaults: set({ reasoning: "max" }), overridden: true });
    expect(workspaceStore.defaultsFor("w1")?.reasoning).toBe("max");
    expect(workspaceStore.defaultsAt("w1")?.overridden).toBe(false);
    expect(workspaceStore.defaultsFor("w2")).toEqual(set({ provider: "cursor" }));
  });

  it("reset: a workspace falls back to the global set, the global set to the built-in one", async () => {
    link.stored.set("", set({ reasoning: "low" }));
    link.stored.set("w1", set({ provider: "codex" }));
    workspaceStore.connect(link);
    await tick();
    await tick();
    await workspaceStore.saveDefaults("w1", null);
    expect(link.of("defaults.set").at(-1)?.params).toEqual({ workspaceId: "w1", defaults: null });
    expect(workspaceStore.defaultsAt("w1")).toEqual({ defaults: set({ reasoning: "low" }), overridden: false });
    await workspaceStore.saveDefaults(null, null);
    expect(workspaceStore.defaultsAt(null)).toEqual({ defaults: set(), overridden: false });
    expect(workspaceStore.defaultsFor("w1")).toEqual(set());
  });

  it("a failed load keeps what it had", async () => {
    workspaceStore.connect(link);
    await tick();
    await tick();
    link.request = () => Promise.reject(new Error("down"));
    expect(await workspaceStore.loadDefaults("w1")).toEqual({ defaults: set(), overridden: false });
  });
});
