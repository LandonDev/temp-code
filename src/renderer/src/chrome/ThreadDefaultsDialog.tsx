import { registry } from "../lib/connection";
import { useEffect, useState } from "react";
import { GHOST, PRIMARY } from "./ConfirmDialog";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Modal } from "./Modal";
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
  if (!environmentId) return <DefaultsSkeleton />;
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
  const resettable = scope ? (workspaceId === null ? true : scope.overridden) : false;
  return (
    <PageSection
      title="New threads"
      description={scopeHint(workspaceId, scope ?? BUILT_IN_SCOPE)}
      action={
        resettable ? (
          <Button variant="ghost" size="sm" onClick={() => save(null)}>
            {workspaceId === null ? "Reset" : "Remove override"}
          </Button>
        ) : null
      }
    >
      {scope ? <ThreadDefaultsFields value={scope.defaults} onChange={save} environmentId={environmentId} /> : <DefaultsSkeleton rows />}
      {workspaceId === null ? <OverridingWorkspaces environmentId={environmentId} /> : null}
      {error ? <p className="pt-2 text-xs text-destructive">{error}</p> : null}
    </PageSection>
  );
}

/** The rows' shape while the scope loads. */
function DefaultsSkeleton({ rows = false }: { rows?: boolean }) {
  const body = (
    <div aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <Skeleton className="h-3.5 w-24" />
          <span className="flex-1" />
          <Skeleton className="h-8 w-40 rounded-lg" />
        </div>
      ))}
    </div>
  );
  return rows ? body : <PageSection title="New threads">{body}</PageSection>;
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
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">{label}</span>
      <ChoiceSelect label={label} className="w-full" {...picker} />
    </label>
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
    <Modal onClose={onClose} title="Thread defaults" description={workspace.name} size="sm" busy={pending}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value) void save(value);
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          {value ? <DialogFields value={value} onChange={setValue} environmentId={workspace.environmentId} /> : null}
          <p className="text-[12px] text-content/40">
            {scopeHint(workspace.id, scope ?? BUILT_IN_SCOPE)}
          </p>
          {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        </div>
        <div className="flex items-center gap-2 border-t border-content/10 px-4 py-3">
          {scope?.overridden ? (
            <button type="button" disabled={pending} onClick={() => void save(null)} className={GHOST}>
              Remove override
            </button>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={pending || !value} className={PRIMARY}>
            {pending ? <Spinner className="size-3.5" /> : null}
            Save
          </button>
        </div>
      </form>
    </Modal>
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
