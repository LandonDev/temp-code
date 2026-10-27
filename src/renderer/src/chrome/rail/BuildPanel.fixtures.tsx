import type { BuildRun, BuildTarget, EffectiveBuild, RemoteStatus } from "@server/shared/build";

const now = Date.now();
const targets: BuildTarget[] = [
  { branch: "master", cwd: "/srv/agents/work/plugin", kind: "project" },
  { branch: "feature/raids", cwd: "/srv/agents/work/plugin/.claude/worktrees/raids", kind: "checkout" },
  { branch: "release/1.4", cwd: null, kind: "branch" },
];
const effective: EffectiveBuild = { command: "./gradlew shadowJar", outputs: "build/libs/*.jar", source: "project" };
const current: RemoteStatus = { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false };
const log = [
  "> Task :compileJava",
  "> Task :processResources UP-TO-DATE",
  "> Task :classes",
  "> Task :shadowJar",
  "BUILD SUCCESSFUL in 1m 4s",
  "7 actionable tasks: 4 executed, 3 up-to-date",
];
const run = (over: Partial<BuildRun>): BuildRun => ({
  id: "run1",
  status: "ok",
  command: effective.command,
  cwd: "/srv/agents/work/plugin",
  branch: "master",
  startedAt: now - 64_000,
  endedAt: now,
  outputs: [],
  ...over,
});
const base = {
  targets,
  chosen: "master",
  own: "master",
  effective,
  run: null,
  lines: [],
  remote: current,
  pulling: false,
  progress: undefined,
  pullError: null,
  error: null,
  onPick: "fn",
  onBuild: "fn",
  onCancel: "fn",
  onFetch: "fn",
  onSetCommand: "fn",
  onReveal: "fn",
};

export default [
  { name: "no command", props: { ...base, effective: null } },
  { name: "never run", props: { ...base, effective: { ...effective, source: "detected" } } },
  {
    name: "running with log",
    props: { ...base, run: run({ status: "running", startedAt: now - 23_000, endedAt: undefined }), lines: log.slice(0, 4) },
  },
  {
    name: "failed",
    props: {
      ...base,
      chosen: "feature/raids",
      run: run({ status: "failed", exitCode: 1, branch: "feature/raids", startedAt: now - 62_000 }),
      lines: [...log.slice(0, 3), "error: cannot find symbol RaidTimer", "BUILD FAILED in 1m 2s"],
    },
  },
  {
    name: "done with outputs",
    props: {
      ...base,
      run: run({
        outputs: [
          { path: "build/libs/plugin-1.4.0-all.jar", abs: "/srv/agents/work/plugin/build/libs/plugin-1.4.0-all.jar", size: 18_400_000, mtimeMs: now, fresh: true },
          { path: "build/libs/plugin-1.4.0.jar", abs: "/srv/agents/work/plugin/build/libs/plugin-1.4.0.jar", size: 412_000, mtimeMs: now, fresh: true },
          { path: "build/libs/plugin-1.3.9.jar", abs: "/srv/agents/work/plugin/build/libs/plugin-1.3.9.jar", size: 401_000, mtimeMs: now - 86_400_000, fresh: false },
        ],
      }),
      lines: log,
    },
  },
  { name: "behind origin", props: { ...base, remote: { ...current, behind: 2 } } },
  {
    name: "fetching",
    props: {
      ...base,
      remote: { ...current, behind: 2 },
      pulling: true,
      progress: { branch: "master", line: "Receiving objects:  64% (812/1268)", percent: 64 },
    },
  },
];
