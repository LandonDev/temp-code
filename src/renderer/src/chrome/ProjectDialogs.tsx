import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ModalPanel, useClosingDialog } from "./Modal";
import { CheckRow, Field, FieldRow } from "./DialogField";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Dialog,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@renderer/components/ui/sheet";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { ChoiceSelect } from "../components/choice-select";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { ChoiceToggle } from "../components/choice-toggle";
import { BUILD_EMPTY, BuildFields, buildOrNull } from "./rail/buildSettings";
import { ConfirmDialog, DialogFooter as Footer, ErrorLine, errorText } from "./ConfirmDialog";
import { TurnPassFields, loadTurnPass, saveTurnPass } from "./TurnPassFields";
import { PlanSettingsFields } from "./PlanSettingsFields";
import { savePlanSettings, samePlanSettings, usePlanSettings } from "../lib/tcserver/plans";
import type { PlanSettings } from "@server/shared/plans";
import { ReviewFields, loadReviewScope, saveReviewSettings, type ReviewScope } from "./ReviewFields";
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from "@server/shared/review";
import { registry } from "../lib/connection";
import { useAccounts } from "../stores/accounts";
import { shortName } from "../lib/accountScope";
import { HARNESS_LABEL } from "../lib/session";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import type { BuildConfig } from "@server/shared/build";
import { TURN_PASS_OFF, passEnabled, type TurnPass } from "@server/shared/turnpass";
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

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const samePass = (a: TurnPass | null, b: TurnPass | null) =>
  a === b || (!!a && !!b && a.verify === b.verify && a.build === b.build && a.commit === b.commit);

const samePins = (a: AccountPins, b: AccountPins) =>
  ROUTED_PROVIDERS.every((p) => (a[p] ?? "") === (b[p] ?? ""));

/**
 * One select per gateway provider: the project's own account, or inherit
 * (the workspace's pin when it has one, else auto).
 */
export function AccountPinFields({
  environmentId,
  value,
  onChange,
  inheritLabel,
}: {
  environmentId: string;
  value: AccountPins;
  onChange: (next: AccountPins) => void;
  /** What an unset provider falls back to, e.g. "Inherit (workspace: a@x)". */
  inheritLabel: (provider: (typeof ROUTED_PROVIDERS)[number]) => string;
}) {
  const { snapshot } = useAccounts(environmentId);
  return (
    <div className="flex flex-col">
      {ROUTED_PROVIDERS.map((provider) => {
        const profiles = snapshot.providers[provider].profiles;
        const current = value[provider] ?? "";
        const known = current === "" || profiles.some((p) => p.name === current);
        return (
          <FieldRow key={provider} label={providerName(provider)}>
            <ChoiceSelect
              label={providerName(provider)}
              size="sm"
              value={current}
              disabled={profiles.length === 0 && current === ""}
              options={[
                { value: "", label: inheritLabel(provider) },
                ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
                ...(known ? [] : [{ value: current, label: `${current} (not in Aliax)` }]),
              ]}
              onChange={(name) => {
                const next = { ...value };
                if (name) next[provider] = name;
                else delete next[provider];
                onChange(next);
              }}
            />
          </FieldRow>
        );
      })}
    </div>
  );
}

