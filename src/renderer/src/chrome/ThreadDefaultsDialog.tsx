import { registry } from "../lib/connection";
import { useEffect, useState } from "react";
import { DialogFooter, ErrorLine } from "./ConfirmDialog";
import { homeNote } from "../lib/settingsHome";
import { FieldRow } from "./DialogField";
import { ChoiceSelect } from "../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { Facts } from "../surfaces/settings/hosts/Facts";
import { BusyLabel, Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { ModalPanel, useClosingDialog } from "./Modal";
import {
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
import { scopeKey, useThreadDefaults, useThreadDefaultsError, useWorkspaceCatalog, workspaceStore } from "../lib/tcserver/workspaces";
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
export function ThreadDefaultsFields({
  value,
  onChange,
  environmentId,
  disabled,
}: {
  value: ThreadDefaults;
  onChange: Change;
  environmentId?: string;
  disabled?: boolean;
}) {
  const rows = useDefaultsRows(value, onChange, environmentId);
  return (
    <>
      <PageRow title="Provider">
        <ChoiceSelect label="Provider" disabled={disabled} {...rows.provider} />
      </PageRow>
      <PageRow title="Model">
        <ChoiceSelect label="Model" disabled={disabled} {...rows.model} />
      </PageRow>
      {rows.ladder.length > 1 ? (
        <PageRow title="Reasoning">
          <ChoiceSelect label="Reasoning" disabled={disabled} {...rows.reasoning} />
        </PageRow>
      ) : null}
      <PageRow title="Permission mode" description={PERMISSION_HINTS[value.permission]}>
        <ChoiceSelect label="Permission mode" disabled={disabled} {...rows.permission} />
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

/** The four rows ThreadDefaultsFields draws, in their shape. */
const DEFAULTS_SKELETON = [{}, {}, {}, { description: true }];

/** Self-loading group for one scope; every change saves at once. */
export function ThreadDefaultsEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaceCatalog().workspaces.find((w) => w.id === workspaceId);
  // Global app settings belong to this machine.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <PageRowsSkeleton rows={DEFAULTS_SKELETON} />;
  return <DefaultsEditor key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

function DefaultsEditor({ environmentId, workspaceId }: { environmentId: string; workspaceId: string | null }) {
  const scope = useThreadDefaults(environmentId, workspaceId);
  const failure = useThreadDefaultsError(environmentId, workspaceId);
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
  // The set lives on the box with the orchestration rules (remote/rulesSync.ts).
  const { note, blocked } = homeNote(scope?.home);
  // Only the host's answer says where the values come from: while the scope
  // loads, or after its read failed, there is no line.
  const hint = scope ? scopeHint(workspaceId, scope) : undefined;
  return (
    <PageSection
      // The global page's own title says what this is; a workspace page names it.
      title={workspaceId === null ? undefined : "New threads"}
      description={
        hint && note ? (
          <>
            {hint}
            <span className="mt-1 block">{note}</span>
          </>
        ) : (
          (hint ?? note)
        )
      }
      action={
        resettable ? (
          <Button variant="ghost" size="sm" onClick={() => save(null)} disabled={blocked}>
            {workspaceId === null ? "Reset" : "Remove override"}
          </Button>
        ) : !scope && failure ? (
          <Button variant="ghost" size="sm" onClick={failure.retry}>
            Retry
          </Button>
        ) : null
      }
    >
      {scope ? (
        <ThreadDefaultsFields value={scope.defaults} onChange={save} environmentId={environmentId} disabled={blocked} />
      ) : failure ? (
        <PageError>{failure.error}</PageError>
      ) : (
        <PageRowsSkeleton rows={DEFAULTS_SKELETON} />
      )}
      {workspaceId === null ? <OverridingWorkspaces environmentId={environmentId} /> : null}
      {error ? <PageError>{error}</PageError> : null}
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
    <p className="flex flex-wrap items-center gap-x-1 py-3 text-xs text-muted-foreground" data-testid="defaults-overrides">
      Overridden in
      <Facts
        parts={overriding.map((w) => (
          <Button key={w.id} variant="link" size="xs" className="h-auto px-0 text-xs after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']" onClick={() => openWorkspaceSettings(w.id)}>
            {w.name}
          </Button>
        ))}
      />
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
  // Which verb runs: Save, or Remove override; the one clicked spins.
  const [running, setRunning] = useState<"save" | "remove" | null>(null);
  const pending = running !== null;
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  useEffect(() => {
    if (scope) setValue((current) => current ?? scope.defaults);
  }, [scope]);

  const save = async (next: ThreadDefaults | null) => {
    setRunning(next ? "save" : "remove");
    setError(null);
    try {
      await workspaceStore.saveDefaults(workspace.environmentId, workspace.id, next);
      // The verb keeps spinning through the exit.
      closeThen(onClose);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(null);
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
              <DialogFields value={value} onChange={setValue} environmentId={workspace.environmentId} hint={scope ? scopeHint(workspace.id, scope) : undefined} />
            ) : (
              <PageRowsSkeleton rows={4} />
            )}
            <ErrorLine error={error} />
          </div>
          <DialogFooter
            start={
              scope?.overridden ? (
                <Button variant="ghost" disabled={pending} onClick={() => void save(null)}>
                  <BusyLabel busy={running === "remove"} label="Remove override" />
                </Button>
              ) : null
            }
            onCancel={() => closeThen(onClose)}
            confirmLabel="Save"
            pending={running === "save"}
            busy={running === "remove"}
            disabled={!value}
          />
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
