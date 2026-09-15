import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Modal } from "./Modal";
import { ChevronRight } from "./icons";
import { BUILD_EMPTY, BuildFields, buildOrNull } from "./rail/buildSettings";
import { ConfirmDialog, DialogFooter as Footer, ErrorLine, GHOST, errorText } from "./ConfirmDialog";
import { INPUT_CLASS, Toggle } from "../surfaces/settingsBits";
import { TurnPassFields, loadTurnPass, saveTurnPass } from "./TurnPassFields";
import { client } from "../lib/tcserver/client";
import type { BuildConfig } from "@server/shared/build";
import { TURN_PASS_OFF, passActions, passEnabled, type TurnPass } from "@server/shared/turnpass";
import { prettyCwd } from "../lib/paths";
import {
  archiveProject,
  createProject,
  createWorkspace,
  deleteProject,
  listBranches,
  renameProject,
  setProjectBranch,
} from "../lib/tcserver/projects";
import type {
  BranchList,
  ProjectCleanup,
  ProjectMeta,
  ProjectMode,
  WorkspaceMeta,
} from "../lib/tcserver/types";

const INPUT = `w-full ${INPUT_CLASS}`;
const LABEL = "text-[11px] font-medium text-content/50";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-4 text-content/40">{children}</p>;
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const samePass = (a: TurnPass | null, b: TurnPass | null) =>
  a === b || (!!a && !!b && a.verify === b.verify && a.build === b.build && a.commit === b.commit);

const passSummary = (pass: TurnPass) => passActions(pass).join(", ") || "Off";

