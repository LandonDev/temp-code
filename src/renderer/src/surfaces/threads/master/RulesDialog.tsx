import { useState } from "react";
import type { BatchStepKind, BatchStepSpec } from "@server/shared/contract-batch";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { ChevronDown, ChevronUp, X } from "../../../chrome/icons";
import { Modal } from "../../../chrome/Modal";
import { Input, Segmented, Select } from "../../settingsBits";
import { addStep, KIND_CHOICES, moveStep, removeStep, renameStep, shellDraftValid, stepLine, stepsValid, type ShellDraft } from "./rulesEdit";
import { stepsOf } from "./steps";
import { rulesSentence, type Rules } from "./useMasterModel";

/**
 * The batch's rules as a form: how branches land, the steps in order
 * (each with its name, its kind or command, and Up, Down and Remove), a
 * row to add a step (a built-in kind lands at once with its name; a shell
 * command asks for a name, the command and where it runs), what happens
 * then, and the summary line. The sentence under the fields reads the
 * list back as the foot will show it. Save is `batch.setRules`; the foot
 * takes the change from the `batch` push.
 */

const ICON_BUTTON =
  "pressable grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/5 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
const NO_KIND = "";

export function RulesDialog({
  rules: initial,
  onClose,
  onSave,
}: {
  rules: Rules;
  onClose: () => void;
  onSave: (rules: Rules) => Promise<void>;
}) {
  const [rules, setRules] = useState<Rules>(() => ({ ...initial, steps: stepsOf(initial) }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shell, setShell] = useState<ShellDraft | null>(null);
  const steps = stepsOf(rules);
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) => setRules({ ...rules, [key]: value });
  const setSteps = (next: BatchStepSpec[]) => set("steps", next);
  const merges = steps.some((s) => s.kind === "land");
  const valid = stepsValid(steps) && !pending;

  const pickKind = (kind: string) => {
    if (kind === NO_KIND) return;
    if (kind === "shell") setShell({ name: "", run: "", cwd: "" });
    else setSteps(addStep(steps, kind as BatchStepKind));
  };
  const addShell = () => {
    if (!shell || !shellDraftValid(shell)) return;
    setSteps(addStep(steps, "shell", shell));
    setShell(null);
  };

  const save = async () => {
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      await onSave({ ...rules, steps: steps.map((s) => ({ ...s, name: s.name.trim() })), summary: rules.summary?.trim() || undefined });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={pending} title="When the threads are done" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-3.5 px-4 pt-3 pb-4 text-[12px]">
          {merges ? (
            <Field label="Branches land">
              <Segmented
                label="Branches land"
                value={rules.land}
                options={[
                  { value: "as-they-finish", label: "As they finish" },
                  { value: "all-at-once", label: "All at once" },
                ]}
                onChange={(v) => set("land", v)}
              />
            </Field>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-content/50">Steps, in order</span>
            <ol className="flex flex-col" aria-label="Steps">
              {steps.map((step, i) => (
                <li key={step.id} className="flex h-9 items-center gap-2 border-t border-content/5 first:border-t-0" data-rule-step={step.id} data-rule-kind={step.kind}>
                  <span className="w-4 shrink-0 text-right tabular-nums text-content/30">{i + 1}</span>
                  <Input
                    aria-label={`Step ${i + 1} name`}
                    value={step.name}
                    onChange={(e) => setSteps(renameStep(steps, i, e.target.value))}
                    placeholder="Name"
                    className="h-7 w-40 py-0"
                  />
                  <span className={`min-w-0 flex-1 truncate ${step.kind === "shell" ? "font-mono text-[11px]" : ""} text-content/40`} data-rule-line>
                    {stepLine(step)}
                  </span>
                  <span className="flex shrink-0 items-center">
                    <button type="button" aria-label={`Move ${step.name || "step"} up`} disabled={i === 0} onClick={() => setSteps(moveStep(steps, i, -1))} className={ICON_BUTTON}>
                      <ChevronUp className="size-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${step.name || "step"} down`}
                      disabled={i === steps.length - 1}
                      onClick={() => setSteps(moveStep(steps, i, 1))}
                      className={ICON_BUTTON}
                    >
                      <ChevronDown className="size-3.5" strokeWidth={1.75} />
                    </button>
                    <button type="button" aria-label={`Remove ${step.name || "step"}`} onClick={() => setSteps(removeStep(steps, i))} className={ICON_BUTTON}>
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex items-center gap-2 border-t border-content/5 pt-2">
              <Select
                label="Add a step"
                value={shell ? "shell" : NO_KIND}
                options={[{ value: NO_KIND, label: "Add a step…" }, ...KIND_CHOICES]}
                onChange={pickKind}
                className="max-w-56"
              />
            </div>
            {shell ? (
              <div className="flex flex-col gap-2 rounded-lg border border-content/10 p-2.5" data-shell-draft>
                <div className="flex gap-2">
                  <Input aria-label="Step name" value={shell.name} onChange={(e) => setShell({ ...shell, name: e.target.value })} placeholder="Name, e.g. Smoke test" className="w-44" autoFocus />
                  <Input
                    aria-label="Working directory"
                    value={shell.cwd ?? ""}
                    onChange={(e) => setShell({ ...shell, cwd: e.target.value })}
                    placeholder="Directory, default the project"
                    className="min-w-0 flex-1 font-mono text-[11px]"
                  />
                </div>
                <Input
                  aria-label="Command"
                  value={shell.run}
                  onChange={(e) => setShell({ ...shell, run: e.target.value })}
                  placeholder="Command, exit 0 passes"
                  className="w-full font-mono text-[11px]"
                />
                <div className="flex justify-end gap-1">
                  <button type="button" onClick={() => setShell(null)} className="pressable h-6 rounded-md px-2 text-content/50 hover:bg-content/5 hover:text-content">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={addShell}
                    disabled={!shellDraftValid(shell)}
                    className="pressable h-6 rounded-md border border-content/10 px-2 text-content hover:bg-content/5 disabled:cursor-default disabled:opacity-40"
                  >
                    Add step
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <Field label="Then">
            <Segmented
              label="Then"
              value={rules.then}
              options={[
                { value: "notify", label: "Notify me" },
                { value: "archive-children", label: "Archive the threads" },
              ]}
              onChange={(v) => set("then", v)}
            />
          </Field>
          <label className="flex flex-col gap-1.5">
            <span className="text-content/50">Summary</span>
            <Input
              value={rules.summary ?? ""}
              onChange={(e) => set("summary", e.target.value)}
              placeholder="One line on what this batch is for"
              className="w-full"
            />
          </label>
          <p className="text-[11px] leading-4 text-content/40" data-rules-preview>
            {rulesSentence(rules)}
          </p>
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={!valid} />
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-content/50">{label}</span>
      {children}
    </div>
  );
}
