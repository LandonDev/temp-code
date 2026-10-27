// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildRun, BuildTarget, EffectiveBuild, RemoteStatus } from "@server/shared/build";

const state = vi.hoisted(() => ({
  build: undefined as { run: BuildRun | null; lines: string[] } | undefined,
  effective: { command: "./gradlew shadowJar", outputs: "", source: "project" } as EffectiveBuild | null,
  remote: { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false } as RemoteStatus | null,
  cancel: vi.fn(async () => {}),
  run: vi.fn(async () => {}),
  pull: vi.fn(async () => null),
  settings: vi.fn(),
  invoke: vi.fn(async () => undefined),
}));

vi.mock("../../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/workspaces")>()),
  useProjects: () => [{ id: "p1", workspaceId: "w1", environmentId: "local", branch: "master", name: "plugin", cwd: "/w/plugin" }],
}));
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: () => ({
      request: (method: string) => {
        if (method === "build.targets") return Promise.resolve([{ branch: "master", cwd: "/w/plugin", kind: "project" }] satisfies BuildTarget[]);
        if (method === "build.effective") return Promise.resolve(state.effective);
        if (method === "build.remote") return Promise.resolve(state.remote);
        return Promise.reject(new Error(method));
      },
    }),
  },
}));
vi.mock("../../lib/projectRailStore", () => ({
  useBuild: () => state.build,
  useSync: () => undefined,
  fetchBuildStatus: async () => {},
  runBuild: state.run,
  cancelBuild: state.cancel,
  pullBranch: state.pull,
}));
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("./buildSettings", () => ({ openBuildSettings: state.settings }));
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: state.invoke,
}));

const { BuildPanel, BuildView } = await import("./BuildPanel");

const now = Date.now();
const run = (over: Partial<BuildRun> = {}): BuildRun => ({
  id: "r1",
  status: "ok",
  command: "./gradlew shadowJar",
  cwd: "/w/plugin",
  branch: "master",
  startedAt: now - 64_000,
  endedAt: now,
  outputs: [],
  ...over,
});

function view(over: Partial<Parameters<typeof BuildView>[0]> = {}) {
  const props: Parameters<typeof BuildView>[0] = {
    targets: [{ branch: "master", cwd: "/w/plugin", kind: "project" }],
    chosen: "master",
    own: "master",
    effective: { command: "./gradlew shadowJar", outputs: "", source: "project" },
    run: null,
    lines: [],
    remote: { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false },
    pulling: false,
    progress: undefined,
    pullError: null,
    error: null,
    onPick: vi.fn(),
    onBuild: vi.fn(),
    onCancel: vi.fn(),
    onFetch: vi.fn(),
    onSetCommand: vi.fn(),
    onReveal: vi.fn(),
    ...over,
  };
  render(<BuildView {...props} />);
  return props;
}

const status = (): HTMLElement => document.querySelector("[data-slot=status-mark]") as HTMLElement;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

beforeEach(() => {
  // jsdom has no scrolling and no Web Animations; the scroll area asks for both.
  Element.prototype.scrollTo = () => {};
  Element.prototype.getAnimations = () => [];
  localStorage.clear();
  state.build = undefined;
  state.effective = { command: "./gradlew shadowJar", outputs: "", source: "project" };
  state.remote = { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false };
  for (const fn of [state.cancel, state.run, state.pull, state.settings, state.invoke]) fn.mockClear();
});
afterEach(cleanup);

