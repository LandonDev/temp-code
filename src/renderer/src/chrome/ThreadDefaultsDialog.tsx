import { registry } from "../lib/connection";
import { useEffect, useState } from "react";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  BUILT_IN_SCOPE,
  EFFORT_LABELS,
  PERMISSION_HINTS,
  PERMISSION_LABELS,
  effortLadder,
  modelForDefaults,
  modelOptions,
  normalizeDefaults,
  providerOptions,
  storedModelId,
  type DefaultsScope,
} from "../lib/tcserver/defaults";
import { scopeKey, useThreadDefaults, useWorkspaceCatalog, workspaceStore } from "../lib/tcserver/workspaces";
import { openWorkspaceSettings } from "../lib/settings";
import type { ThreadDefaults, WorkspaceMeta } from "../lib/tcserver/types";

/**
 * What a NEW thread starts with: provider, model, reasoning effort and access
 * policy. Stored server-side globally and per workspace (`defaults.set`), so
 * every entry point — the empty composer, a plan handoff, a model's
 * app_start_thread — resolves the same answer. A workspace without an
 * override of its own follows the global set.
 */

const PERMISSIONS: ThreadDefaults["permission"][] = ["safe", "edits", "auto"];

type Change = (next: ThreadDefaults) => void;

function useDefaultsRows(value: ThreadDefaults, onChange: Change, environmentId?: string) {
  const model = modelForDefaults(value, environmentId);
  const ladder = effortLadder(model);
  const set = (patch: Partial<ThreadDefaults>) => onChange(normalizeDefaults({ ...value, ...patch }, environmentId));
  return {
    ladder,
    provider: {
      value: value.provider,
      options: providerOptions(),
      onChange: (provider: string) => set({ provider: provider as ThreadDefaults["provider"], model: "" }),
    },
    model: {
      value: storedModelId(value),
      options: [{ value: "", label: "Provider default" }, ...modelOptions(value.provider, environmentId)],
      onChange: (model: string) => set({ model }),
    },
    reasoning: {
      value: value.reasoning,
      options: ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] })),
      onChange: (reasoning: string) => set({ reasoning: reasoning as ThreadDefaults["reasoning"] }),
    },
    permission: {
      value: value.permission,
      options: PERMISSIONS.map((p) => ({ value: p, label: PERMISSION_LABELS[p] })),
      onChange: (permission: string) => set({ permission: permission as ThreadDefaults["permission"] }),
    },
  };
}

/** Settings-page rows; the Reasoning row only when the model has a ladder. */
export function ThreadDefaultsFields({ value, onChange, environmentId }: { value: ThreadDefaults; onChange: Change; environmentId?: string }) {
  const rows = useDefaultsRows(value, onChange, environmentId);
  return (
    <>
      <PageRow title="Provider">
        <ChoiceSelect label="Provider" {...rows.provider} />
      </PageRow>
      <PageRow title="Model">
        <ChoiceSelect label="Model" {...rows.model} />
      </PageRow>
      {rows.ladder.length > 1 ? (
        <PageRow title="Reasoning">
          <ChoiceSelect label="Reasoning" {...rows.reasoning} />
        </PageRow>
      ) : null}
      <PageRow title="Security" description={PERMISSION_HINTS[value.permission]}>
        <ChoiceSelect label="Security" {...rows.permission} />
      </PageRow>
    </>
  );
}

/** A workspace's page says whose set it shows; the global page's description already does. */
function scopeHint(workspaceId: string | null, scope: DefaultsScope): string | undefined {
  if (workspaceId === null) return undefined;
  return scope.overridden
    ? "This workspace overrides the global defaults."
    : "Using the global defaults; any change creates a workspace override.";
}

/** Self-loading group for one scope; every change saves at once. */
export function ThreadDefaultsEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaceCatalog().workspaces.find((w) => w.id === workspaceId);
  // Global app settings belong to this machine.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <PageRowsSkeleton rows={4} />;
  return <DefaultsEditor key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

