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
import { PlanSettingsFields, PlanSettingsSummary } from "./PlanSettingsFields";
import { savePlanSettings, samePlanSettings, usePlanSettings } from "../lib/tcserver/plans";
import type { PlanSettings } from "@server/shared/plans";
import { ReviewFields, loadReviewScope, reviewSummary, saveReviewSettings, type ReviewScope } from "./ReviewFields";
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from "@server/shared/review";
import { registry } from "../lib/connection";
import { useAccounts } from "../stores/accounts";
import { shortName } from "../lib/accountScope";
import { HARNESS_LABEL } from "../lib/session";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import type { BuildConfig } from "@server/shared/build";
import { TURN_PASS_OFF, passActions, passEnabled, type TurnPass } from "@server/shared/turnpass";
import { prettyCwd } from "../lib/paths";
import {
  createProject,
  createWorkspace,
  listBranches,
  renameProject,
  setProjectAccounts,
  setProjectBranch,
} from "../lib/tcserver/projects";
import { archiveLinked, deleteLinked, liveHostFacts, useProjectHome } from "../lib/projectHome";
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

const samePins = (a: AccountPins, b: AccountPins) =>
  ROUTED_PROVIDERS.every((p) => (a[p] ?? "") === (b[p] ?? ""));

/**
 * One select per gateway provider: the project's own account, or inherit
 * (the workspace's pin when it has one, else auto). Shared by the project
 * dialog and the workspace page, which differ only in what "inherit" means.
 */
export function AccountPinFields({
  environmentId,
  value,
  onChange,
  inheritLabel,
  compact = false,
}: {
  environmentId: string;
  value: AccountPins;
  onChange: (next: AccountPins) => void;
  /** What an unset provider falls back to, e.g. "Inherit (workspace: a@x)". */
  inheritLabel: (provider: (typeof ROUTED_PROVIDERS)[number]) => string;
  compact?: boolean;
}) {
  const { snapshot } = useAccounts(environmentId);
  return (
    <>
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = value[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        return (
          <Field key={provider} label={HARNESS_LABEL[provider]}>
            <select
              value={current}
              disabled={profiles.length === 0 && current === ""}
              onChange={(e) => {
                const next = { ...value };
                if (e.target.value) next[provider] = e.target.value;
                else delete next[provider];
                onChange(next);
              }}
              className={compact ? INPUT : INPUT}
            >
              <option value="">{inheritLabel(provider)}</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {shortName(p)}
                </option>
              ))}
              {known ? null : <option value={current}>{current} (not in Aliax)</option>}
            </select>
          </Field>
        );
      })}
    </>
  );
}

/** "Inherit (workspace: a@x)" / "Inherit (auto)" for a project under `workspace`. */
export function projectInheritLabel(workspace: WorkspaceMeta, profiles: { name: string; email?: string; nickname?: string; createdAt: number; active: boolean }[]) {
  return (provider: (typeof ROUTED_PROVIDERS)[number]): string => {
    const name = workspace.accountPins?.[provider];
    if (!name) return "Inherit (auto)";
    const profile = profiles.find((p) => p.name === name);
    return `Inherit (workspace: ${profile ? shortName(profile) : name})`;
  };
}

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

/** One project's review override, plus the global set it would follow. */
function useReviewScope(environmentId: string, projectId: string) {
  const [scope, setScope] = useState<ReviewScope | null>(null);
  useEffect(() => {
    let live = true;
    loadReviewScope(environmentId, projectId)
      .then((s) => live && setScope(s))
      .catch(() => live && setScope(null));
    return () => {
      live = false;
    };
  }, [environmentId, projectId]);
  return scope;
}