describe("BuildView", () => {
  it("shows the command and no status or log before any run", () => {
    view({ effective: { command: "bun run build", outputs: "", source: "detected" } });
    expect(status()).toBeNull();
    expect(document.querySelector("[data-slot=build-log]")).toBeNull();
    expect(screen.getByText("bun run build")).toBeTruthy();
    expect(screen.getByText("detected")).toBeTruthy();
  });

  it("says Working with the elapsed time while running, and Cancel cancels", () => {
    const props = view({ run: run({ status: "running", startedAt: now - 23_000, endedAt: undefined }), lines: ["> Task :classes"] });
    expect(status().dataset.state).toBe("working");
    expect(status().textContent).toMatch(/^Working2[2-4]s$/);
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByText("> Task :classes")).toBeTruthy();
  });

  it("says Done with the duration", () => {
    view({ run: run() });
    expect(status().dataset.state).toBe("done");
    expect(status().textContent).toBe("Done1m 4s");
  });

  it("says Failed with the exit code, the duration and another branch, apart, no middle dots", () => {
    view({ chosen: "raids", run: run({ status: "failed", exitCode: 1, branch: "raids", startedAt: now - 62_000 }) });
    expect(status().dataset.state).toBe("failed");
    const facts = [...status().querySelectorAll("[data-slot=status-detail] span")].map((s) => s.textContent);
    expect(facts).toEqual(["exit 1", "1m 2s", "raids"]);
    expect(document.body.textContent).not.toContain("·");
  });

  it("says Stopped for a cancelled run", () => {
    view({ run: run({ status: "cancelled" }) });
    expect(status().dataset.state).toBe("stopped");
    expect(status().textContent).toBe("Stopped");
  });

  it("offers Set one when there is no command", () => {
    const props = view({ effective: null });
    expect(screen.getByText("No build command")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Build" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Set one" }));
    expect(props.onSetCommand).toHaveBeenCalledOnce();
  });

  it("shows Fetch only when origin is ahead", () => {
    view();
    expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
    cleanup();
    const props = view({ remote: { branch: "master", upstream: true, ahead: 0, behind: 2, stale: false } });
    expect(screen.getByText("2 behind origin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(props.onFetch).toHaveBeenCalledOnce();
  });

  it("shows git's line and a bar while fetching", () => {
    view({
      remote: { branch: "master", upstream: true, ahead: 0, behind: 2, stale: false },
      pulling: true,
      progress: { branch: "master", line: "Receiving objects: 64%", percent: 64 },
    });
    expect(screen.getByText("Receiving objects: 64%")).toBeTruthy();
    expect(document.querySelector("[data-slot=progress]")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fetch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists outputs and reveals one on click and on Enter", () => {
    const props = view({
      run: run({
        outputs: [
          { path: "build/libs/plugin.jar", abs: "/w/plugin/build/libs/plugin.jar", size: 412_000, mtimeMs: now, fresh: true },
          { path: "build/libs/old.jar", abs: "/w/plugin/build/libs/old.jar", size: 1, mtimeMs: now, fresh: false },
        ],
      }),
    });
    expect(screen.getByText("Outputs")).toBeTruthy();
    expect(screen.getByText("402 KB")).toBeTruthy();
    expect(screen.getByText("Not rebuilt")).toBeTruthy();
    const row = document.querySelector('[data-output="build/libs/plugin.jar"]') as HTMLElement;
    fireEvent.click(row);
    expect(props.onReveal).toHaveBeenCalledWith("/w/plugin/build/libs/plugin.jar");
    fireEvent.keyDown(document.querySelector('[data-output="build/libs/old.jar"]') as HTMLElement, { key: "Enter" });
    expect(props.onReveal).toHaveBeenLastCalledWith("/w/plugin/build/libs/old.jar");
  });
});

describe("BuildPanel", () => {
  it("Set one opens the workspace's Build settings", async () => {
    state.effective = null;
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Set one" }));
    expect(state.settings).toHaveBeenCalledWith("w1");
  });

  it("builds, and cancels a running build", async () => {
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(state.run).toHaveBeenCalledWith("p1", undefined);
    cleanup();
    state.build = { run: run({ status: "running", endedAt: undefined }), lines: [] };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.cancel).toHaveBeenCalledWith("p1");
  });

  it("reveals an output through the native reveal", async () => {
    state.build = {
      run: run({ outputs: [{ path: "plugin.jar", abs: "/w/plugin/plugin.jar", size: 10, mtimeMs: now, fresh: true }] }),
      lines: [],
    };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(document.querySelector('[data-output="plugin.jar"]') as HTMLElement);
    expect(state.invoke).toHaveBeenCalledWith("reveal_path", { path: "/w/plugin/plugin.jar" });
  });

  it("asks for Fetch only when the branch is behind origin, and fetches", async () => {
    render(<BuildPanel projectId="p1" />);
    await flush();
    expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
    cleanup();
    state.remote = { branch: "master", upstream: true, ahead: 0, behind: 3, stale: false };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await flush();
    expect(state.pull).toHaveBeenCalledWith("p1", undefined);
  });
});
