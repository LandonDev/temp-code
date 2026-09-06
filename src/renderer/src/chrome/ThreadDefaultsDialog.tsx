import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { HARNESS_TITLE, HARNESSES, type HarnessId } from "../lib/session";
import { modelsFor, resolveModel } from "../lib/models";
import { RUNTIME_MODE_LABEL, RUNTIME_MODES, type RuntimeMode } from "../lib/session";
import { modeForPolicy, policyForMode } from "../lib/tcserver/access";
import { workspaceStore } from "../lib/tcserver/workspaces";
import type { ThreadDefaults, WorkspaceMeta } from "../lib/tcserver/types";

/**
 * What a NEW thread in this workspace starts with: provider, model,
 * reasoning effort and access policy. Stored server-side per workspace
 * (`defaults.set`), so every entry point — the empty composer, a plan
 * handoff, a model's app_start_thread — resolves the same answer.
 */

const INPUT =
  "w-full rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-none hover:border-content/20 focus:border-accent/60";
const LABEL = "text-[11px] font-medium text-content/50";
const GHOST = "rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";
const PRIMARY =
  "rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:cursor-not-allowed disabled:opacity-50";

const REASONING: ThreadDefaults["reasoning"][] = ["low", "medium", "high", "xhigh", "max", "ultra"];

const FALLBACK: ThreadDefaults = { provider: "claude", model: "", reasoning: "medium", permission: "edits" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

export function ThreadDefaultsDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  const stored = workspaceStore.defaultsAt(workspace.id);
  const inherited = workspaceStore.defaultsAt(null) ?? FALLBACK;
  const [value, setValue] = useState<ThreadDefaults>(stored ?? inherited);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stored !== undefined) return;
    void workspaceStore.loadDefaults(workspace.id).then((loaded) => {
      if (loaded) setValue(loaded);
    });
  }, [stored, workspace.id]);

  const harness = value.provider as HarnessId;
  const models = modelsFor(harness);
  const modelValue = value.model
    ? (resolveModel(harness, value.model).nativeId ?? value.model)
    : "";

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
    <Modal onClose={onClose} title="Thread defaults" description={workspace.name} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(value);
        }}
      >
        <div className="flex flex-col gap-3 px-4 py-4">
          <Field label="Provider">
            <select
              value={value.provider}
              onChange={(e) =>
                setValue({ ...value, provider: e.target.value as ThreadDefaults["provider"], model: "" })
              }
              className={INPUT}
            >
              {HARNESSES.map((id) => (
                <option key={id} value={id}>
                  {HARNESS_TITLE[id]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select
              value={modelValue}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
              className={INPUT}
            >
              <option value="">Provider default</option>
              {models.map((m) => (
                <option key={m.id} value={m.nativeId ?? m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reasoning">
            <select
              value={value.reasoning}
              onChange={(e) => setValue({ ...value, reasoning: e.target.value as ThreadDefaults["reasoning"] })}
              className={INPUT}
            >
              {REASONING.map((r) => (
                <option key={r} value={r}>
                  {r === "xhigh" ? "Extra high" : r[0].toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Access">
            <select
              value={modeForPolicy(value.permission)}
              onChange={(e) => setValue({ ...value, permission: policyForMode(e.target.value as RuntimeMode) })}
              className={INPUT}
            >
              {RUNTIME_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {RUNTIME_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
          </Field>
          {error ? <p className="text-[11px] leading-4 text-red-400/90">{error}</p> : null}
        </div>
        <div className="flex items-center gap-2 border-t border-content/10 px-4 py-3">
          {stored ? (
            <button type="button" disabled={pending} onClick={() => void save(null)} className={GHOST}>
              Use global
            </button>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={GHOST}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={PRIMARY}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
