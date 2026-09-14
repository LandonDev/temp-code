import { useState } from "react";
import type { ConductOverride, ThreadRules } from "@server/shared/rules";
import { Modal } from "./Modal";
import { Row, Segmented, Select, Toggle } from "../surfaces/settingsBits";
import { useRulesScope, type OrchestrationRules } from "../lib/tcserver/rules";

/**
 * Per-thread rules on top of the workspace's orchestration settings.
 * A control at its base value holds no override; setting one back to the
 * base deletes the key, so an empty tune is `null` and the thread inherits.
 */

type Delegation = OrchestrationRules["conduct"]["delegation"];

const DELEGATION_OPTIONS: { value: Delegation; label: string }[] = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "free", label: "Free" },
];

const SWITCHES: { key: keyof ConductOverride & string; label: string }[] = [
  { key: "selfEdit", label: "Edit files itself" },
  { key: "selfShell", label: "Run shell itself" },
  { key: "verifyResults", label: "Verify agent reports" },
  { key: "escalate", label: "Escalate on weak output" },
  { key: "useWorktrees", label: "Worktree isolation" },
];

const CAPS: { key: "maxParallel" | "maxAgents"; label: string; steps: number[] }[] = [
  { key: "maxParallel", label: "Parallel agents", steps: [1, 2, 4, 8, 16, 0] },
  { key: "maxAgents", label: "Total per thread", steps: [10, 25, 50, 100, 0] },
];

export function isEmptyTune(tune: ThreadRules): boolean {
  return !tune.instructions?.trim() && Object.keys(tune.conduct ?? {}).length === 0;
}

/** `null` when nothing is overridden, so the server clears the thread's rules. */
export function normalizeTune(tune: ThreadRules): ThreadRules | null {
  if (isEmptyTune(tune)) return null;
  const out: ThreadRules = {};
  if (tune.instructions?.trim()) out.instructions = tune.instructions.trim();
  if (tune.conduct && Object.keys(tune.conduct).length > 0) out.conduct = tune.conduct;
  return out;
}

export function tuneSummary(tune: ThreadRules | null | undefined): string | null {
  if (!tune || isEmptyTune(tune)) return null;
  const parts: string[] = [];
  const c = tune.conduct ?? {};
  if (c.delegation) parts.push(`${c.delegation} delegation`);
  for (const s of SWITCHES) if (c[s.key] !== undefined) parts.push(`${s.label.toLowerCase()} ${c[s.key] ? "on" : "off"}`);
  for (const cap of CAPS)
    if (c[cap.key] !== undefined) parts.push(`${cap.label.toLowerCase()} ${c[cap.key] === 0 ? "unlimited" : c[cap.key]}`);
  if (tune.instructions?.trim()) parts.push("custom instructions");
  return parts.join(" · ");
}

/** Sets one conduct key, dropping it when it lands on the base value. */
export function setConduct<K extends keyof ConductOverride>(
  tune: ThreadRules,
  base: OrchestrationRules["conduct"],
  key: K,
  value: ConductOverride[K],
): ThreadRules {
  const conduct = { ...(tune.conduct ?? {}) };
  if (value === base[key]) delete conduct[key];
  else conduct[key] = value;
  const next: ThreadRules = { ...tune };
  if (Object.keys(conduct).length) next.conduct = conduct;
  else delete next.conduct;
  return next;
}

export function ThreadTune({
  tune,
  onChange,
  workspaceId,
}: {
  tune: ThreadRules;
  onChange: (tune: ThreadRules) => void;
  workspaceId: string | null;
}) {
  const { scope } = useRulesScope(workspaceId);
  const base = scope?.rules.conduct;
  const conduct = tune.conduct ?? {};
  const set = <K extends keyof ConductOverride>(key: K, value: ConductOverride[K]) =>
    base && onChange(setConduct(tune, base, key, value));
  const reset = (key: keyof ConductOverride) => {
    const next = { ...conduct };
    delete next[key];
    const out: ThreadRules = { ...tune };
    if (Object.keys(next).length) out.conduct = next;
    else delete out.conduct;
    onChange(out);
  };
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <textarea
        rows={3}
        value={tune.instructions ?? ""}
        placeholder="Custom instructions for this run…"
        onChange={(e) => onChange({ ...tune, instructions: e.target.value })}
        className="w-full resize-none rounded-md border border-content/10 bg-content/5 px-2.5 py-2 text-[13px] leading-relaxed text-content outline-none placeholder:text-content/40 hover:border-content/20 focus:border-accent/60"
      />
      {base ? (
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-content/40">
            Rules · defaults from Settings
          </div>
          <Row label={<Label text="Delegation" overridden={"delegation" in conduct} onReset={() => reset("delegation")} />}>
            <Segmented
              label="Delegation"
              value={conduct.delegation ?? base.delegation}
              options={DELEGATION_OPTIONS}
              onChange={(delegation) => set("delegation", delegation)}
            />
          </Row>
          {SWITCHES.map((s) => (
            <Row key={s.key} label={<Label text={s.label} overridden={s.key in conduct} onReset={() => reset(s.key)} />}>
              <Toggle
                label={s.label}
                on={(conduct[s.key] as boolean | undefined) ?? (base[s.key] as boolean)}
                onChange={(on) => set(s.key, on as never)}
              />
            </Row>
          ))}
          {CAPS.map((cap) => {
            const value = conduct[cap.key] ?? base[cap.key];
            const steps = cap.steps.includes(value) ? cap.steps : [...cap.steps, value].sort((a, b) => a - b);
            return (
              <Row key={cap.key} label={<Label text={cap.label} overridden={cap.key in conduct} onReset={() => reset(cap.key)} />}>
                <Select
                  label={cap.label}
                  value={String(value)}
                  onChange={(v) => set(cap.key, Number(v))}
                  options={steps.map((o) => ({ value: String(o), label: o === 0 ? "Unlimited" : String(o) }))}
                />
              </Row>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Label({ text, overridden, onReset }: { text: string; overridden: boolean; onReset: () => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      {text}
      {overridden ? (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] font-normal text-accent hover:underline"
        >
          Reset
        </button>
      ) : null}
    </span>
  );
}

/** Right-click → "Research options…" / "Orchestration options…". */
export function TuneDialog({
  title,
  initial,
  workspaceId,
  onCancel,
  onSave,
}: {
  title: string;
  initial: ThreadRules | null | undefined;
  workspaceId: string | null;
  onCancel: () => void;
  onSave: (tune: ThreadRules | null) => void;
}) {
  const [tune, setTune] = useState<ThreadRules>(initial ?? {});
  return (
    <Modal
      onClose={onCancel}
      title={title}
      description="Changes apply from the next message."
      size="md"
    >
      <ThreadTune tune={tune} onChange={setTune} workspaceId={workspaceId} />
      <div className="flex items-center justify-end gap-2 border-t border-content/10 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(normalizeTune(tune))}
          className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/70"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
