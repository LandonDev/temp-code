import { useState } from "react";
import type { BatchStepKind, BatchStepSpec } from "@server/shared/contract-batch";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../chrome/DialogField";
import { Tip } from "../../../components/tip";
import { ChevronDown, ChevronUp, X } from "../../../chrome/icons";
import { Modal, useModalClose } from "../../../chrome/Modal";
import { ChoiceSelect } from "../../../components/choice-select";
import { ChoiceToggle } from "../../../components/choice-toggle";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Item, ItemActions, ItemContent } from "../../../components/ui/item";
import { cn } from "../../../lib/cn";
import { addableKinds, addStep, moveStep, removeStep, renameStep, shellDraftValid, stepLine, stepsValid, type ShellDraft } from "./rulesEdit";
import { stepsOf } from "./steps";
import { rulesSentence, type Rules } from "./useMasterModel";

/**
 * The batch's rules as a form: how branches land, the steps in order
 * (each with its name, its kind or command, and Up, Down and Remove), a
 * picker to add a step (a built-in kind lands at once with its name; a
 * shell command asks for a name, the command and where it runs), what
 * happens then, and the summary line. The sentence under the fields reads
 * the list back as the foot will show it. Save is `batch.setRules`; the
 * foot takes the change from the `batch` push.
 */

const NO_KIND = "";

type RulesProps = {
  rules: Rules;
  onClose: () => void;
  onSave: (rules: Rules) => Promise<void>;
};

export function RulesDialog(props: RulesProps) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title="When the threads are done" size="md">
      <RulesForm {...props} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function RulesForm({
  rules: initial,
  onClose,
  onSave,
  pending,
  setPending,
}: RulesProps & { pending: boolean; setPending: (pending: boolean) => void }) {
  const [rules, setRules] = useState<Rules>(() => ({ ...initial, steps: stepsOf(initial) }));
  const [error, setError] = useState<string | null>(null);
  const [shell, setShell] = useState<ShellDraft | null>(null);
  const close = useModalClose();
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
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        {merges ? (
          <FieldRow label="Branches land" className="-my-2">
            <ChoiceToggle
              label="Branches land"
              value={rules.land}
              options={[
                { value: "as-they-finish", label: "As they finish" },
                { value: "all-at-once", label: "All at once" },
              ]}
              onChange={(v) => set("land", v)}
            />
          </FieldRow>
        ) : null}

        <section aria-labelledby="rules-steps" className="flex flex-col gap-1">
          <h3 id="rules-steps" className="text-xs font-medium text-muted-foreground">
            Steps, in order
          </h3>
          <ol className="flex flex-col" aria-label="Steps">
            {steps.map((step, i) => {
              const name = step.name || "step";
              return (
                <Item key={step.id} size="xs" render={<li />} className="flex-nowrap px-0" data-rule-step={step.id} data-rule-kind={step.kind}>
                  <span className="w-4 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                  <Input
                    aria-label={`Step ${i + 1} name`}
                    value={step.name}
                    onChange={(e) => setSteps(renameStep(steps, i, e.target.value))}
                    placeholder="Name"
                    className="h-7 w-40 shrink-0"
                  />
                  <ItemContent className="min-w-0">
                    <span className={cn("truncate text-xs text-muted-foreground", step.kind === "shell" && "font-mono text-[11px]")} data-rule-line>
                      {stepLine(step)}
                    </span>
                  </ItemContent>
                  <ItemActions className="gap-0">
                    <Tip label="Move up">
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => setSteps(moveStep(steps, i, -1))}>
                        <ChevronUp />
                      </Button>
                    </Tip>
                    <Tip label="Move down">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${name} down`}
                        disabled={i === steps.length - 1}
                        onClick={() => setSteps(moveStep(steps, i, 1))}
                      >
                        <ChevronDown />
                      </Button>
                    </Tip>
                    <Tip label="Remove">
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${name}`} onClick={() => setSteps(removeStep(steps, i))}>
                        <X />
                      </Button>
                    </Tip>
                  </ItemActions>
                </Item>
              );
            })}
          </ol>
          {shell ? (
            <div className="mt-1 flex flex-col gap-2" data-shell-draft>
              <div className="flex gap-2">
                <Input aria-label="Step name" value={shell.name} onChange={(e) => setShell({ ...shell, name: e.target.value })} placeholder="Name, e.g. Smoke test" className="w-44 shrink-0" autoFocus />
                <Input
                  aria-label="Working directory"
                  value={shell.cwd ?? ""}
                  onChange={(e) => setShell({ ...shell, cwd: e.target.value })}
                  placeholder="Directory, default the project"
                  className="font-mono text-xs"
                />
              </div>
              <Input
                aria-label="Command"
                value={shell.run}
                onChange={(e) => setShell({ ...shell, run: e.target.value })}
                placeholder="Command, exit 0 passes"
                className="font-mono text-xs"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setShell(null)}>
                  Cancel
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={addShell} disabled={!shellDraftValid(shell)}>
                  Add step
                </Button>
              </div>
            </div>
          ) : (
            <ChoiceSelect
              label="Add a step"
              size="sm"
              value={NO_KIND}
              options={[{ value: NO_KIND, label: "Add a step…" }, ...addableKinds(steps)]}
              onChange={pickKind}
              className="mt-1 min-w-40 self-start"
            />
          )}
        </section>

        <FieldRow label="Then" className="-my-2">
          <ChoiceToggle
            label="Then"
            value={rules.then}
            options={[
              { value: "notify", label: "Notify me" },
              { value: "archive-children", label: "Archive the threads" },
            ]}
            onChange={(v) => set("then", v)}
          />
        </FieldRow>
        <Field label="Summary">
          <Input value={rules.summary ?? ""} onChange={(e) => set("summary", e.target.value)} placeholder="One line on what this batch is for" />
        </Field>
        <p className="text-xs text-muted-foreground" data-rules-preview>
          {rulesSentence(rules)}
        </p>
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={!valid} />
    </form>
  );
}