const providerName = (provider: (typeof ROUTED_PROVIDERS)[number]) => {
  const label = HARNESS_LABEL[provider];
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** "Inherit (workspace: a@x)" / "Inherit (auto)" for a project under `workspace`. */
export function projectInheritLabel(workspace: WorkspaceMeta, profiles: { name: string; email?: string; nickname?: string; createdAt: number; active: boolean }[]) {
  return (provider: (typeof ROUTED_PROVIDERS)[number]): string => {
    const name = workspace.accountPins?.[provider];
    if (!name) return "Inherit (auto)";
    const profile = profiles.find((p) => p.name === name);
    return `Inherit (workspace: ${profile ? shortName(profile) : name})`;
  };
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
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList | null;
  placeholder?: string;
  hint?: string;
}) {
  const suggestions = suggestionsFor(branches, value);
  return (
    <div className="flex flex-col gap-1.5">
      <Field label="Branch" hint={hint}>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono"
        />
      </Field>
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((b) => (
            <Button key={b} type="button" variant="ghost" size="xs" className="font-mono text-muted-foreground" onClick={() => onChange(b)}>
              {b}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
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
  const head = branches?.current ? `Current HEAD (${branches.current})` : "Current HEAD";
  const groups = (
    [
      ["Local", branches?.locals ?? []],
      ["Remote", branches?.remotes ?? []],
    ] as const
  ).filter(([, names]) => names.length);
  const items = [{ value: "@head", label: head }, ...groups.flatMap(([, names]) => names.map((b) => ({ value: b, label: b })))];
  return (
    <Field label="Start from">
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="@head">{head}</SelectItem>
          </SelectGroup>
          {groups.map(([group, names]) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {names.map((b) => (
                <SelectItem key={`${group}:${b}`} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A section of a form without a fold: the 12px muted heading over its fields. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
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
  const { root, closeThen } = useClosingDialog(onClose, pending);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // This machine's folder dialog, or another host's folders over its link.
      const workspace = await createWorkspace(environmentId ?? registry.primary().environmentId, path);
      if (passEnabled(pass)) await saveTurnPass(workspace.id, pass);
      setPending(false);
      closeThen(() => onCreated(workspace));
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} busy={pending} title={`Add ${baseName(path)}`} description={prettyCwd(path)} size="sm">
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-4 py-4">
            <Section label="Completed turn">
              <TurnPassFields value={pass} onChange={setPass} compact />
            </Section>
            <ErrorLine error={error} />
          </div>
          <Footer onCancel={() => closeThen(onClose)} confirmLabel="Add workspace" pending={pending} />
        </form>
      </ModalPanel>
    </Dialog>
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
  const branches = useBranches(workspace.id, workspace.git);
  const exists = branchExists(branches, branch.trim());
  const { inherited } = useTurnPass(workspace.id);
  const [pass, setPass] = useState<TurnPass | null>(null);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;
  const { root, closeThen } = useClosingDialog(onClose, pending);

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
      setPending(false);
      closeThen(() => onCreated(project));
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} busy={pending} title="New project" description={workspace.name} size="sm">
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-4 py-4">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What are you working on?" />
            </Field>
            <FieldRow
              label="Mode"
              description={mode === "worktree" ? "Own branch and folder, isolated from your checkout." : `Works directly in ${workspace.name}.`}
            >
              <ChoiceToggle
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "worktree", label: "Worktree", disabled: !workspace.git, note: workspace.git ? undefined : "Needs a git repository" },
                  { value: "local", label: "Local" },
                ]}
              />
            </FieldRow>
            {mode === "worktree" ? (
              <>
                <BranchField
                  value={branch}
                  onChange={setBranch}
                  branches={branches}
                  placeholder="Branch (automatic)"
                  hint={exists ? "Opens the existing branch." : undefined}
                />
                {exists ? null : <BaseRefField value={baseRef} onChange={setBaseRef} branches={branches} />}
              </>
            ) : null}
            <Section label="Completed turn">
              <TurnPassFields value={shownPass} onChange={setPass} compact />
            </Section>
            <ErrorLine error={error} />
          </div>
          <Footer onCancel={() => closeThen(onClose)} confirmLabel="Create" pending={pending} disabled={!name.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
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
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const dirty = nameDirty || branchDirty || buildDirty || passDirty || pinsDirty || plansDirty || reviewDirty;
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
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const linkButton = (label: string, onClick: () => void) => (
    <Button type="button" variant="link" size="xs" className="h-auto self-start px-0 text-xs text-muted-foreground" onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <Sheet {...root}>
      <SheetContent side="right" showCloseButton={!pending} aria-busy={pending || undefined}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle>Project settings</SheetTitle>
            <SheetDescription className="flex min-w-0 gap-2 text-xs">
              <span className="shrink-0">{worktree ? "Worktree" : "Local"}</span>
              <span className="min-w-0 truncate">{prettyCwd(project.cwd)}</span>
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 px-4 pb-6">
              <div className="flex flex-col gap-4">
                <Field label="Name">
                  <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                {worktree ? (
                  <>
                    <BranchField
                      value={branch}
                      onChange={setBranch}
                      branches={branches}
                      hint={branchDirty && exists ? "Switches to the existing branch." : undefined}
                    />
                    {branchDirty && !exists ? <BaseRefField value={baseRef} onChange={setBaseRef} branches={branches} /> : null}
                  </>
                ) : null}
              </div>
              <Section label="Completed turn">
                <TurnPassFields value={shownPass} onChange={setPass} compact />
                {pass ? linkButton("Use workspace setting", () => setPass(null)) : null}
              </Section>
              <Section label="Reviews">
                <ReviewFields value={shownReview} onChange={setReview} environmentId={home.environmentId} compact />
                {review ? linkButton("Use global setting", () => setReview(null)) : null}
              </Section>
              <Section label="Accounts">
                <AccountPinFields
                  environmentId={home.environmentId}
                  value={pins}
                  onChange={setPins}
                  inheritLabel={projectInheritLabel(homeWorkspace, [...snapshot.providers.claude.profiles, ...snapshot.providers.codex.profiles])}
                />
              </Section>
              <Section label="Plans">
                {shownPlans ? (
                  <PlanSettingsFields value={shownPlans} onChange={setPlans} environmentId={home.environmentId} compact />
                ) : (
                  <Skeleton className="h-16 w-full rounded-lg" />
                )}
                {plans ? linkButton("Use global setting", () => setPlans(null)) : null}
              </Section>
              <Section label="Build">
                <BuildFields value={buildOverride ?? wsBuild ?? BUILD_EMPTY} onChange={setBuildOverride} detected={detected} compact />
                {buildOverride ? linkButton("Use workspace setting", () => setBuildOverride(null)) : null}
              </Section>
              <ErrorLine error={error} />
            </div>
          </ScrollArea>
          <Footer onCancel={() => closeThen(onClose)} confirmLabel="Save" pending={pending} disabled={!dirty || !!blocked} note={note} />
        </form>
      </SheetContent>
    </Sheet>
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
  const { root, closeThen } = useClosingDialog(onClose, pending);

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
      setPending(false);
      closeThen(onDone);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  const mono = (text: string) => <code className="font-mono text-xs">{text}</code>;
  const boxes = cleanable
    ? [
        {
          key: "worktree",
          label: "Remove the worktree folder",
          checked: worktree || localBranch,
          disabled: localBranch,
          set: setWorktree,
        },
        {
          key: "local",
          label: <>Delete branch {mono(project.branch ?? "")}</>,
          checked: localBranch,
          set: setLocalBranch,
        },
        {
          key: "remote",
          label: <>Delete {mono(`origin/${project.branch ?? ""}`)}</>,
          checked: remoteBranch,
          set: setRemoteBranch,
        },
      ]
    : [];
  const copyBoxes = others.map((copy) => ({
    key: `copy:${copy.environmentId}:${copy.id}`,
    label: `Also delete the copy on ${liveHostFacts.nameOf(copy.environmentId)}`,
    checked: also.has(copy.id),
    disabled: !liveHostFacts.isOpen(copy.environmentId),
    set: (on: boolean) =>
      setAlso((prev) => {
        const next = new Set(prev);
        if (on) next.add(copy.id);
        else next.delete(copy.id);
        return next;
      }),
  }));
  const rows = [...boxes, ...copyBoxes];
  const checks = rows.length ? (
    <div className="flex flex-col">
      {rows.map((b) => (
        <CheckRow key={b.key} label={b.label} checked={b.checked} disabled={b.disabled} onCheckedChange={b.set} />
      ))}
    </div>
  ) : null;

  // Deleting is irreversible: an alert, Cancel and the red verb. Archiving
  // is undone from the archive list, so it stays an ordinary dialog.
  if (deleting) {
    return (
      <AlertDialog {...root}>
        <AlertDialogContent aria-busy={pending || undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its threads are deleted for good.</AlertDialogDescription>
          </AlertDialogHeader>
          {checks}
          <ErrorLine error={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={() => void confirm()}>
              {pending ? <Spinner /> : null}
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog {...root}>
      <ModalPanel
        onClose={onClose}
        busy={pending}
        title={`Archive ${project.name}?`}
        description="Its threads stay; restore it anytime."
        size="sm"
      >
        {checks || error ? (
          <div className="flex flex-col gap-4 px-4 py-4">
            {checks}
            <ErrorLine error={error} />
          </div>
        ) : null}
        <Footer
          onCancel={() => closeThen(onClose)}
          onConfirm={() => void confirm()}
          confirmLabel="Archive"
          danger={any}
          pending={pending}
          disabled={!!blocked}
          note={blocked ?? undefined}
        />
      </ModalPanel>
    </Dialog>
  );
}

export { ConfirmDialog };
