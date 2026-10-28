import { registry } from "../lib/connection";
import { useEffect, useState } from "react";
import { ErrorLine } from "./ConfirmDialog";
import { FieldRow } from "./DialogField";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Dialog } from "../components/ui/dialog";
import { ModalPanel, useClosingDialog } from "./Modal";
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
      <PageRow title="Permission mode" description={PERMISSION_HINTS[value.permission]}>
        <ChoiceSelect label="Permission mode" {...rows.permission} />
      </PageRow>
    </>
  );
}

/** A workspace's page says whose set it shows; the global page's description already does. */
function scopeHint(workspaceId: string | null, scope: DefaultsScope): string | undefined {
  if (workspaceId === null) return undefined;
  return scope.overridden
    ? "Overrides the global defaults."
    : "Follows the global defaults.";
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
  const { root, closeThen } = useClosingDialog(onClose, pending);
  useEffect(() => {
    if (scope) setValue((current) => current ?? scope.defaults);
  }, [scope]);

  const save = async (next: ThreadDefaults | null) => {
    setPending(true);
    setError(null);
    try {
      await workspaceStore.saveDefaults(workspace.environmentId, workspace.id, next);
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} title="Thread defaults" description={workspace.name} size="sm" busy={pending}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value) void save(value);
          }}
        >
          <div className="flex flex-col gap-4 px-5 py-4">
            {value ? (
              <DialogFields value={value} onChange={setValue} environmentId={workspace.environmentId} hint={scopeHint(workspace.id, scope ?? BUILT_IN_SCOPE)} />
            ) : (
              <PageRowsSkeleton rows={4} />
            )}
            <ErrorLine error={error} />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {scope?.overridden ? (
              <Button variant="ghost" disabled={pending} onClick={() => void save(null)} className="me-auto">
                Remove override
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => closeThen(onClose)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !value}>
              {pending ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </form>
      </ModalPanel>
    </Dialog>
  );
}

/** The dialog's rows: the label at the start, the picker at the end; the scope hint under the last. */
function DialogFields({ value, onChange, environmentId, hint }: { value: ThreadDefaults; onChange: Change; environmentId?: string; hint?: string }) {
  const rows = useDefaultsRows(value, onChange, environmentId);
  return (
    <div className="flex flex-col">
      <FieldRow label="Provider">
        <ChoiceSelect label="Provider" size="sm" {...rows.provider} />
      </FieldRow>
      <FieldRow label="Model">
        <ChoiceSelect label="Model" size="sm" {...rows.model} />
      </FieldRow>
      {rows.ladder.length > 1 ? (
        <FieldRow label="Reasoning">
          <ChoiceSelect label="Reasoning" size="sm" {...rows.reasoning} />
        </FieldRow>
      ) : null}
      <FieldRow label="Permission mode" description={hint}>
        <ChoiceSelect label="Permission mode" size="sm" {...rows.permission} />
      </FieldRow>
    </div>
  );
}
