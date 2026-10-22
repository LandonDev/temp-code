import { useState } from "react";
import { DialogFooter, ErrorLine, errorText } from "../../../chrome/ConfirmDialog";
import { Modal } from "../../../chrome/Modal";
import { Input, Segmented } from "../../settingsBits";
import { rulesSentence, type Rules } from "./useMasterModel";

/**
 * The batch's rules as a form: how branches land, the gate, the release,
 * the Mac release, the deploy, what happens then, and the summary line. The sentence under
 * the fields reads back the choice as the foot will show it. Save is
 * `batch.setRules`; the foot takes the change from the `batch` push.
 */

export function RulesDialog({
  rules: initial,
  onClose,
  onSave,
}: {
  rules: Rules;
  onClose: () => void;
  onSave: (rules: Rules) => Promise<void>;
}) {
  const [rules, setRules] = useState<Rules>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) => setRules({ ...rules, [key]: value });

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await onSave({ ...rules, summary: rules.summary?.trim() || undefined });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={pending} title="When the threads are done" size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-3.5 px-4 pt-3 pb-4 text-[12px]">
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
          <p className="text-[11px] leading-4 text-content/40">{rulesSentence(rules)}</p>
          <ErrorLine error={error} />
        </div>
        <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} />
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
