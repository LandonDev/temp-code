import { describe, expect, it, vi } from "vitest";

vi.mock("./native", () => ({
  invokeOn: vi.fn(),
  openWithEditor: vi.fn(),
}));
vi.mock("./connection", () => ({
  registry: { primaryEnvironmentId: "local", primary: () => ({ request: vi.fn() }), environment: () => undefined },
}));
vi.mock("./fs", () => ({ digestFiles: vi.fn(), gitBranches: vi.fn() }));
vi.mock("./tcserver/projects", () => ({
  hostOfPath: (path: string, threadHost?: string) =>
    path.startsWith("/srv/agents/") ? "env_box" : path.startsWith("/tmp/") ? (threadHost ?? "local") : "local",
  projectForCwd: () => undefined,
}));

import type { EditorConfig } from "@shared/editor";
import { editorActionLabel, editorLabelFor, planRemoteOpen, type RemoteOpenDeps } from "./openInEditor";

const config = (over: Partial<EditorConfig> = {}): EditorConfig => ({
  editor: "auto",
  installed: { idea: true, code: true, xed: true },
  effective: "idea",
  ...over,
});

describe("editorActionLabel", () => {
  it("says Open on the Mac for a file on another host and names the editor for a local one", () => {
    expect(editorActionLabel({ remote: true, config: config(), path: "/srv/agents/work/x/a.ts" })).toBe("Open on the Mac");
    expect(editorActionLabel({ remote: false, config: config(), path: "/Users/me/x/a.ts" })).toBe("Open in IntelliJ IDEA");
    expect(editorActionLabel({ remote: false, config: config({ editor: "code" }), path: "/Users/me/x/a.ts" })).toBe("Open in VS Code");
  });
  it("follows the Swift rule for the local label", () => {
    const swift = "/Users/me/x/ios/App/A.swift";
    expect(editorActionLabel({ remote: false, config: config({ editor: "xed" }), path: swift })).toBe("Open in Xcode");
    expect(editorActionLabel({ remote: false, config: config({ installed: { idea: false, code: true, xed: true } }), path: swift })).toBe("Open in Xcode");
    expect(editorActionLabel({ remote: false, config: config(), path: swift })).toBe("Open in IntelliJ IDEA");
  });
  it("hides where no editor can run or none is installed", () => {
    expect(editorActionLabel({ remote: true, config: null, path: "/srv/agents/work/x/a.ts" })).toBeNull();
    expect(editorActionLabel({ remote: false, config: config({ installed: { idea: false, code: false, xed: false } }), path: "/x" })).toBeNull();
    // A remote file still opens on the Mac when the Mac has an editor at all: the launcher decides.
    expect(editorActionLabel({ remote: true, config: config({ installed: { idea: false, code: false, xed: false } }), path: "/x" })).toBe("Open on the Mac");
  });
  it("reads the host off the path, and off the thread for a path outside every root", () => {
    expect(editorLabelFor("/srv/agents/work/temp-code/a.ts", config())).toBe("Open on the Mac");
    expect(editorLabelFor("/Users/me/IdeaProjects/temp-code/a.ts", config())).toBe("Open in IntelliJ IDEA");
    expect(editorLabelFor("/tmp/shot.png", config(), "env_box")).toBe("Open on the Mac");
    expect(editorLabelFor("/tmp/shot.png", config())).toBe("Open in IntelliJ IDEA");
    expect(editorLabelFor(null, config())).toBeNull();
  });
});

describe("planRemoteOpen", () => {
  const map = { roots: { "/Users/me/IdeaProjects/temp-code": "/srv/agents/work/temp-code" }, prefixes: {} };
  const deps = (over: Partial<RemoteOpenDeps> & { digests?: Record<string, string | null> }): RemoteOpenDeps => ({
    pathMap: async () => map,
    projectRoot: (path) => (path.startsWith("/srv/agents/work/temp-code") ? "/srv/agents/work/temp-code" : null),
    digest: async (_env, path) => over.digests?.[path] ?? null,
    isDir: async () => true,
    branch: async () => "master",
    hostName: () => "box",
    ...over,
  });
  const target = { path: "/srv/agents/work/temp-code/src/a.ts", line: 12, column: 3 };

  it("launches the Mac copy at the same line when the bytes match", async () => {
    const plan = await planRemoteOpen(target, "env_box", "local", deps({ digests: { [target.path]: "aa", "/Users/me/IdeaProjects/temp-code/src/a.ts": "aa" } }));
    expect(plan).toEqual({ kind: "launch", target: { path: "/Users/me/IdeaProjects/temp-code/src/a.ts", line: 12, column: 3 } });
  });
  it("previews with the branch here and the Mac copy as the action when the bytes differ", async () => {
    const plan = await planRemoteOpen(target, "env_box", "local", deps({ digests: { [target.path]: "aa", "/Users/me/IdeaProjects/temp-code/src/a.ts": "bb" } }));
    expect(plan).toEqual({
      kind: "preview",
      note: {
        text: "Mac copy differs: on branch master here",
        action: { label: "Open the Mac copy anyway", editor: { path: "/Users/me/IdeaProjects/temp-code/src/a.ts", line: 12, column: 3 } },
      },
    });
  });
  it("previews with the project as the action when the Mac has the project but not the file", async () => {
    const plan = await planRemoteOpen(target, "env_box", "local", deps({ digests: { [target.path]: "aa" } }));
    expect(plan).toEqual({
      kind: "preview",
      note: { text: "No Mac copy: on branch master here", action: { label: "Open the project anyway", editor: { path: "/Users/me/IdeaProjects/temp-code" } } },
    });
  });
  it("previews with no action when the project is not checked out here or nothing maps the path", async () => {
    expect(await planRemoteOpen(target, "env_box", "local", deps({ digests: { [target.path]: "aa" }, isDir: async () => false }))).toEqual({
      kind: "preview",
      note: { text: "Not checked out on the Mac" },
    });
    const elsewhere = { path: "/srv/agents/work/other/a.ts" };
    expect(await planRemoteOpen(elsewhere, "env_box", "local", deps({ digests: { [elsewhere.path]: "aa" } }))).toEqual({
      kind: "preview",
      note: { text: "Only on box" },
    });
  });
  it("never asks the Mac for a branch when the project is not here", async () => {
    const branch = vi.fn(async () => "master");
    await planRemoteOpen(target, "env_box", "local", deps({ digests: { [target.path]: "aa" }, isDir: async () => false, branch }));
    expect(branch).not.toHaveBeenCalled();
  });
});
