import { useEffect, useState } from "react";
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
import { useThreadDefaults, useWorkspaceCatalog, workspaceStore } from "../lib/tcserver/workspaces";
import { openWorkspaceSettings } from "../lib/settings";
import type { ThreadDefaults, WorkspaceMeta } from "../lib/tcserver/types";
import { Heading, Row, SecondaryButton, Select } from "../surfaces/settingsBits";

/**
 * What a NEW thread starts with: provider, model, reasoning effort and access
 * policy. Stored server-side globally and per workspace (`defaults.set`), so
 * every entry point — the empty composer, a plan handoff, a model's
 * app_start_thread — resolves the same answer. A workspace without an
 * override of its own follows the global set.
 */

const INPUT =
  "w-full rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-none hover:border-content/20 focus:border-accent/60";
const LABEL = "text-[11px] font-medium text-content/50";
const GHOST = "rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";
const PRIMARY =
  "rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:cursor-not-allowed disabled:opacity-50";

const PERMISSIONS: ThreadDefaults["permission"][] = ["safe", "edits", "auto"];

type Change = (next: ThreadDefaults) => void;

function useDefaultsRows(value: ThreadDefaults, onChange: Change) {
  const model = modelForDefaults(value);
  const ladder = effortLadder(model);
  const set = (patch: Partial<ThreadDefaults>) => onChange(normalizeDefaults({ ...value, ...patch }));
  return {
    ladder,
    provider: {
      value: value.provider,
      options: providerOptions(),
      onChange: (provider: string) => set({ provider: provider as ThreadDefaults["provider"], model: "" }),
    },
    model: {
      value: storedModelId(value),
      options: [{ value: "", label: "Provider default" }, ...modelOptions(value.provider)],
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
export function ThreadDefaultsFields({ value, onChange }: { value: ThreadDefaults; onChange: Change }) {
  const rows = useDefaultsRows(value, onChange);
  return (
    <>
      <Row label="Model" description="The provider and model a thread opens on.">
        <Select label="Provider" {...rows.provider} />
        <Select label="Model" {...rows.model} />
      </Row>
      {rows.ladder.length > 1 ? (
        <Row label="Reasoning" description="Effort level, from this model's ladder.">
          <Select label="Reasoning" {...rows.reasoning} />
        </Row>
      ) : null}
      <Row label="Security" description={PERMISSION_HINTS[value.permission]}>
        <Select label="Security" {...rows.permission} />
      </Row>
    </>
  );
}

function scopeHint(workspaceId: string | null, scope: DefaultsScope): string {
  if (workspaceId === null) return "Applied wherever a workspace has no override of its own.";
  return scope.overridden
    ? "This workspace overrides the global defaults."
    : "Using the global defaults; any change creates a workspace override.";
}

/** Self-loading group for one scope; every change saves at once. */
export function ThreadDefaultsEditor({
  workspaceId,
  first = false,
}: {
  workspaceId: string | null;
  first?: boolean;
}) {
  const scope = useThreadDefaults(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ThreadDefaults | null) => {
    setError(null);
    workspaceStore
      .saveDefaults(workspaceId, next)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  const resettable = scope ? (workspaceId === null ? true : scope.overridden) : false;
  return (
    <section>
      <div className="flex items-end justify-between gap-4">
        <Heading title="New threads" first={first} />
        {resettable ? (
          <span className="pb-1">
            <SecondaryButton onClick={() => save(null)}>
              {workspaceId === null ? "Reset" : "Remove override"}
            </SecondaryButton>
          </span>
        ) : null}
      </div>
      <p className="pb-2 text-[12px] leading-relaxed text-content/45">
        {scopeHint(workspaceId, scope ?? BUILT_IN_SCOPE)}
      </p>
      {workspaceId === null ? <OverridingWorkspaces /> : null}
      {scope ? <ThreadDefaultsFields value={scope.defaults} onChange={save} /> : null}
      {error ? <p className="pt-2 text-[11px] text-red-400/90">{error}</p> : null}
    </section>
  );
}

/** Under the global editor: which workspaces keep their own set. Each name
 *  opens that workspace's page, where the override lives. */
function OverridingWorkspaces() {
  const { workspaces, defaults } = useWorkspaceCatalog();
  const overriding = workspaces.filter((w) => defaults.get(w.id)?.overridden);
  if (overriding.length === 0) return null;
  return (
    <p className="pb-2 text-[12px] leading-relaxed text-content/45" data-testid="defaults-overrides">
      Overridden in{" "}
      {overriding.map((w, i) => (
        <span key={w.id}>
          {i > 0 ? ", " : null}
          <button
            type="button"
            className="text-content/70 underline decoration-content/20 underline-offset-2 hover:text-content"
            onClick={() => openWorkspaceSettings(w.id)}
          >
            {w.name}
          </button>
        </span>
      ))}
      .
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function Picker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
  const scope = useThreadDefaults(workspace.id);
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
      await workspaceStore.saveDefaults(workspace.id, next);
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
        <div className="flex flex-col gap-3 px-4 py-4">
          {value ? <DialogFields value={value} onChange={setValue} /> : null}
          <p className="text-[11px] leading-4 text-content/45">
            {scopeHint(workspace.id, scope ?? BUILT_IN_SCOPE)}
          </p>
          {error ? <p className="text-[11px] leading-4 text-red-400/90">{error}</p> : null}
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
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DialogFields({ value, onChange }: { value: ThreadDefaults; onChange: Change }) {
  const rows = useDefaultsRows(value, onChange);
  return (
    <>
      <Field label="Provider">
        <Picker {...rows.provider} />
      </Field>
      <Field label="Model">
        <Picker {...rows.model} />
      </Field>
      {rows.ladder.length > 1 ? (
        <Field label="Reasoning">
          <Picker {...rows.reasoning} />
        </Field>
      ) : null}
      <Field label="Security">
        <Picker {...rows.permission} />
      </Field>
    </>
  );
}
