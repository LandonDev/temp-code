import { useState } from "react";
import type { ThreadRules } from "@server/shared/rules";
import { AccessPicker } from "../../chrome/AccessPicker";
import { ModelPicker } from "../../chrome/ModelPicker";
import { ThreadTune, normalizeTune } from "../../chrome/ThreadTune";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { mergeModelSettings, nativeModelId, resolveModel } from "../../lib/models";
import type { HarnessId, RuntimeMode, Session } from "../../lib/session";
import { policyForMode } from "../../lib/tcserver/access";
import { implementPlan } from "../../lib/tcserver/plans";

type BuildType = "implementation" | "orchestration";

/** The pickers float in their own portals outside the dialog: a press
 *  inside one is not a press outside the dialog. */
const PICKERS = "[data-model-picker], [data-slot=select-content], [data-access-picker]";

/** A close the dialog should refuse: a press or a focus move that landed
 *  in one of the pickers. */
export function landedInPicker(reason: string, event: Event | undefined): boolean {
  if (reason !== "outside-press" && reason !== "focus-out") return false;
  const targets = [event?.target, (event as FocusEvent | undefined)?.relatedTarget];
  return targets.some((t) => t instanceof Element && !!t.closest(PICKERS));
}

export function defaultGoal(tasks: string[]): string {
  return tasks.length > 0
    ? "Every task in the plan's checklist is checked off and typecheck passes"
    : "The plan is fully implemented and typecheck passes";
}

/** Hands the approved plan to ONE builder through the server's own start
 *  (plan.implement): an implementation thread, or an orchestrator that
 *  splits it across subagents. A plan never starts more than one thread. */
export function StartBuildDialog({
  session,
  tasks,
  open,
  onOpenChange,
}: {
  session: Session;
  tasks: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [type, setType] = useState<BuildType>("implementation");
  // The build's setup defaults to the planning thread's.
  const [choice, setChoice] = useState<{ harness: HarnessId; model: string }>({
    harness: session.harness,
    model: session.model,
  });
  const [settings, setSettings] = useState<Record<string, string>>(session.modelSettings);
  const [mode, setMode] = useState<RuntimeMode>(session.runtimeMode);
  // Empty starts the thread with no goal.
  const [goal, setGoal] = useState(() => defaultGoal(tasks));
  const [tune, setTune] = useState<ThreadRules>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each opening starts from the plan as it stands now.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setGoal(defaultGoal(tasks));
      setError(null);
    }
  }

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const rules = normalizeTune(tune);
      await implementPlan(session.environmentId, session.id, {
        threadType: type,
        provider: choice.harness,
        model: nativeModelId(choice.model),
        reasoning: settings.effort,
        context1m: settings.context === "1m",
        permission: policyForMode(mode),
        goal: goal.trim() || undefined,
        ...(type === "orchestration" && rules ? { threadRules: rules } : {}),
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && busy) return;
        if (!next && landedInPicker(details.reason, details.event)) return;
        onOpenChange(next);
      }}
    >
      <ModalPanel
        title="Start the build"
        size="sm"
        busy={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void start();
          }
        }}
      >
        {/* The add sheet's vocabulary: what the build is for first, then
            each choice as a row, its label at the start and its control at
            the end (FieldRow). */}
        <ModalBody>
          <Field label="Goal">
            <Input value={goal} placeholder="No goal" onChange={(e) => setGoal(e.target.value)} />
          </Field>
          <div className="flex flex-col">
            <FieldRow label="Build">
              <ToggleGroup
                spacing={0}
                size="sm"
                value={[type]}
                onValueChange={(v) => {
                  const next = v[0] as BuildType | undefined;
                  if (next) setType(next);
                }}
              >
                <ToggleGroupItem value="implementation">Implement</ToggleGroupItem>
                <ToggleGroupItem value="orchestration">Orchestrate</ToggleGroupItem>
              </ToggleGroup>
            </FieldRow>
            <FieldRow label="Model">
              <span className="flex items-center" data-model-picker>
                <ModelPicker
                  harness={choice.harness}
                  model={choice.model}
                  environmentId={session.environmentId}
                  onChange={(h, m) => {
                    setChoice({ harness: h, model: m });
                    setSettings(mergeModelSettings(resolveModel(h, m, session.environmentId), settings));
                  }}
                  settings={{ values: settings, onChange: setSettings }}
                />
              </span>
            </FieldRow>
            <FieldRow label="Access">
              <span className="flex items-center">
                <AccessPicker value={mode} onChange={setMode} />
              </span>
            </FieldRow>
          </div>
          {type === "orchestration" ? (
            <ThreadTune
              tune={tune}
              onChange={setTune}
              environmentId={session.environmentId}
              workspaceId={session.workspaceId ?? null}
            />
          ) : null}
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter
          onCancel={() => onOpenChange(false)}
          confirmLabel="Start"
          busyLabel="Starting…"
          pending={busy}
          onConfirm={() => void start()}
        />
      </ModalPanel>
    </Dialog>
  );
}