function DefaultsEditor({ environmentId, workspaceId }: { environmentId: string; workspaceId: string | null }) {
  const scope = useThreadDefaults(environmentId, workspaceId);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ThreadDefaults | null) => {
    setError(null);
    workspaceStore
      .saveDefaults(environmentId, workspaceId, next)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  // Reset and Remove override show only when something differs from what
  // this scope would otherwise use.
  const resettable = scope?.overridden === true;
  return (
    <PageSection
      // The global page's own title says what this is; a workspace page names it.
      title={workspaceId === null ? undefined : "New threads"}
      description={scopeHint(workspaceId, scope ?? BUILT_IN_SCOPE)}
      action={
        resettable ? (
          <Button variant="ghost" size="sm" onClick={() => save(null)}>
            {workspaceId === null ? "Reset" : "Remove override"}
          </Button>
        ) : null
      }
    >
      {scope ? <ThreadDefaultsFields value={scope.defaults} onChange={save} environmentId={environmentId} /> : <PageRowsSkeleton rows={4} />}
      {workspaceId === null ? <OverridingWorkspaces environmentId={environmentId} /> : null}
      {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
    </PageSection>
  );
}

/** Under the global editor: which workspaces keep their own set. Each name
 *  opens that workspace's page, where the override lives. */
function OverridingWorkspaces({ environmentId }: { environmentId: string }) {
  const { workspaces, defaults } = useWorkspaceCatalog();
  const overriding = workspaces.filter((w) => w.environmentId === environmentId && defaults.get(scopeKey(w.environmentId, w.id))?.overridden);
  if (overriding.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 pt-3 text-xs text-muted-foreground" data-testid="defaults-overrides">
      Overridden in
      {overriding.map((w) => (
        <Button key={w.id} variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => openWorkspaceSettings(w.id)}>
          {w.name}
        </Button>
      ))}
    </p>
  );
}

/** A labelled picker in the dialog: the label 12px medium muted above it. */
function Field({
  label,
  ...picker
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <ChoiceSelect label={label} className="w-full" {...picker} />
    </div>
  );
}

/** The sidebar's quick editor for one workspace: edits stay local until Save. */
export function ThreadDefaultsDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  const scope = useThreadDefaults(workspace.environmentId, workspace.id);
  const [value, setValue] = useState<ThreadDefaults | null>(scope?.defaults ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (scope) setValue((current) => current ?? scope.defaults);
  }, [scope]);

  const save = async (next: ThreadDefaults | null) => {
    setPending(true);
    setError(null);
    try {
      await workspaceStore.saveDefaults(workspace.environmentId, workspace.id, next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? null : onClose())}>
      <DialogContent size="sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (value) void save(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>Thread defaults</DialogTitle>
            <DialogDescription>{workspace.name}</DialogDescription>
          </DialogHeader>
          {value ? <DialogFields value={value} onChange={setValue} environmentId={workspace.environmentId} /> : <PageRowsSkeleton rows={3} />}
          <p className="text-xs text-muted-foreground">{scopeHint(workspace.id, scope ?? BUILT_IN_SCOPE)}</p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            {scope?.overridden ? (
              <Button type="button" variant="ghost" disabled={pending} onClick={() => void save(null)} className="me-auto">
                Remove override
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !value}>
              {pending ? <Spinner className="size-3.5" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DialogFields({ value, onChange, environmentId }: { value: ThreadDefaults; onChange: Change; environmentId?: string }) {
  const rows = useDefaultsRows(value, onChange, environmentId);
  return (
    <>
      <Field label="Provider" {...rows.provider} />
      <Field label="Model" {...rows.model} />
      {rows.ladder.length > 1 ? <Field label="Reasoning" {...rows.reasoning} /> : null}
      <Field label="Security" {...rows.permission} />
    </>
  );
}
