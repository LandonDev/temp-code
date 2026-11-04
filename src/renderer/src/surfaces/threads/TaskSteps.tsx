import { useState } from "react";
import type { Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { SelectSessionContext } from "../AgentMarkdown";
import { getEditOpen, setEditOpen } from "../editOpenState";
import { ActivityRow } from "../transcript/ActivityRow";
import { isThinkingBlock } from "../transcriptActivity";
import { TranscriptSessionContext } from "../transcriptSession";

/**
 * The running task's last steps on the implementation board: the
 * transcript's own action rows, under the thread's session (which also
 * names its host), so a row opens its file, its diff or its agent as it
 * does in the chat. They sit on the task card's surface with no box of
 * their own. A step that lands after the first render fades in and rises
 * 4px (`.step-land`); the ones already there at mount do not move, and
 * the one leaving the top goes without motion of its own. A thought is no
 * row here: the thread's working line says it.
 */
export function TaskSteps({
  sessionId,
  steps,
  cwd,
  onOpenFile,
  onOpenDiff,
  onSelectSession,
}: {
  sessionId: string;
  steps: readonly Block[];
  cwd?: string;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
  onSelectSession?: (sessionId: string) => void;
}) {
  const [atMount] = useState(() => new Set(steps.map((step) => step.id)));
  return (
    <SelectSessionContext.Provider value={onSelectSession}>
      <TranscriptSessionContext.Provider value={sessionId}>
        <div data-task-steps className="flex min-w-0 flex-col">
          {steps.filter((step) => !isThinkingBlock(step as Block)).map((step) => (
            <div key={step.id} className={atMount.has(step.id) ? "min-w-0" : "step-land min-w-0"}>
              <ActivityRow
                block={step}
                cwd={cwd}
                live
                expanded
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            </div>
          ))}
        </div>
      </TranscriptSessionContext.Provider>
    </SelectSessionContext.Provider>
  );
}

/** Whether a task's steps show: open unless the person closed them,
 *  remembered per task in the transcript's open store, so a tab switch
 *  keeps the choice. The key changes as the next task starts. */
export function useTaskStepsOpen(key: string): [boolean, (open: boolean) => void] {
  const [state, setState] = useState(() => ({ key, open: getEditOpen(key) ?? true }));
  let shown = state;
  if (state.key !== key) {
    shown = { key, open: getEditOpen(key) ?? true };
    setState(shown);
  }
  return [
    shown.open,
    (open) => {
      setEditOpen(key, open);
      setState({ key, open });
    },
  ];
}

/** The store key of a task's steps. */
export const taskStepsKey = (sessionId: string, round: number, index: number): string => `${sessionId}:task:${String(round)}:${String(index)}`;
