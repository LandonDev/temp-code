import type { FsPathInfo } from "@shared/contract-fsgit";
import type { HarnessSyncStatus } from "@shared/contract-harness";
import { chooseEditor, EDITOR_LABELS, type EditorConfig, type EditorTarget } from "@shared/editor";
import { decideOpen, decisionNote, localPathOf, type PathMap } from "@shared/openOnMac";
import { registry } from "./connection";
import { digestFiles, gitBranches } from "./fs";
import type { FileNote } from "./layout";
import { invokeOn, openWithEditor } from "./native";
import type { OpenFileFn } from "./search";
import { hostOfCwd, projectForCwd } from "./tcserver/projects";

/**
 * "Open in <editor>" / "Open on the Mac": one file, from the diff panel, a
 * transcript path or the file tree, into the editor on this machine. A
 * file on this host opens straight away. A file in a thread on another
 * host names a path there; its Mac path comes from the harness sync's map
 * (`harness.status` → pathMap, inverted in shared/openOnMac.ts), and the
 * editor opens it only when the Mac's copy
 * is the same bytes as the host's. Otherwise the host's version opens in
 * the app's own editor, read-only, with a line saying why ("Mac copy
 * differs: on branch X here") and the Mac copy one click away.
 */

export type OpenInEditorTarget = {
  path: string;
  /** The project the path belongs to, when the catalog cannot say. */
  cwd?: string;
  line?: number;
  column?: number;
};

/** True when the path lives on a host other than this one. */
export function isRemotePath(path: string): boolean {
  return hostOfCwd(path) !== registry.primaryEnvironmentId;
}

/**
 * The menu item's label, or null when there is nothing to show: no editor
 * can run here (web mode, a headless host) or, for a local file, none is
 * installed. A remote file is always "Open on the Mac": this app is the Mac.
 */
export function editorActionLabel(args: { remote: boolean; config: EditorConfig | null; path: string }): string | null {
  const { remote, config, path } = args;
  if (!config) return null;
  if (remote) return "Open on the Mac";
  const editor = chooseEditor(config.editor, config.installed, path);
  return editor ? `Open in ${EDITOR_LABELS[editor]}` : null;
}

/** The label for a path as things stand now. */
export function editorLabelFor(path: string | null, config: EditorConfig | null): string | null {
  if (!path) return null;
  return editorActionLabel({ remote: isRemotePath(path), config, path });
}

const navigationOf = (target: OpenInEditorTarget) =>
  target.line ? { line: target.line, column: target.column } : undefined;

/**
 * Open the file. A launch that fails (no editor, the launcher refused)
 * falls back to the app's own editor with the reason on its note line, so
 * the click always lands somewhere.
 */
export async function openInEditor(target: OpenInEditorTarget, openHere: OpenFileFn): Promise<void> {
  const host = hostOfCwd(target.path);
  const primary = registry.primaryEnvironmentId;
  const launch = async (editorTarget: EditorTarget) => {
    try {
      await openWithEditor(editorTarget);
    } catch (err) {
      openHere(target.path, navigationOf(target), { note: { text: err instanceof Error ? err.message : String(err) } });
    }
  };
  if (host === primary) {
    await launch({ path: target.path, line: target.line, column: target.column });
    return;
  }
  const plan = await planRemoteOpen(target, host, primary);
  if (plan.kind === "launch") {
    await launch(plan.target);
    return;
  }
  openHere(target.path, navigationOf(target), { readOnly: true, note: plan.note });
}

export type RemoteOpenPlan = { kind: "launch"; target: EditorTarget } | { kind: "preview"; note: FileNote };

/** What a remote path leads to; separate from the opening so a test can read it. */
export async function planRemoteOpen(
  target: OpenInEditorTarget,
  host: string,
  primary: string,
  deps: RemoteOpenDeps = defaultDeps,
): Promise<RemoteOpenPlan> {
  const map = await deps.pathMap();
  const localPath = localPathOf(map, target.path);
  const projectRoot = deps.projectRoot(target.path) ?? target.cwd ?? null;
  const localProject = projectRoot ? localPathOf(map, projectRoot) : null;
  const [remote, local, projectInfo] = await Promise.all([
    deps.digest(host, target.path),
    localPath ? deps.digest(primary, localPath) : Promise.resolve(null),
    localProject ? deps.isDir(primary, localProject) : Promise.resolve(false),
  ]);
  const decision = decideOpen({
    localPath,
    localProject,
    localProjectExists: projectInfo,
    remoteDigest: remote,
    localDigest: local,
  });
  if (decision.kind === "local") {
    return { kind: "launch", target: { path: decision.localPath, line: target.line, column: target.column } };
  }
  const branch = localProject && projectInfo ? await deps.branch(primary, localProject) : null;
  const text = decisionNote(decision, branch, deps.hostName(host)) ?? "Shown as the host holds it";
  const action =
    decision.kind === "differs"
      ? { label: "Open the Mac copy anyway", editor: { path: decision.localPath, line: target.line, column: target.column } }
      : decision.kind === "missing"
        ? { label: "Open the project anyway", editor: { path: decision.localProject } }
        : undefined;
  return { kind: "preview", note: action ? { text, action } : { text } };
}

export interface RemoteOpenDeps {
  pathMap(): Promise<PathMap>;
  projectRoot(path: string): string | null;
  digest(environmentId: string, path: string): Promise<string | null>;
  isDir(environmentId: string, path: string): Promise<boolean>;
  branch(environmentId: string, cwd: string): Promise<string | null>;
  hostName(environmentId: string): string;
}

const defaultDeps: RemoteOpenDeps = {
  pathMap: async () => {
    const status = await registry.primary().request<HarnessSyncStatus>("harness.status", {});
    return status.pathMap;
  },
  projectRoot: (path) => projectForCwd(path)?.cwd ?? null,
  digest: (environmentId, path) =>
    digestFiles(environmentId, [path])
      .then((rows) => rows[0]?.sha256 ?? null)
      .catch(() => null),
  isDir: (environmentId, path) =>
    invokeOn<FsPathInfo[]>(environmentId, "inspect_paths", { paths: [path] })
      .then((rows) => rows.some((row) => row.isDir))
      .catch(() => false),
  branch: (environmentId, cwd) =>
    gitBranches(environmentId, cwd)
      .then((list) => list.current)
      .catch(() => null),
  hostName: (environmentId) => registry.environment(environmentId)?.name ?? "the host",
};