/** A collapsed section with a one-line summary; opens in place. */
function Disclosure({
  label,
  summary,
  children,
}: {
  label: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3 border-t border-content/10 pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left"
      >
        <ChevronRight
          className={`size-3 shrink-0 text-content/40 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className={LABEL}>{label}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-content/40">
          {summary}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}

/** One project's pass override, plus the workspace pass it would inherit. */
function useTurnPass(workspaceId: string, projectId?: string) {
  const [pass, setPass] = useState<TurnPass | null | undefined>(undefined);
  const [inherited, setInherited] = useState<TurnPass | null>(null);
  useEffect(() => {
    let live = true;
    loadTurnPass(workspaceId)
      .then((p) => live && setInherited(p))
      .catch(() => {});
    if (projectId) {
      loadTurnPass(workspaceId, projectId)
        .then((p) => live && setPass(p))
        .catch(() => live && setPass(null));
    } else setPass(null);
    return () => {
      live = false;
    };
  }, [workspaceId, projectId]);
  return { pass, setPass, inherited };
}

/** Modal steals focus to its close button on mount; take it back a frame later. */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return ref;
}

function useBranches(workspaceId: string, enabled: boolean): BranchList | null {
  const [list, setList] = useState<BranchList | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listBranches(workspaceId)
      .then((l) => live && setList(l))
      .catch(() => live && setList({ locals: [], remotes: [], current: null }));
    return () => {
      live = false;
    };
  }, [workspaceId, enabled]);
  return list;
}

function branchExists(list: BranchList | null, name: string): boolean {
  if (!list || !name) return false;
  return (
    list.locals.includes(name) ||
    list.remotes.includes(name) ||
    list.remotes.includes(`origin/${name}`)
  );
}

function suggestionsFor(list: BranchList | null, needle: string): string[] {
  if (!list) return [];
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  const all = [...new Set([...list.locals, ...list.remotes])];
  return all
    .filter((b) => b !== needle && b.toLowerCase().includes(q))
    .slice(0, 4);
}

function BranchField({
  value,
  onChange,
  branches,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList | null;
  placeholder?: string;
}) {
  const suggestions = suggestionsFor(branches, value);
  return (
    <Field label="Branch">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        className={`${INPUT} font-mono`}
      />
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {suggestions.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => onChange(b)}
              className="rounded-md bg-content/8 px-1.5 py-0.5 font-mono text-[11px] text-content/70 hover:bg-content/12 hover:text-content"
            >
              {b}
            </button>
          ))}
        </div>
      ) : null}
    </Field>
  );
}

function BaseRefField({
  value,
  onChange,
  branches,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList | null;
}) {
  return (
    <Field label="Start from">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      >
        <option value="@head">
          {branches?.current
            ? `Current HEAD (${branches.current})`
            : "Current HEAD"}
        </option>
        {(
          [
            ["Local", branches?.locals ?? []],
            ["Remote", branches?.remotes ?? []],
          ] as const
        ).map(([group, names]) =>
          names.length ? (
            <optgroup key={group} label={group}>
              {names.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------------

export function NewWorkspaceDialog({
  path,
  onClose,
  onCreated,
}: {
  path: string;
  onClose: () => void;
  onCreated: (workspace: WorkspaceMeta) => void;
}) {
  const [pass, setPass] = useState<TurnPass>(TURN_PASS_OFF);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const workspace = await createWorkspace(path);
      if (passEnabled(pass)) await saveTurnPass(workspace.id, pass);
      onCreated(workspace);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      busy={pending}
      title={`Add ${baseName(path)}`}
      description={prettyCwd(path)}
      size="sm"
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div>
            <span className={LABEL}>Completed turn</span>
            <Hint>What threads here do after each turn settles.</Hint>
          </div>
          <TurnPassFields value={pass} onChange={setPass} compact />
          <ErrorLine error={error} />
        </div>
        <Footer onCancel={onClose} confirmLabel="Add workspace" pending={pending} />
      </form>
    </Modal>
  );
}

export function NewProjectDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: WorkspaceMeta;
  onClose: () => void;
  onCreated: (project: ProjectMeta) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ProjectMode>(
    workspace.git ? "worktree" : "local",
  );
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("@head");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useFocusOnMount<HTMLInputElement>();
  const branches = useBranches(workspace.id, workspace.git);
  const exists = branchExists(branches, branch.trim());
  const { inherited } = useTurnPass(workspace.id);
  const [pass, setPass] = useState<TurnPass | null>(null);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const b = branch.trim();
      const project = await createProject({
        workspaceId: workspace.id,
        name: trimmed,
        mode,
        ...(mode === "worktree" && b ? { branch: b } : {}),
        ...(mode === "worktree" && !exists && baseRef !== "@head"
          ? { baseRef }
          : {}),
      });
      if (pass && !samePass(pass, inherited)) {
        await saveTurnPass(workspace.id, pass, project.id);
      }
      onCreated(project);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      busy={pending}
      title="New project"
      description={workspace.name}
      size="sm"
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-4 py-3">
          <Field label="Name">
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What are you working on?"
              className={INPUT}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Mode</span>
            <div
              role="radiogroup"
              aria-label="Mode"
              className="grid grid-cols-2 gap-0.5 rounded-md border border-content/10 p-0.5"
            >
              {(["worktree", "local"] as const).map((m) => {
                const disabled = m === "worktree" && !workspace.git;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    disabled={disabled}
                    onClick={() => setMode(m)}
                    className={`pressable h-7 rounded-[4px] text-[12px] font-medium capitalize ${
                      mode === m
                        ? "bg-content/10 text-content"
                        : "text-content/50 hover:text-content"
                    } ${disabled ? "cursor-default opacity-40" : ""}`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
            <Hint>
              {mode === "worktree"
                ? "Own branch and folder, isolated from your checkout."
                : `Works directly in ${workspace.name}.`}
            </Hint>
          </div>
          {mode === "worktree" ? (
            <>
              <BranchField
                value={branch}
                onChange={setBranch}
                branches={branches}
                placeholder="Branch (automatic)"
              />
              {exists ? (
                <Hint>Opens the existing branch.</Hint>
              ) : (
                <BaseRefField
                  value={baseRef}
                  onChange={setBaseRef}
                  branches={branches}
                />
              )}
            </>
          ) : null}
          <Disclosure label="Completed turn" summary={passSummary(shownPass)}>
            <TurnPassFields value={shownPass} onChange={setPass} compact />
          </Disclosure>
          <ErrorLine error={error} />
        </div>
        <Footer
          onCancel={onClose}
          confirmLabel="Create"
          pending={pending}
          disabled={!name.trim()}
        />
      </form>
    </Modal>
  );
}

export function ProjectSettingsDialog({
  project,
  workspace,
  onClose,
}: {
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.branch ?? "");
  const [baseRef, setBaseRef] = useState("@head");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useFocusOnMount<HTMLInputElement>();
  const worktree = project.mode === "worktree";
  const branches = useBranches(workspace.id, worktree);
  const exists = branchExists(branches, branch.trim());
  const [savedBuild, setSavedBuild] = useState<BuildConfig | null | undefined>(undefined);
  const [buildOverride, setBuildOverride] = useState<BuildConfig | null>(null);
  const [wsBuild, setWsBuild] = useState<BuildConfig | null>(null);
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  useEffect(() => {
    let live = true;
    void client
      .request<BuildConfig | null>("build.get", { workspaceId: workspace.id, projectId: project.id })
      .then((c) => {
        if (!live) return;
        setSavedBuild(c);
        setBuildOverride(c);
      })
      .catch(() => live && setSavedBuild(null));
    void client
      .request<BuildConfig | null>("build.get", { workspaceId: workspace.id })
      .then((c) => live && setWsBuild(c))
      .catch(() => {});
    void client
      .request<BuildConfig | null>("build.detect", { path: project.cwd })
      .then((d) => live && setDetected(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspace.id, project.id, project.cwd]);
  const { pass, setPass, inherited } = useTurnPass(workspace.id, project.id);
  const [savedPass, setSavedPass] = useState<TurnPass | null | undefined>(undefined);
  useEffect(() => {
    if (pass !== undefined && savedPass === undefined) setSavedPass(pass);
  }, [pass, savedPass]);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;

  const nameDirty = name.trim() !== project.name && !!name.trim();
  const branchDirty =
    worktree && !!branch.trim() && branch.trim() !== (project.branch ?? "");
  const nextBuild = buildOrNull(buildOverride);
  const buildDirty =
    savedBuild !== undefined &&
    ((nextBuild?.command ?? "") !== (savedBuild?.command ?? "") ||
      (nextBuild?.outputs ?? "") !== (savedBuild?.outputs ?? ""));
  const passDirty = savedPass !== undefined && !samePass(pass ?? null, savedPass);
  const dirty = nameDirty || branchDirty || buildDirty || passDirty;
  const buildSummary = buildOverride
    ? buildOverride.command || "Custom"
    : wsBuild
      ? `${wsBuild.command} · workspace`
      : detected
        ? `${detected.command} · detected`
        : "None";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    try {
      if (branchDirty) {
        await setProjectBranch(
          project.id,
          branch.trim(),
          !exists && baseRef !== "@head" ? baseRef : undefined,
        );
      }
      if (nameDirty) await renameProject(project.id, name.trim());
      if (passDirty) await saveTurnPass(workspace.id, pass ?? null, project.id);
      if (buildDirty) {
        await client.request("build.set", {
          workspaceId: workspace.id,
          projectId: project.id,
          config: nextBuild,
        });
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      busy={pending}
      title="Project settings"
      description={`${worktree ? "Worktree" : "Local"} · ${prettyCwd(project.cwd)}`}
      size="sm"
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-3 px-4 py-3">
          <Field label="Name">
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT}
            />
          </Field>
          {worktree ? (
            <>
              <BranchField
                value={branch}
                onChange={setBranch}
                branches={branches}
              />
              {branchDirty ? (
                exists ? (
                  <Hint>Switches to the existing branch.</Hint>
                ) : (
                  <BaseRefField
                    value={baseRef}
                    onChange={setBaseRef}
                    branches={branches}
                  />
                )
              ) : null}
            </>
          ) : null}
          <Disclosure
            label="Completed turn"
            summary={`${passSummary(shownPass)}${pass ? "" : " · workspace"}`}
          >
            <TurnPassFields value={shownPass} onChange={setPass} compact />
            {pass ? (
              <button type="button" onClick={() => setPass(null)} className={`${GHOST} self-start`}>
                Use workspace setting
              </button>
            ) : null}
          </Disclosure>
          <Disclosure label="Build" summary={buildSummary}>
            <BuildFields
              value={buildOverride ?? wsBuild ?? BUILD_EMPTY}
              onChange={setBuildOverride}
              detected={detected}
              compact
            />
            {buildOverride ? (
              <button
                type="button"
                onClick={() => setBuildOverride(null)}
                className={`${GHOST} self-start`}
              >
                Use workspace setting
              </button>
            ) : null}
          </Disclosure>
          <ErrorLine error={error} />
        </div>
        <Footer
          onCancel={onClose}
          confirmLabel="Save"
          pending={pending}
          disabled={!dirty}
        />
      </form>
    </Modal>
  );
}

export function ProjectTeardownDialog({
  project,
  action,
  onClose,
  onDone,
}: {
  project: ProjectMeta;
  action: "archive" | "delete";
  onClose: () => void;
  onDone: () => void;
}) {
  const [worktree, setWorktree] = useState(false);
  const [localBranch, setLocalBranch] = useState(false);
  const [remoteBranch, setRemoteBranch] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = action === "delete";
  const any = worktree || localBranch || remoteBranch;
  const cleanable = project.mode === "worktree" && !!project.branch;

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const cleanup: ProjectCleanup | undefined = any
      ? { worktree: worktree || localBranch, localBranch, remoteBranch }
      : undefined;
    try {
      if (deleting) await deleteProject(project.id, cleanup);
      else await archiveProject(project.id, true, cleanup);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const mono = (text: string) => <code className="font-mono text-[11px]">{text}</code>;
  const boxes = cleanable
    ? [
        {
          key: "worktree",
          text: "Remove the worktree folder",
          label: "Remove the worktree folder",
          checked: worktree || localBranch,
          disabled: localBranch,
          set: setWorktree,
        },
        {
          key: "local",
          text: `Delete branch ${project.branch ?? ""}`,
          label: <>Delete branch {mono(project.branch ?? "")}</>,
          checked: localBranch,
          set: setLocalBranch,
        },
        {
          key: "remote",
          text: `Delete origin/${project.branch ?? ""}`,
          label: <>Delete {mono(`origin/${project.branch ?? ""}`)}</>,
          checked: remoteBranch,
          set: setRemoteBranch,
        },
      ]
    : [];

  return (
    <Modal
      onClose={onClose}
      busy={pending}
      title={`${deleting ? "Delete" : "Archive"} ${project.name}?`}
      size="sm"
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[12px] leading-snug text-content/50">
          {deleting
            ? "Its threads are deleted for good."
            : "The project leaves the sidebar. Its threads stay; restore it anytime."}
        </p>
        {boxes.length ? (
        <div className="flex flex-col">
          {boxes.map((b) => (
            <div
              key={b.key}
              className={`flex h-7 items-center justify-between gap-3 text-[12px] text-content/70 ${
                b.disabled ? "pointer-events-none opacity-40" : ""
              }`}
            >
              <span className="min-w-0 truncate">{b.label}</span>
              <Toggle label={b.text} on={b.checked} onChange={b.set} />
            </div>
          ))}
        </div>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <Footer
        onCancel={onClose}
        onConfirm={confirm}
        confirmLabel={deleting ? "Delete project" : "Archive"}
        danger={deleting || any}
        pending={pending}
      />
    </Modal>
  );
}

export { ConfirmDialog };
