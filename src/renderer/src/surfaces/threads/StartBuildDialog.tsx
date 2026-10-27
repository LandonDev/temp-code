import { useState } from "react";
import type { ThreadRules } from "@server/shared/rules";
import { AccessPicker } from "../../chrome/AccessPicker";
import { ModelPicker } from "../../chrome/ModelPicker";
import { ModelSettings } from "../../chrome/ModelSettings";
import { ThreadTune, normalizeTune } from "../../chrome/ThreadTune";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { mergeModelSettings, nativeModelId, resolveModel } from "../../lib/models";
import type { HarnessId, RuntimeMode, Session } from "../../lib/session";
import { policyForMode } from "../../lib/tcserver/access";
import { implementPlan } from "../../lib/tcserver/plans";

type BuildType = "implementation" | "orchestration";

/** The pickers still float on the old chrome/Popover, portalled outside the
 *  dialog: a press inside one is not a press outside the dialog. */
const PICKERS = "[data-model-picker], [data-model-settings], [data-access-picker]";

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
      <DialogContent
        size="default"
        className="max-h-[calc(100vh-2rem)] overflow-y-auto"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void start();
          }
        }}
      >
        <DialogTitle>Start the build</DialogTitle>
        <ToggleGroup
          spacing={0}
          variant="outline"
          aria-label="Build"
          value={[type]}
          onValueChange={(v) => {
            const next = v[0] as BuildType | undefined;
            if (next) setType(next);
          }}
        >
          <ToggleGroupItem value="implementation">Implement</ToggleGroupItem>
          <ToggleGroupItem value="orchestration">Orchestrate</ToggleGroupItem>
        </ToggleGroup>
        <div className="-ml-1 flex flex-wrap items-center gap-1">
          <ModelPicker
            harness={choice.harness}
            model={choice.model}
            environmentId={session.environmentId}
            onChange={(h, m) => {
              setChoice({ harness: h, model: m });
              setSettings(mergeModelSettings(resolveModel(h, m, session.environmentId), settings));
            }}
          />
          <ModelSettings
            harness={choice.harness}
            model={choice.model}
            environmentId={session.environmentId}
            values={settings}
            onChange={setSettings}
          />
          <AccessPicker value={mode} onChange={setMode} />
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Goal</span>
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        {type === "orchestration" ? (
          <div className="-mx-4 -my-3">
            <ThreadTune
              tune={tune}
              onChange={setTune}
              environmentId={session.environmentId}
              workspaceId={session.workspaceId ?? null}
            />
          </div>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void start()}>
            {busy ? (
              <>
                <Spinner />
                Starting…
              </>
            ) : (
              "Start"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