const sameReview = (a: ReviewSettings | null, b: ReviewSettings | null) =>
  a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

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
  environmentId,
  onClose,
  onCreated,
}: {
  path: string;
  /** The machine the folder is on; this one when absent. */
  environmentId?: string | null;
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
      // This machine's folder dialog, or another host's folders over its link.
      const workspace = await createWorkspace(environmentId ?? registry.primary().environmentId, path);
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

/**
 * A project's settings. A linked project's live on its settings home (the
 * box's copy, lib/projectHome.ts): every field but the branch is read from
 * that copy and saved to it over its host's link, the footer says where,
 * and a home out of reach disables Save with the reason. The branch and the
 * folder are this copy's own.
 */
export function ProjectSettingsDialog({
  project,
  workspace,
  onClose,
}: {
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  const at = useProjectHome(project);
  const note = at.blocked ?? (at.linked ? `Saved on ${at.hostName}` : undefined);
  // A new home (a host's hello naming its platform late) starts the drafts over.
  return (
    <ProjectSettingsBody
      key={`${at.home.environmentId}:${at.home.id}`}
      project={project}
      workspace={workspace}
      home={at.home}
      homeWorkspace={at.workspace ?? workspace}
      note={note}
      blocked={at.blocked}
      onClose={onClose}
    />
  );
}

function ProjectSettingsBody({
  project,
  workspace,
  home,
  homeWorkspace,
  note,
  blocked,
  onClose,
}: {
  /** The copy the dialog was opened on: its branch and folder. */
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  /** The copy holding the settings, and its workspace. */
  home: ProjectMeta;
  homeWorkspace: WorkspaceMeta;
  note?: string;
  blocked: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(home.name);
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
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.get", { workspaceId: homeWorkspace.id, projectId: home.id })
      .then((c) => {
        if (!live) return;
        setSavedBuild(c);
        setBuildOverride(c);
      })
      .catch(() => live && setSavedBuild(null));
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.get", { workspaceId: homeWorkspace.id })
      .then((c) => live && setWsBuild(c))
      .catch(() => {});
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.detect", { path: home.cwd })
      .then((d) => live && setDetected(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [homeWorkspace.id, home.id, home.cwd, home.environmentId]);
  const [pins, setPins] = useState<AccountPins>(home.accountPins ?? {});
  const { snapshot } = useAccounts(home.environmentId);
  const { pass, setPass, inherited } = useTurnPass(homeWorkspace.id, home.id);
  const reviewScope = useReviewScope(home.environmentId, home.id);
  // undefined until the scope loads; null = follows the global set.
  const [review, setReview] = useState<ReviewSettings | null | undefined>(undefined);
  useEffect(() => {
    if (reviewScope && review === undefined) setReview(reviewScope.override);
  }, [reviewScope, review]);
  const shownReview = review ?? reviewScope?.global ?? DEFAULT_REVIEW_SETTINGS;
  const reviewDirty = !!reviewScope && review !== undefined && !sameReview(review, reviewScope.override);
  const [savedPass, setSavedPass] = useState<TurnPass | null | undefined>(undefined);
  useEffect(() => {
    if (pass !== undefined && savedPass === undefined) setSavedPass(pass);
  }, [pass, savedPass]);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;
  // Plans: the project's override, else what it inherits from the host's global set.
  const planScope = usePlanSettings(home.environmentId, home.id);
  const globalPlans = usePlanSettings(home.environmentId, null);
  const [plans, setPlans] = useState<PlanSettings | null | undefined>(undefined);
  useEffect(() => {
    if (planScope && plans === undefined) setPlans(planScope.overridden ? planScope.settings : null);
  }, [planScope, plans]);
  const shownPlans = plans ?? globalPlans?.settings ?? planScope?.settings;
  const plansDirty =
    planScope !== undefined &&
    plans !== undefined &&
    (planScope.overridden ? !plans || !samePlanSettings(plans, planScope.settings) : plans !== null);

  const nameDirty = name.trim() !== home.name && !!name.trim();
  const branchDirty =
    worktree && !!branch.trim() && branch.trim() !== (project.branch ?? "");
  const nextBuild = buildOrNull(buildOverride);
  const buildDirty =
    savedBuild !== undefined &&
    ((nextBuild?.command ?? "") !== (savedBuild?.command ?? "") ||
      (nextBuild?.outputs ?? "") !== (savedBuild?.outputs ?? ""));
  const passDirty = savedPass !== undefined && !samePass(pass ?? null, savedPass);
  const pinsDirty = !samePins(pins, home.accountPins ?? {});
  const dirty = nameDirty || branchDirty || buildDirty || passDirty || pinsDirty || plansDirty || reviewDirty;
  const pinsSummary =
    ROUTED_PROVIDERS.map((p) => {
      const name = pins[p];
      if (!name) return null;
      const profile = snapshot.providers[p].profiles.find((x) => x.name === name);
      return `${HARNESS_LABEL[p]} ${profile ? shortName(profile) : name}`;
    })
      .filter(Boolean)
      .join(" · ") || "Inherit";
  const buildSummary = buildOverride
    ? buildOverride.command || "Custom"
    : wsBuild
      ? `${wsBuild.command} · workspace`
      : detected
        ? `${detected.command} · detected`
        : "None";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending || blocked) return;
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
      if (nameDirty) await renameProject(home.id, name.trim());
      if (passDirty) await saveTurnPass(homeWorkspace.id, pass ?? null, home.id);
      if (reviewDirty) await saveReviewSettings(home.environmentId, home.id, review ?? null);
      if (pinsDirty) await setProjectAccounts(home.id, pins);
      if (plansDirty) await savePlanSettings(home.environmentId, home.id, plans ?? null);
      if (buildDirty) {
        await registry.linkOf(home.environmentId).request("build.set", {
          workspaceId: homeWorkspace.id,
          projectId: home.id,
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
          <Disclosure
            label="Reviews"
            summary={`${reviewSummary(shownReview, home.environmentId)}${review ? "" : " · global"}`}
          >
            <ReviewFields value={shownReview} onChange={setReview} environmentId={home.environmentId} compact />
            {review ? (
              <button type="button" onClick={() => setReview(null)} className={`${GHOST} self-start`}>
                Use global setting
              </button>
            ) : null}
          </Disclosure>
          <Disclosure label="Accounts" summary={pinsSummary}>
            <AccountPinFields
              environmentId={home.environmentId}
              value={pins}
              onChange={setPins}
              inheritLabel={projectInheritLabel(homeWorkspace, [...snapshot.providers.claude.profiles, ...snapshot.providers.codex.profiles])}
              compact
            />
          </Disclosure>
          <Disclosure
            label="Plans"
            summary={shownPlans ? <PlanSettingsSummary settings={shownPlans} extra={plans ? undefined : "global"} /> : "…"}
          >
            {shownPlans ? (
              <PlanSettingsFields
                value={shownPlans}
                onChange={setPlans}
                environmentId={home.environmentId}
                compact
              />
            ) : null}
            {plans ? (
              <button type="button" onClick={() => setPlans(null)} className={`${GHOST} self-start`}>
                Use global setting
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
          disabled={!dirty || !!blocked}
          note={note}
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
  // A linked project: archive takes every copy (the home first, so a home out
  // of reach blocks it); delete takes this copy, the others only when asked.
  const at = useProjectHome(project);
  const blocked = deleting ? null : at.blocked;
  const others = deleting ? at.copies.filter((c) => c.environmentId !== project.environmentId) : [];
  const [also, setAlso] = useState<ReadonlySet<string>>(() => new Set());

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const cleanup: ProjectCleanup | undefined = any
      ? { worktree: worktree || localBranch, localBranch, remoteBranch }
      : undefined;
    try {
      if (deleting) await deleteLinked(project, [...also], cleanup);
      else await archiveLinked(project, true, cleanup);
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
  const copyBoxes = others.map((copy) => {
    const text = `Also delete the copy on ${liveHostFacts.nameOf(copy.environmentId)}`;
    const offline = !liveHostFacts.isOpen(copy.environmentId);
    return {
      key: `copy:${copy.environmentId}:${copy.id}`,
      text,
      label: text,
      checked: also.has(copy.id),
      disabled: offline,
      set: (on: boolean) =>
        setAlso((prev) => {
          const next = new Set(prev);
          if (on) next.add(copy.id);
          else next.delete(copy.id);
          return next;
        }),
    };
  });
  const rows = [...boxes, ...copyBoxes];

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
        {rows.length ? (
        <div className="flex flex-col">
          {rows.map((b) => (
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
        disabled={!!blocked}
        note={blocked ?? undefined}
      />
    </Modal>
  );
}

export { ConfirmDialog };
