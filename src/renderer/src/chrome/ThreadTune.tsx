import { useState } from "react";
import type { ConductOverride, ThreadRules } from "@server/shared/rules";
import { Modal } from "./Modal";
import { Button } from "../components/ui/button";
import { ChoiceSelect } from "../components/choice-select";
import { PageRow } from "../components/page";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
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
  { key: "maxParallel", label: "Parallel agents", steps: [1, 2, 4, 8, 16, 32, 64, 128, 0] },
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
  environmentId,
  tune,
  onChange,
  workspaceId,
}: {
  tune: ThreadRules;
  onChange: (tune: ThreadRules) => void;
  environmentId: string;
  workspaceId: string | null;
}) {
  const { scope } = useRulesScope(environmentId, workspaceId);
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
      <Textarea
        rows={3}
        aria-label="Custom instructions"
        value={tune.instructions ?? ""}
        placeholder="Custom instructions for this run…"
        onChange={(e) => onChange({ ...tune, instructions: e.target.value })}
        className="resize-none"
      />
      {base ? (
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Rules</p>
          <PageRow title={<Label text="Delegation" overridden={"delegation" in conduct} onReset={() => reset("delegation")} />}>
            <ChoiceSelect
              size="sm"
              label="Delegation"
              value={conduct.delegation ?? base.delegation}
              options={DELEGATION_OPTIONS}
              onChange={(delegation) => set("delegation", delegation)}
            />
          </PageRow>
          {SWITCHES.map((s) => (
            <PageRow key={s.key} title={<Label text={s.label} overridden={s.key in conduct} onReset={() => reset(s.key)} />}>
              <Switch
                aria-label={s.label}
                checked={(conduct[s.key] as boolean | undefined) ?? (base[s.key] as boolean)}
                onCheckedChange={(on) => set(s.key, on as never)}
              />
            </PageRow>
          ))}
          {CAPS.map((cap) => {
            const value = conduct[cap.key] ?? base[cap.key];
            const steps = cap.steps.includes(value) ? cap.steps : [...cap.steps, value].sort((a, b) => a - b);
            return (
              <PageRow key={cap.key} title={<Label text={cap.label} overridden={cap.key in conduct} onReset={() => reset(cap.key)} />}>
                <ChoiceSelect
                  size="sm"
                  label={cap.label}
                  value={String(value)}
                  onChange={(v) => set(cap.key, Number(v))}
                  options={steps.map((o) => ({ value: String(o), label: o === 0 ? "Unlimited" : String(o) }))}
                />
              </PageRow>
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
        <Button variant="link" size="xs" onClick={onReset} className="h-auto px-0 font-normal text-muted-foreground hover:text-foreground">
          Reset
        </Button>
      ) : null}
    </span>
  );
}

/** Right-click → "Research options…" / "Orchestration options…". */
export function TuneDialog({
  environmentId,
  title,
  thread,
  initial,
  workspaceId,
  onCancel,
  onSave,
}: {
  title: string;
  /** The thread's name, under the title. */
  thread: string;
  initial: ThreadRules | null | undefined;
  environmentId: string;
  workspaceId: string | null;
  onCancel: () => void;
  onSave: (tune: ThreadRules | null) => void;
}) {
  const [tune, setTune] = useState<ThreadRules>(initial ?? {});
  return (
    <Modal
      onClose={onCancel}
      title={title}
      description={thread}
      size="md"
    >
      <ThreadTune environmentId={environmentId} tune={tune} onChange={setTune} workspaceId={workspaceId} />
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSave(normalizeTune(tune))}>Save</Button>
      </div>
    </Modal>
  );
}
